import { AsyncLocalStorage } from 'node:async_hooks'

const VISION_ROUTER_ADAPTER_OWNER = Symbol.for('dsh-vision-router.adapter-owner')
const VISION_ROUTER_OWNERSHIP = 'vision-router-owned'
const DEFAULT_WRAPPER_ROUTE = 'deepseek-vision'
const DEFAULT_CHAIN_ROUTE = 'vision-chain'
const DEEPSEEK_SOURCE = 'deepseek-official'

const authorityTurn = new AsyncLocalStorage()
const agentAuthorities = new WeakMap()
const assemblyAuthorities = new WeakMap()

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isWeakKey(value) {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function routeFrom(value) {
  if (!isObject(value)) return undefined
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  return provider !== '' && model !== '' ? { provider, model } : undefined
}

function selectionProjection(ctx, session) {
  let projections
  try {
    projections = ctx?.sessionProjections
  } catch {
    projections = undefined
  }
  if (!projections) {
    try {
      projections = ctx?.get?.('sessionProjections')
    } catch {
      projections = undefined
    }
  }
  if (!projections || typeof projections.stateOf !== 'function') return undefined
  try {
    const state = projections.stateOf(session, 'modelSelection')
    if (!isObject(state)) return undefined
    return routeFrom(state.pending ?? state.next ?? state.lastUsed)
  } catch {
    return undefined
  }
}

function fallbackRoute(session, agent) {
  try {
    const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined
    const direct = routeFrom(header?.config)
    if (direct) return direct
  } catch {
    // Cold or partially restored Sessions may not expose a request header yet.
  }

  const candidates = [
    agent?.options?.config,
    agent?.options,
    agent?.config,
    session?.agent?.options?.config,
    session?.agent?.options,
    session?.options?.config,
    session?.options,
    session?.config,
    session?.header?.config,
    session?.header,
  ]
  for (const candidate of candidates) {
    const route = routeFrom(candidate)
    if (route) return route
  }
  return undefined
}

export function effectiveSessionModelSelection(ctx, agent) {
  const session = agent?.session
  if (!session) return undefined
  return selectionProjection(ctx, session) ?? fallbackRoute(session, agent)
}

function liveConfig(ctx, fallback) {
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    if (isObject(value)) return value
  } catch {
    // Composition config remains authoritative while Settings is unavailable.
  }
  return isObject(fallback) ? fallback : {}
}

function registrationLookup(ctx) {
  const registration = ctx?.llm?.registration
  return typeof registration === 'function' ? registration : undefined
}

function currentAdapter(ctx, provider) {
  const registration = registrationLookup(ctx)
  if (!registration) return undefined
  try {
    return registration.call(ctx.llm, provider)?.adapter
  } catch {
    return undefined
  }
}

function adapterOwnedByVisionRouter(adapter) {
  if (!isWeakKey(adapter)) return false
  try {
    return adapter[VISION_ROUTER_ADAPTER_OWNER] !== undefined
  } catch {
    return false
  }
}

function sameRoute(left, right) {
  return !!left && !!right && left.provider === right.provider && left.model === right.model
}

function configuredRoute(config, key, fallback) {
  const value = typeof config?.[key] === 'string' ? config[key].trim() : ''
  return value || fallback
}

function routeOwnedByVisionRouter(ctx, route, config, visionPolicy) {
  if (!route) return false

  const registration = registrationLookup(ctx)
  if (registration) {
    // On current DSH, the final Host-visible adapter marker is authoritative.
    // If the configured route was replaced by a foreign adapter, fail closed
    // rather than granting mode from a matching route name.
    return adapterOwnedByVisionRouter(currentAdapter(ctx, route.provider))
  }

  // Minimum Host shims may not expose registration(). Native-image-coexistence
  // already proved exact registration ownership for the same selected route;
  // accept only that turn-local proof, never a generic -vision suffix.
  if (
    visionPolicy?.ownership === VISION_ROUTER_OWNERSHIP &&
    sameRoute(route, visionPolicy.route)
  ) {
    return true
  }

  // Compatibility fallback for explicit historical routes only when the Host
  // offers no registration identity at all. Current DSH never reaches this.
  const wrapperRoute = configuredRoute(config, 'wrapperRoute', DEFAULT_WRAPPER_ROUTE)
  const chainRoute = configuredRoute(config, 'chainRoute', DEFAULT_CHAIN_ROUTE)
  if (route.provider === wrapperRoute || route.provider === chainRoute || route.provider === 'vision-http') {
    return true
  }
  if (config?.stealth === true && route.provider === DEEPSEEK_SOURCE) return true
  return false
}

