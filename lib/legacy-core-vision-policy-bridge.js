import { currentSessionSurfacePolicy } from './session-surface-policy.js'
import { knownSessionVisionMemory } from './session-vision-state.js'

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function collectAttachmentIds(messages) {
  const ids = []
  const seen = new Set()
  const pending = []
  for (const message of messages ?? []) {
    if (message && Array.isArray(message.content)) pending.push(...message.content)
  }
  while (pending.length > 0) {
    const block = pending.pop()
    if (!block || typeof block !== 'object') continue
    if (block.type === 'image') {
      const ref = block.attachment
      const raw = ref && (ref.attachmentId ?? ref.id)
      if (raw !== undefined && raw !== null) {
        const id = String(raw)
        if (id !== '' && !seen.has(id)) {
          seen.add(id)
          ids.push(id)
        }
      }
    }
    if (Array.isArray(block.content)) pending.push(...block.content)
  }
  return ids.reverse()
}

function appendVisionRouterAttachmentHint(payload, decision, config) {
  const policy = currentSessionSurfacePolicy(config)
  if (decision?.kind === 'reject' || policy.ownership !== 'vision-router-owned') {
    return decision
  }

  // Vision Router-owned wrappers may deliberately preserve raw pixels when the
  // delegated source model is itself multimodal. The provider wire carries the
  // bytes, but not DSH's durable attachmentId, so a model that chooses a
  // precision Vision Router tool would otherwise have to guess an id. Surface
  // the exact current-turn ids as read-only model context while leaving the raw
  // image blocks and the session-scoped lookup fence unchanged.
  const source = Array.isArray(payload?.messages) ? payload.messages : []
  const ids = collectAttachmentIds(source)
  if (ids.length === 0) return decision

  const baseMessages = Array.isArray(decision?.messages)
    ? decision.messages
    : source
  const turn = Number.isInteger(payload?.turn) ? payload.turn : 'current'
  const step = Number.isInteger(payload?.step) ? payload.step : 'step'
  const hintId = `vision-router-attachment-refs-${turn}-${step}`
  if (baseMessages.some((message) => message?.id === hintId)) return decision

  const quoted = ids.map((id) => `"${id}"`).join(', ')
  const hint = {
    role: 'user',
    id: hintId,
    content: [{
      type: 'text',
      text: `Vision Router attachment references for the image(s) in this step: ${quoted}. If a Vision Router tool requires attachmentIds or an attachment-id image argument, use only these exact ids. Never guess or invent an attachment id.`,
    }],
    source: { kind: 'plugin', plugin: 'dsh-vision-router' },
  }
  const messages = [...baseMessages, hint]
  return isObject(decision)
    ? { ...decision, messages }
    : { kind: 'continue', messages }
}

function rewriteTextOnlyDecision(payload, decision, rewriteHistoryImages, config) {
  const policy = currentSessionSurfacePolicy(config)
  if (
    decision?.kind === 'reject' ||
    policy.rewriteCurrentImages !== true ||
    typeof rewriteHistoryImages !== 'function'
  ) {
    return decision
  }

  const source = Array.isArray(decision?.messages)
    ? decision.messages
    : Array.isArray(payload?.messages)
      ? payload.messages
      : undefined
  if (!source) return decision

  // Core registers the exact SessionMemoryView while processing this same
  // pre-step. Reuse it here so a text-only fallback preserves cached visual
  // descriptions instead of degrading them back to a generic attachment marker.
  const memory = knownSessionVisionMemory(payload?.agent?.session)
  const rewritten = rewriteHistoryImages(source, memory)
  const messages = rewritten?.messages
  if (!Array.isArray(messages) || messages === source) return decision
  if (isObject(decision)) return { ...decision, messages }
  return { kind: 'continue', messages }
}

/**
 * Preserve the two remaining pre-step compatibility behaviors without
 * impersonating Settings/config for Core.
 *
 * Ownership classification remains native-image-coexistence's responsibility.
 * Core consumes its five policy-derived switches through CoreVisionSurface.
 * This boundary only reuses the exact SessionMemoryView for a text-only image
 * rewrite and surfaces current durable attachment ids for a Vision Router-owned
 * route. Every other context service, Settings object, injected child and config
 * value passes through unchanged.
 */
export function installLegacyCoreVisionPolicyBridge(
  ctx,
  config = {},
  { rewriteHistoryImages } = {},
) {
  if (!isObject(ctx)) return { ctx, config }

  const wrappedCtx = new Proxy(ctx, {
    get(target, property) {
      if (property === 'on') {
        const on = Reflect.get(target, property, target)
        if (typeof on !== 'function') return on
        return (event, handler, ...rest) => {
          if (event !== 'agent/pre-step' || typeof handler !== 'function') {
            return on.call(target, event, handler, ...rest)
          }
          return on.call(target, event, async function legacyCoreVisionPolicyPreStep(payload, next) {
            const decision = await handler.call(this, payload, next)
            const rewritten = rewriteTextOnlyDecision(
              payload,
              decision,
              rewriteHistoryImages,
              config,
            )
            return appendVisionRouterAttachmentHint(payload, rewritten, config)
          }, ...rest)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  return {
    ctx: wrappedCtx,
    config,
  }
}
