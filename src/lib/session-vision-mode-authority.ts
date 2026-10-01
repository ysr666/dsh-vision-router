import { AsyncLocalStorage } from 'node:async_hooks'

import type { VisionRouteIdentity } from './vision-execution-order.js'
import { parseSessionVisionPolicy } from './session-vision-policy.js'

const VISION_ROUTER_ADAPTER_OWNER = Symbol.for('dsh-vision-router.adapter-owner')
const VISION_ROUTER_OWNERSHIP = 'vision-router-owned'
const DEFAULT_WRAPPER_ROUTE = 'deepseek-vision'
const DEFAULT_CHAIN_ROUTE = 'vision-chain'
const DEEPSEEK_SOURCE = 'deepseek-official'

export type SessionVisionModeReason =
  | 'session-policy'
  | 'vision-router-route'
  | 'ordinary-route'
  | 'unknown-route'

export interface SessionVisionModeAuthority {
  readonly enabled: boolean
  readonly route: Readonly<VisionRouteIdentity> | undefined
  readonly reason: SessionVisionModeReason
  readonly turn?: unknown
}

interface AuthorityTurnStore {
  readonly authority: Readonly<SessionVisionModeAuthority>
}

const authorityTurn = new AsyncLocalStorage<AuthorityTurnStore>()
const agentAuthorities = new WeakMap<object, Readonly<SessionVisionModeAuthority>>()
const assemblyAuthorities = new WeakMap<object, Readonly<SessionVisionModeAuthority>>()

function objectRecord(value: unknown): Record<PropertyKey, unknown> | undefined {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? value as Record<PropertyKey, unknown>
    : undefined
}

function property(value: unknown, key: PropertyKey): unknown {
  return objectRecord(value)?.[key]
}

function isWeakKey(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function routeFrom(value: unknown): VisionRouteIdentity | undefined {
  const record = objectRecord(value)
  if (!record || Array.isArray(value)) return undefined
  const provider = typeof record.provider === 'string' ? record.provider.trim() : ''
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  return provider !== '' && model !== '' ? { provider, model } : undefined
}

function contextGet(ctx: unknown, name: string): unknown {
  const record = objectRecord(ctx)
  const get = record?.get
  if (typeof get !== 'function') return undefined
  try {
    return get.call(ctx, name)
  } catch {
    return undefined
  }
}

function selectionProjection(ctx: unknown, session: unknown): VisionRouteIdentity | undefined {
  let projections = property(ctx, 'sessionProjections')
  if (!projections) projections = contextGet(ctx, 'sessionProjections')

  const stateOf = property(projections, 'stateOf')
  if (typeof stateOf !== 'function') return undefined

  try {
    const state = stateOf.call(projections, session, 'modelSelection')
    const record = objectRecord(state)
    if (!record || Array.isArray(state)) return undefined
    return routeFrom(record.pending ?? record.next ?? record.lastUsed)
  } catch {
    return undefined
  }
}

function fallbackRoute(session: unknown, agent: unknown): VisionRouteIdentity | undefined {
  try {
    const requestHeader = property(session, 'requestHeader')
    const header = typeof requestHeader === 'function'
      ? requestHeader.call(session)
      : undefined
    const direct = routeFrom(property(header, 'config'))
    if (direct) return direct
  } catch {
    // Cold or partially restored Sessions may not expose a request header yet.
  }

  const agentOptions = property(agent, 'options')
  const sessionAgent = property(session, 'agent')
  const sessionAgentOptions = property(sessionAgent, 'options')
  const sessionOptions = property(session, 'options')
  const sessionHeader = property(session, 'header')

  const candidates = [
    property(agentOptions, 'config'),
    agentOptions,
    property(agent, 'config'),
    property(sessionAgentOptions, 'config'),
    sessionAgentOptions,
    property(sessionOptions, 'config'),
    sessionOptions,
    property(session, 'config'),
    property(sessionHeader, 'config'),
    sessionHeader,
  ]

  for (const candidate of candidates) {
    const route = routeFrom(candidate)
    if (route) return route
  }
  return undefined
}

export function effectiveSessionModelSelection(
  ctx: unknown,
  agent: unknown,
): VisionRouteIdentity | undefined {
  const session = property(agent, 'session')
  if (!session) return undefined
  return selectionProjection(ctx, session) ?? fallbackRoute(session, agent)
}

function liveConfig(ctx: unknown, fallback: unknown): Record<PropertyKey, unknown> {
  try {
    const settings = contextGet(ctx, 'settings')
    const get = property(settings, 'get')
    const value = typeof get === 'function'
      ? get.call(settings, 'vision-router')
      : undefined
    const record = objectRecord(value)
    if (record && !Array.isArray(value)) return record
  } catch {
    // Composition config remains authoritative while Settings is unavailable.
  }
  const record = objectRecord(fallback)
  return record && !Array.isArray(fallback) ? record : {}
}

function registrationLookup(ctx: unknown): { owner: unknown; lookup: (...args: unknown[]) => unknown } | undefined {
  const llm = property(ctx, 'llm')
  const registration = property(llm, 'registration')
  return typeof registration === 'function'
    ? { owner: llm, lookup: registration as (...args: unknown[]) => unknown }
    : undefined
}

function currentAdapter(ctx: unknown, provider: string): unknown {
  const registration = registrationLookup(ctx)
  if (!registration) return undefined
  try {
    return property(registration.lookup.call(registration.owner, provider), 'adapter')
  } catch {
    return undefined
  }
}

function adapterOwnedByVisionRouter(adapter: unknown): boolean {
  if (!isWeakKey(adapter)) return false
  try {
    return objectRecord(adapter)?.[VISION_ROUTER_ADAPTER_OWNER] !== undefined
  } catch {
    return false
  }
}

function sameRoute(left: VisionRouteIdentity | undefined, right: unknown): boolean {
  const rightRoute = routeFrom(right)
  return !!left
    && !!rightRoute
    && left.provider === rightRoute.provider
    && left.model === rightRoute.model
}

function configuredRoute(
  config: Record<PropertyKey, unknown>,
  key: string,
  fallback: string,
): string {
  const value = typeof config[key] === 'string' ? config[key].trim() : ''
  return value || fallback
}

function routeOwnedByVisionRouter(
  ctx: unknown,
  route: VisionRouteIdentity | undefined,
  config: Record<PropertyKey, unknown>,
  visionPolicy: unknown,
): boolean {
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
    property(visionPolicy, 'ownership') === VISION_ROUTER_OWNERSHIP
    && sameRoute(route, property(visionPolicy, 'route'))
  ) {
    return true
  }

  // Compatibility fallback for explicit historical routes only when the Host
  // offers no registration identity at all. Current DSH never reaches this.
  const wrapperRoute = configuredRoute(config, 'wrapperRoute', DEFAULT_WRAPPER_ROUTE)
  const chainRoute = configuredRoute(config, 'chainRoute', DEFAULT_CHAIN_ROUTE)
  if (
    route.provider === wrapperRoute
    || route.provider === chainRoute
    || route.provider === 'vision-http'
  ) {
    return true
  }
  if (config.stealth === true && route.provider === DEEPSEEK_SOURCE) return true
  return false
}

