import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

const SHA256_HANDLE_PREFIX = /^sha256:/i
const CANONICAL_SHA256_ID = /^sha256:[0-9a-f]{64}$/i
const PROJECTED_SHA256_HANDLE = /^sha256:[0-9a-f]{8,63}$/i

const TOOL_FIELDS = Object.freeze({
  vision_describe: { arrays: ['attachmentIds', 'paths'] },
  vision_bootstrap: { arrays: ['attachmentIds', 'paths'] },
  vision_materialize: { scalars: ['image'] },
  vision_ground: { scalars: ['image'] },
  vision_detect: { scalars: ['image'] },
  vision_crop: { scalars: ['image'] },
  vision_present: { scalars: ['image'] },
  vision_pixel_diff: { scalars: ['original', 'rebuilt'] },
  vision_colors: { scalars: ['image'] },
  vision_ocr: { scalars: ['image'] },
  vision_trace: { scalars: ['image'] },
  vision_extract_foreground: { scalars: ['image'] },
} as const)

export interface LegacyImageAttachmentRef {
  readonly attachmentId?: unknown
  readonly id?: unknown
}

export type CompatibleImageAttachmentRef = ImageAttachmentRef | LegacyImageAttachmentRef

interface SessionLike {
  deriveMessages?: () => unknown
}

interface AgentLike {
  readonly session?: SessionLike
  readonly inbox?: {
    readonly nextTurn?: unknown
    readonly nextStep?: unknown
  }
}

export interface SessionVisionAttachmentIndex {
  recordAttachments?(session: unknown, refs: readonly CompatibleImageAttachmentRef[]): void
  lookupAttachment(session: unknown, id: string): CompatibleImageAttachmentRef | undefined
}

export interface ProjectedAttachmentContext {
  readonly sessionVisionIndex?: SessionVisionAttachmentIndex
  readonly agent?: AgentLike
}

export type ProjectedAttachmentResolution =
  | { readonly kind: 'not-projected'; readonly value: unknown }
  | { readonly kind: 'unknown'; readonly handle: string }
  | { readonly kind: 'ambiguous'; readonly handle: string }
  | {
    readonly kind: 'resolved'
    readonly handle: string
    readonly canonicalId: string
    readonly ref: CompatibleImageAttachmentRef
  }

interface CanonicalizeContext extends ProjectedAttachmentContext {
  readonly toolName: string
}

interface ToolFieldSpec {
  readonly scalars?: readonly string[]
  readonly arrays?: readonly string[]
}

interface VisionToolExecutionLike {
  readonly agent?: AgentLike
}

interface VisionToolDefinitionLike {
  readonly name?: string
  readonly execute?: (args: unknown, exec?: VisionToolExecutionLike) => unknown
  readonly [key: string]: unknown
}

interface WrapVisionAttachmentOptions {
  readonly sessionVisionIndex?: SessionVisionAttachmentIndex
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function attachmentIdOf(ref: unknown): string | undefined {
  const value = objectRecord(ref)
  if (value === undefined) return undefined
  const raw = value.attachmentId ?? value.id
  if (raw === undefined || raw === null) return undefined
  const id = String(raw).trim()
  return id === '' ? undefined : id
}

function sessionMessages(session: SessionLike | undefined): unknown[] {
  try {
    if (!session || typeof session.deriveMessages !== 'function') return []
    const messages = session.deriveMessages()
    return Array.isArray(messages) ? messages : []
  } catch {
    return []
  }
}

function collectImageRefsFromBlocks(blocks: unknown, out: CompatibleImageAttachmentRef[]): void {
  if (!Array.isArray(blocks)) return
  for (const block of blocks) {
    const value = objectRecord(block)
    if (value === undefined) continue
    if (value.type === 'image') {
      const attachment = objectRecord(value.attachment)
      if (attachment !== undefined) out.push(attachment as LegacyImageAttachmentRef)
    }
    if (Array.isArray(value.content)) collectImageRefsFromBlocks(value.content, out)
  }
}

function collectImageRefsFromMessages(messages: unknown, out: CompatibleImageAttachmentRef[]): void {
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    collectImageRefsFromBlocks(objectRecord(message)?.content, out)
  }
}

function authorizedRefs(agent: AgentLike | undefined): CompatibleImageAttachmentRef[] {
  const refs: CompatibleImageAttachmentRef[] = []
  collectImageRefsFromMessages(sessionMessages(agent?.session), refs)
  collectImageRefsFromMessages(agent?.inbox?.nextTurn, refs)
  collectImageRefsFromMessages(agent?.inbox?.nextStep, refs)

  const unique = new Map<string, CompatibleImageAttachmentRef>()
  for (const ref of refs) {
    const id = attachmentIdOf(ref)
    if (id !== undefined && !unique.has(id)) unique.set(id, ref)
  }
  return [...unique.values()]
}

export function isProjectedAttachmentHandle(value: unknown): boolean {
  return typeof value === 'string' && PROJECTED_SHA256_HANDLE.test(value.trim())
}

function isSha256HandleLike(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HANDLE_PREFIX.test(value.trim())
}

function isCanonicalSha256Id(value: string): boolean {
  return CANONICAL_SHA256_ID.test(value.trim())
}

/**
 * Resolve DSH's model-facing text-only image alias back to one canonical
 * attachment ref without changing durable attachment identity semantics.
 *
 * DSH currently projects `sha256:<full digest>` to a short `sha256:<prefix>`
 * for text-only requests. The alias is not globally addressable: it is valid
 * only when exactly one image authorized by the current Session has that
 * prefix. Zero or multiple matches fail closed.
 */
