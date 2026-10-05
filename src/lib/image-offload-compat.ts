import type { ImageBlock } from '@deepseek-ai/dsh-llm/types'

interface LegacyImageAttachmentRef {
  readonly attachmentId?: unknown
  readonly id?: unknown
}

interface LegacyImageBlock {
  readonly type: 'image'
  readonly attachment?: LegacyImageAttachmentRef
  readonly offloaded?: boolean
}

type CompatibleImageBlock = ImageBlock | LegacyImageBlock

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function boundedAttachmentId(block: unknown): string | undefined {
  const attachment = objectRecord(objectRecord(block)?.attachment)
  const raw = attachment?.attachmentId ?? attachment?.id
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  return raw.trim().slice(0, 256)
}

/** DSH 0.1.6+ marks durable request-limit omissions on the ImageBlock itself. */
export function isOffloadedImageBlock(
  block: unknown,
): block is CompatibleImageBlock & { readonly offloaded: true } {
  const value = objectRecord(block)
  return value?.type === 'image' && value.offloaded === true
}

/**
 * Deepest content nesting this walker inspects, mirroring the bound
 * `catalog-corrections.convertBlocks` already applies to the same block tree.
 * The walker only needs message → content → nested content; an unbounded
 * recursion would turn a pathological tree into a stack overflow.
 */
const MAX_CONTENT_NESTING_DEPTH = 4

export function blocksHaveRetainedImage(content: unknown, depth = 0): boolean {
  if (!Array.isArray(content) || depth > MAX_CONTENT_NESTING_DEPTH) return false
  for (const block of content) {
    const value = objectRecord(block)
    if (value === undefined) continue
    if (value.type === 'image' && value.offloaded !== true) return true
    if (Array.isArray(value.content) && blocksHaveRetainedImage(value.content, depth + 1)) return true
  }
  return false
}

/**
 * Dependency-free model-facing placeholder for an image DSH already offloaded.
 *
 * Do not import the 0.1.6 `offloadedImageText` helper here: DVR still supports
 * older Hosts where that export does not exist. The durable attachment stays
 * available to Vision Router tools, but custom wire serializers must never
 * read or resend its bytes once the Host projection marks this occurrence.
 */
export function offloadedImagePlaceholder(block: unknown): string {
  const id = boundedAttachmentId(block)
  if (id === undefined) {
    return '[image omitted to fit request image limits; attachment id unavailable]'
  }
  return `[image omitted to fit request image limits; attachment ${id}. ` +
    `To inspect it again, call vision_describe with attachmentIds: [${JSON.stringify(id)}].]`
}
