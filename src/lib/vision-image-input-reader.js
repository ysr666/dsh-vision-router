import { combineSignals } from './vision-resilience.js'
import { currentVisionTurnBudgetSignal } from './turn-budget-context.js'
import { isAttachmentIdInput, sniffMediaType, mediaTypeOf } from './core-primitives.js'

/**
 * One authorized image-source reader for all Vision Router tools.
 * Source identity belongs to the caller's Session, not to the global
 * content-addressed attachment store. Neither the Host's private path nor
 * untrusted model-facing short attachment aliases become filesystem inputs.
 */
export function createVisionImageInputReader(ctx, resolveAttachment, throwIfVisionTaskAborted) {
  return async function readImageBytes(exec, imagePath, resolvedAttachmentRefs, attachmentInput = false) {
    const input = String(imagePath ?? '')
    const signal = combineSignals(currentVisionTurnBudgetSignal(), exec?.signal)
    throwIfVisionTaskAborted(signal)
    let bytes
    let storedMediaType
    if (attachmentInput || isAttachmentIdInput(input)) {
      // Uploaded images reach the tool arguments as durable attachment ids
      // ("sha256:..."); resolve them through the session's recorded upload
      // index instead of treating the id as a filesystem path.
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error('vision-router: the attachment service is not available in this deployment')
      }
      const session = exec && exec.agent && exec.agent.session
      const canonicalInput = input.trim()
      const ref = resolvedAttachmentRefs instanceof Map
        ? resolvedAttachmentRefs.get(canonicalInput)
        : await resolveAttachment(session, canonicalInput, signal)
      if (ref === undefined) {
        throw new Error(
          `vision-router: unknown attachment id "${input}" (it must come from an image uploaded in this conversation)`,
        )
      }
      throwIfVisionTaskAborted(signal)
      let stored
      try {
        stored = await attachments.readImage(ref, signal)
        throwIfVisionTaskAborted(signal)
      } catch (error) {
        throw new Error(
          `vision-router: failed to read attachment ${input} (${error && error.message ? error.message : String(error)})`,
        )
      }
      bytes = stored.data
      if (stored.ref && typeof stored.ref.mediaType === 'string') {
        storedMediaType = stored.ref.mediaType
      }
    } else {
      const fs = ctx.get('fs')
      if (fs === undefined) throw new Error('vision-router: the fs service is not available')
      const target = await fs.resolve(input)
      throwIfVisionTaskAborted(signal)
      bytes = await fs.readBytes(target, signal, 20 * 1024 * 1024)
      throwIfVisionTaskAborted(signal)
    }
    // Attachments are stored as content-addressed files without an
    // extension: sniff the format from the bytes, and fall back to the
    // stored ref / extension only when sniffing cannot decide.
    const mediaType = sniffMediaType(bytes) ?? storedMediaType ?? mediaTypeOf(input)
    if (mediaType === undefined) {
      throw new Error(`unsupported image format ${input} (png/jpeg/webp/gif only)`)
    }
    return { bytes, mediaType }
  }
}