export interface ResolveSessionVisionModeAuthorityOptions {
  readonly visionPolicy?: unknown
  readonly sessionPolicy?: unknown
  readonly turn?: unknown
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
  ctx: unknown,
  agent: unknown,
  fallbackConfig: unknown = {},
  options: ResolveSessionVisionModeAuthorityOptions = {},
): Readonly<SessionVisionModeAuthority> {
  const route = effectiveSessionModelSelection(ctx, agent)
  const sessionPolicy = parseSessionVisionPolicy(options.sessionPolicy)
  const config = liveConfig(ctx, fallbackConfig)
  const routeEnabled = routeOwnedByVisionRouter(ctx, route, config, options.visionPolicy)
  const enabled = sessionPolicy?.enabled ?? routeEnabled
  return Object.freeze({
    enabled,
    route: route ? Object.freeze({ ...route }) : undefined,
    reason: sessionPolicy !== undefined
      ? 'session-policy'
      : routeEnabled
        ? 'vision-router-route'
        : route
          ? 'ordinary-route'
          : 'unknown-route',
    ...(options.turn === undefined ? {} : { turn: options.turn }),
  })
}

function normalizedAuthority(authority: unknown): Readonly<SessionVisionModeAuthority> {
  const record = objectRecord(authority)
  if (record && !Array.isArray(authority)) {
    // Compatibility callers already provide the immutable authority envelope.
    // Preserve that exact snapshot rather than rebuilding it and changing
    // historical property-presence semantics.
    return authority as Readonly<SessionVisionModeAuthority>
  }
  return Object.freeze({
    enabled: false,
    route: undefined,
    reason: 'unknown-route',
  })
}

/** Persist the immutable authority for the currently entered step. */
export function rememberSessionVisionModeAuthorityForAgent(
  authority: unknown,
  agent: unknown,
): Readonly<SessionVisionModeAuthority> {
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
export function rememberSessionVisionModeAssemblyAuthorityForAgent(
  authority: unknown,
  agent: unknown,
): Readonly<SessionVisionModeAuthority> {
  const snapshot = normalizedAuthority(authority)
  if (isWeakKey(agent)) assemblyAuthorities.set(agent, snapshot)
  return snapshot
}

/** Consume at most one prompt-assembly snapshot for the following pre-step. */
export function takeSessionVisionModeAssemblyAuthorityForAgent(
  agent: unknown,
): Readonly<SessionVisionModeAuthority> | undefined {
  if (!isWeakKey(agent)) return undefined
  const snapshot = assemblyAuthorities.get(agent)
  assemblyAuthorities.delete(agent)
  return snapshot
}

/** Store one immutable step snapshot and keep it ambient while Core assembles it. */
export function runWithSessionVisionModeAuthority<T>(
  authority: unknown,
  agent: unknown,
  callback: () => T,
): T {
  const snapshot = rememberSessionVisionModeAuthorityForAgent(authority, agent)
  return authorityTurn.run({ authority: snapshot }, callback)
}

export function currentSessionVisionModeAuthority(): Readonly<SessionVisionModeAuthority> | undefined {
  return authorityTurn.getStore()?.authority
}

export function sessionVisionModeAuthorityForAgent(
  agent: unknown,
): Readonly<SessionVisionModeAuthority> | undefined {
  return isWeakKey(agent) ? agentAuthorities.get(agent) : undefined
}

/** Drop completed/abandoned step and staged assembly snapshots. */
export function clearSessionVisionModeAuthorityForAgent(agent: unknown): void {
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
export function visionModeEnabledForAgent(
  ctx: unknown,
  agent: unknown,
  fallbackConfig: unknown = {},
  options: ResolveSessionVisionModeAuthorityOptions = {},
): boolean {
  if (!isWeakKey(agent)) return true
  const snapshot = agentAuthorities.get(agent)
  if (snapshot) return snapshot.enabled === true
  return resolveSessionVisionModeAuthority(ctx, agent, fallbackConfig, options).enabled === true
}