/**
 * Resolve the one authoritative Vision-mode snapshot for the next Agent step.
 *
 * The current DSH modelSelection projection is checked before requestHeader(),
 * because a composer toggle writes a pending model/selection event for the next
 * request while the last durable request header still names the previous route.
 * This prevents a stale ON header from granting tools after the user switched
 * Vision off (and the inverse when turning it back on).
 */
export function resolveSessionVisionModeAuthority(
  ctx,
  agent,
  fallbackConfig = {},
  options = {},
) {
  const route = effectiveSessionModelSelection(ctx, agent)
  const config = liveConfig(ctx, fallbackConfig)
  const enabled = routeOwnedByVisionRouter(ctx, route, config, options.visionPolicy)
  return Object.freeze({
    enabled,
    route: route ? Object.freeze({ ...route }) : undefined,
    reason: enabled ? 'vision-router-route' : route ? 'ordinary-route' : 'unknown-route',
    ...(options.turn === undefined ? {} : { turn: options.turn }),
  })
}

function normalizedAuthority(authority) {
  return isObject(authority)
    ? authority
    : Object.freeze({ enabled: false, reason: 'unknown-route' })
}

/** Persist the immutable authority for the currently entered step. */
export function rememberSessionVisionModeAuthorityForAgent(authority, agent) {
  const snapshot = normalizedAuthority(authority)
  if (isWeakKey(agent)) agentAuthorities.set(agent, snapshot)
  return snapshot
}

/**
 * Stage the authority captured by prompt assembly for exactly the immediately
 * following pre-step. Keeping this separate from the active-step snapshot is
 * important: a minimum/test Host may call pre-step directly more than once,
 * and an old completed-step snapshot must never masquerade as a new assembly.
 */
export function rememberSessionVisionModeAssemblyAuthorityForAgent(authority, agent) {
  const snapshot = normalizedAuthority(authority)
  if (isWeakKey(agent)) assemblyAuthorities.set(agent, snapshot)
  return snapshot
}

/** Consume at most one prompt-assembly snapshot for the following pre-step. */
export function takeSessionVisionModeAssemblyAuthorityForAgent(agent) {
  if (!isWeakKey(agent)) return undefined
  const snapshot = assemblyAuthorities.get(agent)
  assemblyAuthorities.delete(agent)
  return snapshot
}

/** Store one immutable step snapshot and keep it ambient while Core assembles it. */
export function runWithSessionVisionModeAuthority(authority, agent, callback) {
  const snapshot = rememberSessionVisionModeAuthorityForAgent(authority, agent)
  return authorityTurn.run({ authority: snapshot }, callback)
}

export function currentSessionVisionModeAuthority() {
  return authorityTurn.getStore()?.authority
}

export function sessionVisionModeAuthorityForAgent(agent) {
  return isWeakKey(agent) ? agentAuthorities.get(agent) : undefined
}

/** Drop completed/abandoned step and staged assembly snapshots. */
export function clearSessionVisionModeAuthorityForAgent(agent) {
  if (!isWeakKey(agent)) return
  agentAuthorities.delete(agent)
  assemblyAuthorities.delete(agent)
}

/**
 * Execution-time fail-closed check. Real Agent steps use the prompt-assembly
 * snapshot after pre-step promotes it to the active step, so a concurrent
 * picker change applies to the next assembled step instead of tearing the
 * current request in half. Direct/internal calls with an Agent but no captured
 * step resolve the live DSH selection synchronously.
 */
export function visionModeEnabledForAgent(ctx, agent, fallbackConfig = {}) {
  if (!isWeakKey(agent)) return true
  const snapshot = agentAuthorities.get(agent)
  if (snapshot) return snapshot.enabled === true
  return resolveSessionVisionModeAuthority(ctx, agent, fallbackConfig).enabled === true
}
