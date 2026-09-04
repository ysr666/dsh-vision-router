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
})

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function attachmentIdOf(ref) {
  if (!ref || typeof ref !== 'object') return undefined
  const value = ref.attachmentId ?? ref.id
  if (value === undefined || value === null) return undefined
  const id = String(value).trim()
  return id === '' ? undefined : id
}

function sessionEvents(session) {
  try {
    if (session && typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      return Array.isArray(events) ? events : []
    }
    return Array.isArray(session?.events) ? session.events : []
  } catch {
    return []
  }
}

function collectImageRefsFromBlocks(blocks, out) {
  if (!Array.isArray(blocks)) return
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'image' && block.attachment) out.push(block.attachment)
    if (Array.isArray(block.content)) collectImageRefsFromBlocks(block.content, out)
  }
}

function collectImageRefsFromMessages(messages, out) {
  if (!Array.isArray(messages)) return
  for (const message of messages) collectImageRefsFromBlocks(message?.content, out)
}

function authorizedRefs(core, agent) {
  const refs = []
  const session = agent?.session
  const events = sessionEvents(session)
  if (typeof core?.collectEventAttachmentRefs === 'function') {
    try {
      const durable = core.collectEventAttachmentRefs(events)
      if (Array.isArray(durable)) refs.push(...durable)
    } catch {
      // The resolver remains fail-closed; pending refs below may still suffice.
    }
  }
  collectImageRefsFromMessages(agent?.inbox?.nextTurn, refs)
  collectImageRefsFromMessages(agent?.inbox?.nextStep, refs)

  const unique = new Map()
  for (const ref of refs) {
    const id = attachmentIdOf(ref)
    if (id !== undefined && !unique.has(id)) unique.set(id, ref)
  }
  return [...unique.values()]
}

export function isProjectedAttachmentHandle(value) {
  return typeof value === 'string' && PROJECTED_SHA256_HANDLE.test(value.trim())
}

function isSha256HandleLike(value) {
  return typeof value === 'string' && SHA256_HANDLE_PREFIX.test(value.trim())
}

function isCanonicalSha256Id(value) {
  return typeof value === 'string' && CANONICAL_SHA256_ID.test(value.trim())
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
export function resolveProjectedAttachmentHandle(handle, { core, sessionVisionIndex, agent } = {}) {
  const token = typeof handle === 'string' ? handle.trim() : ''
  if (!isProjectedAttachmentHandle(token)) return { kind: 'not-projected', value: handle }

  const session = agent?.session
  const refs = authorizedRefs(core, agent)
  const wanted = token.toLowerCase()
  const matches = refs.filter((ref) => {
    const id = attachmentIdOf(ref)
    return id !== undefined && id.toLowerCase().startsWith(wanted)
  })

  if (matches.length === 0) return { kind: 'unknown', handle: token }
  if (matches.length > 1) return { kind: 'ambiguous', handle: token }

  const candidate = matches[0]
  const canonicalId = attachmentIdOf(candidate)
  if (canonicalId === undefined) return { kind: 'unknown', handle: token }

  // The Session event/inbox proves authorization; warm the canonical bounded
  // index with that exact Host-owned ref, then require the index to hand it
  // back. This keeps all downstream tools on the same recovery/identity seam.
  try {
    sessionVisionIndex?.recordAttachments?.(session, [candidate])
  } catch {
    // A durable event can still be recovered by lookupAttachment below.
  }
  if (!sessionVisionIndex || typeof sessionVisionIndex.lookupAttachment !== 'function') {
    return { kind: 'unknown', handle: token }
  }
  const ref = sessionVisionIndex.lookupAttachment(session, canonicalId)
  if (ref === undefined) return { kind: 'unknown', handle: token }
  return { kind: 'resolved', handle: token, canonicalId, ref }
}

function canonicalizeValue(value, context) {
  if (!isSha256HandleLike(value)) return value
  if (isCanonicalSha256Id(value)) return value
  if (!isProjectedAttachmentHandle(value)) {
    throw new Error(
      `${context.toolName}: invalid attachment handle "${String(value).trim()}" ` +
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
  throw new Error(
    `${context.toolName}: unknown attachment handle "${result.handle}" ` +
      '(it is not authorized by an image in this conversation; attach the image again if needed)',
  )
}

function canonicalizeArgs(args, context, fields) {
  if (!isObject(args) || Array.isArray(args)) return args
  let next
  for (const field of fields.scalars ?? []) {
    if (!Object.hasOwn(args, field)) continue
    const value = canonicalizeValue(args[field], context)
    if (value !== args[field]) {
      next ??= { ...args }
      next[field] = value
    }
  }
  for (const field of fields.arrays ?? []) {
    const values = args[field]
    if (!Array.isArray(values)) continue
    let changed = false
    const mapped = values.map((value) => {
      const canonical = canonicalizeValue(value, context)
      if (canonical !== value) changed = true
      return canonical
    })
    if (changed) {
      next ??= { ...args }
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
export function wrapVisionAttachmentHandleDefinition(def, options = {}) {
  if (!def || typeof def !== 'object' || typeof def.execute !== 'function') return def
  const fields = TOOL_FIELDS[def.name]
  if (!fields || !options.sessionVisionIndex) return def
  const execute = def.execute
  return {
    ...def,
    execute(args, exec) {
      const nextArgs = canonicalizeArgs(args, {
        core: options.core,
        sessionVisionIndex: options.sessionVisionIndex,
        agent: exec?.agent,
        toolName: def.name,
      }, fields)
      return execute.call(def, nextArgs, exec)
    },
  }
}
