function boundedAttachmentId(block) {
  const attachment = block && typeof block === 'object' ? block.attachment : undefined
  const raw = attachment && (attachment.attachmentId ?? attachment.id)
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  return raw.trim().slice(0, 256)
}

/** DSH 0.1.6+ marks durable request-limit omissions on the ImageBlock itself. */
export function isOffloadedImageBlock(block) {
  return !!block && block.type === 'image' && block.offloaded === true
}

export function blocksHaveRetainedImage(content) {
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'image' && block.offloaded !== true) return true
    if (Array.isArray(block.content) && blocksHaveRetainedImage(block.content)) return true
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
export function offloadedImagePlaceholder(block) {
  const id = boundedAttachmentId(block)
  if (id === undefined) {
    return '[image omitted to fit request image limits; attachment id unavailable]'
  }
  return `[image omitted to fit request image limits; attachment ${id}. ` +
    `To inspect it again, call vision_describe with attachmentIds: [${JSON.stringify(id)}].]`
}