export function resolveProjectedAttachmentHandle(
  handle: unknown,
  { sessionVisionIndex, agent }: ProjectedAttachmentContext = {},
): ProjectedAttachmentResolution {
  const token = typeof handle === 'string' ? handle.trim() : ''
  if (!isProjectedAttachmentHandle(token)) return { kind: 'not-projected', value: handle }

  const session = agent?.session
  const refs = authorizedRefs(agent)
  const wanted = token.toLowerCase()
  const matches = refs.filter((ref) => {
    const id = attachmentIdOf(ref)
    return id !== undefined && id.toLowerCase().startsWith(wanted)
  })

  if (matches.length === 0) return { kind: 'unknown', handle: token }
  if (matches.length > 1) return { kind: 'ambiguous', handle: token }

  const candidate = matches[0]
  const canonicalId = attachmentIdOf(candidate)
  if (candidate === undefined || canonicalId === undefined) return { kind: 'unknown', handle: token }

  // The Session event/inbox proves authorization; warm the canonical bounded
  // index with that exact Host-owned ref, then require the index to hand it
  // back. This keeps all downstream tools on the same recovery/identity seam.
  try {
    sessionVisionIndex?.recordAttachments?.(session, [candidate])
  } catch {
    // Authorization is still fail-closed if the bounded cache cannot be warmed.
  }
  if (!sessionVisionIndex || typeof sessionVisionIndex.lookupAttachment !== 'function') {
    return { kind: 'unknown', handle: token }
  }
  const ref = sessionVisionIndex.lookupAttachment(session, canonicalId)
  if (ref === undefined) return { kind: 'unknown', handle: token }
  return { kind: 'resolved', handle: token, canonicalId, ref }
}

function canonicalizeValue(value: unknown, context: CanonicalizeContext): unknown {
  if (!isSha256HandleLike(value)) return value
  if (isCanonicalSha256Id(value)) return value
  if (!isProjectedAttachmentHandle(value)) {
    throw new Error(
      `${context.toolName}: invalid attachment handle "${value.trim()}" ` +
        '(sha256 attachment handles must be a canonical id or a DSH-projected 8+ hex prefix)',
    )
  }
  const result = resolveProjectedAttachmentHandle(value, context)
  if (result.kind === 'resolved') return result.canonicalId
  if (result.kind === 'ambiguous') {
    throw new Error(
      `${context.toolName}: ambiguous attachment handle "${result.handle}" ` +
        '(multiple images in this conversation share that prefix; use a full attachment id or attach the image again)',
    )
  }
  if (result.kind === 'unknown') {
    throw new Error(
      `${context.toolName}: unknown attachment handle "${result.handle}" ` +
        '(it is not authorized by an image in this conversation; attach the image again if needed)',
    )
  }
  return value
}

function canonicalizeArgs(
  args: unknown,
  context: CanonicalizeContext,
  fields: ToolFieldSpec,
): unknown {
  const record = objectRecord(args)
  if (record === undefined) return args
  let next: Record<string, unknown> | undefined
  for (const field of fields.scalars ?? []) {
    if (!Object.hasOwn(record, field)) continue
    const value = canonicalizeValue(record[field], context)
    if (value !== record[field]) {
      next ??= { ...record }
      next[field] = value
    }
  }
  for (const field of fields.arrays ?? []) {
    const values = record[field]
    if (!Array.isArray(values)) continue
    let changed = false
    const mapped = values.map((value) => {
      const canonical = canonicalizeValue(value, context)
      if (canonical !== value) changed = true
      return canonical
    })
    if (changed) {
      next ??= { ...record }
      next[field] = mapped
    }
  }
  return next ?? args
}

/**
 * Canonicalize only image-source arguments of Vision Router tools. Ordinary
 * prose fields are never scanned, so a user mentioning `sha256:deadbeef` in a
 * question cannot be rewritten accidentally. Local paths remain untouched.
 * Any sha256-shaped source is reserved for attachment identity and therefore
 * fails closed rather than falling through to cwd-relative filesystem lookup.
 */
export function wrapVisionAttachmentHandleDefinition<T extends VisionToolDefinitionLike>(
  def: T,
  options: WrapVisionAttachmentOptions = {},
): T {
  // Tool definitions arrive from the Host registry at runtime. Static generic
  // constraints cannot replace this boundary guard: partial/legacy Hosts may
  // still pass nullish or malformed values before their own validation runs.
  if (def === null || typeof def !== 'object' || typeof def.execute !== 'function') return def
  const toolName = def.name
  const fields = typeof toolName === 'string'
    ? TOOL_FIELDS[toolName as keyof typeof TOOL_FIELDS] as ToolFieldSpec | undefined
    : undefined
  const sessionVisionIndex = options.sessionVisionIndex
  if (!fields || !sessionVisionIndex || typeof toolName !== 'string') return def
  const execute = def.execute
  return {
    ...def,
    execute(args: unknown, exec?: VisionToolExecutionLike) {
      const nextArgs = canonicalizeArgs(args, {
        sessionVisionIndex,
        ...(exec?.agent === undefined ? {} : { agent: exec.agent }),
        toolName,
      }, fields)
      return execute.call(def, nextArgs, exec)
    },
  } as T
}
