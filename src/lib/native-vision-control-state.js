import { isVisionRouterOwnedAdapter } from './adapter-ownership.js'
import { resolveSessionVisionModeAuthority } from './session-vision-mode-authority.js'

export function nativeControlSelection(agent) {
  try {
    const selected = agent?.model?.current?.()
    if (typeof selected?.provider !== 'string' || !selected.provider ||
        typeof selected?.model !== 'string' || !selected.model) return undefined
    return Object.freeze({ provider: selected.provider, model: selected.model })
  } catch {
    return undefined
  }
}

export function registeredControlAdapter(ctx, provider) {
  try {
    const adapter = ctx.llm.registration(provider)?.adapter
    return adapter && (typeof adapter === 'object' || typeof adapter === 'function')
      ? adapter : undefined
  } catch {
    return undefined
  }
}

export function nativeControlTargetCurrent(ctx, agent, target) {
  if (!target || !agent || agent.session !== target.session ||
      agent.id !== target.sessionId || agent.session?.id !== target.sessionId) return false
  const selection = nativeControlSelection(agent)
  if (!selection || selection.provider !== target.selection.provider ||
      selection.model !== target.selection.model) return false
  const adapter = registeredControlAdapter(ctx, selection.provider)
  return adapter === target.adapter && !isVisionRouterOwnedAdapter(adapter)
}

/**
 * Resolve capability on the ACTUAL selected adapter, not the provider name.
 * A metadata result from a replaced registration cannot authorize a write
 * or a browser state. The target is process-local and MUST NOT cross the wire.
 */
export async function resolveNativeControlTarget(ctx, agent, signal) {
  const session = agent?.session
  const sessionId = session?.id
  if (signal?.aborted || typeof sessionId !== 'string' || !sessionId ||
      agent.id !== sessionId) return { kind: 'unavailable', reason: 'inactive-session' }
  const selection = nativeControlSelection(agent)
  if (!selection) return { kind: 'unavailable', reason: 'no-selection' }
  const adapter = registeredControlAdapter(ctx, selection.provider)
  if (!adapter) return { kind: 'unavailable', reason: 'no-registration' }
  if (isVisionRouterOwnedAdapter(adapter)) return { kind: 'legacy', reason: 'dvr-wrapper', selection }
  const target = { session, sessionId, selection, adapter }
  let info
  try {
    info = await ctx.llm.resolveModelInfo(selection.provider, selection.model, signal)
  } catch {
    return { kind: 'unavailable', reason: 'metadata-unavailable' }
  }
  if (signal?.aborted || !nativeControlTargetCurrent(ctx, agent, target)) {
    return { kind: 'unavailable', reason: 'stale-selection' }
  }
  if (!Array.isArray(info?.inputModalities) ||
      (info.provider !== undefined && info.provider !== selection.provider) ||
      (info.id !== undefined && info.id !== selection.model)) {
    return { kind: 'unavailable', reason: 'metadata-unavailable' }
  }
  if (!info.inputModalities.includes('image')) {
    return { kind: 'legacy', reason: 'text-only', selection }
  }
  return { kind: 'native', target }
}

/**
 * Internal B2 read contract for a Host-authorized Agent. No raw Session ID
 * from a client is accepted, and no command or model selection is executed.
 * Read the SAME policy store used by request assembly; never create another
 * authority by folding historical command result strings. Hydration may fill
 * the hot cache but does not mutate durable permission or append events.
 *
 * This is NOT an exposed gateway or subscription: the transport must enforce
 * the Host's Session lookup/authorization and generation fencing separately.
 */
export async function readNativeVisionControlState(ctx, store, agent, {
  signal, toolEnabled = () => true, config = {},
} = {}) {
  const resolved = await resolveNativeControlTarget(ctx, agent, signal)
  if (resolved.kind !== 'native') return resolved
  const { target } = resolved
  let policy
  let allowed
  try {
    if (typeof store?.get !== 'function') {
      return { kind: 'unavailable', reason: 'policy-store-unavailable' }
    }
    if (store.get(target.sessionId) === undefined && typeof store.hydrate === 'function') {
      await store.hydrate(target.sessionId)
    }
    if (signal?.aborted || !nativeControlTargetCurrent(ctx, agent, target)) {
      return { kind: 'unavailable', reason: 'stale-selection' }
    }
    policy = store.get(target.sessionId)
    allowed = toolEnabled() === true
  } catch {
    return { kind: 'unavailable', reason: 'policy-read-failed' }
  }
  const authority = resolveSessionVisionModeAuthority(ctx, agent, config, {
    route: target.selection, sessionPolicy: policy,
  })
  // Do not disclose inherited parent Session IDs, adapters, raw policy data,
  // messages or provider credentials in this deliberately narrow view.
  return Object.freeze({
    kind: 'native',
    selection: target.selection,
    enabled: allowed && authority.enabled === true,
    requestedEnabled: authority.enabled === true,
    canEnable: allowed,
    durable: typeof store.durable === 'boolean' ? store.durable : null,
  })
}
