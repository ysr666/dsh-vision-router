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
  // DSH 0.2.1-rc.5 owns the selection in ApiSessionAgentController,
  // and its Agent has no model.current API. Preserve the old picker ONLY for
  // this positive unsupported-Host shape, not arbitrary metadata failures.
  if (typeof agent?.model?.current !== 'function') {
    return { kind: 'unavailable', reason: 'host-control-unsupported' }
  }
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

/**
 * Internal, pull-based B2 state stream for a Host-authorized live Agent.
 * A future Remote carrier must perform Host lookup/authorization before
 * calling this function; this is not a public endpoint. Use the same policy
 * store as request assembly and pass the live tool-enabled settings reader.
 *
 * Invalidation is coalesced into a revision, not an unbounded event queue.
 * At most one capability read is active per observer. Old async reads cannot
 * publish after a newer invalidation; cancellation also releases a waiter
 * when a provider ignores AbortSignal. No command or Session event is written.
 */
export function observeNativeVisionControlState(ctx, store, agent, {
  signal: callerSignal, ...readOptions
} = {}) {
  const lifetime = new AbortController()
  const signal = lifetime.signal
  const stop = () => lifetime.abort()
  const stream = (async function* () {
    if (signal.aborted || callerSignal?.aborted) return
    const session = agent?.session
    const sessionId = session?.id
    const unavailable = { kind: 'unavailable', reason: 'observer-unavailable' }
    if (typeof sessionId !== 'string' || !sessionId || agent.id !== sessionId ||
        typeof store?.subscribe !== 'function' || typeof ctx?.on !== 'function' ||
        typeof ctx?.effect !== 'function') {
      yield unavailable
      return
    }

    let revision = 0
    let wake
    let cancelRead
    let disposeScope
    let lastRoute
    const disposers = []
    const disposeSafely = (dispose) => {
      if (typeof dispose !== 'function') return
      try { void Promise.resolve(dispose()).catch(() => {}) } catch {}
    }
    const own = (dispose) => {
      if (typeof dispose !== 'function') throw new TypeError('observer disposer required')
      if (signal.aborted) disposeSafely(dispose)
      else disposers.push(dispose)
    }
    const notify = () => {
      if (signal.aborted) return
      revision++
      const pending = wake
      wake = undefined
      pending?.()
    }
    const retire = () => {
      callerSignal?.removeEventListener('abort', stop)
      const pending = wake
      wake = undefined
      pending?.()
      cancelRead?.()
      while (disposers.length > 0) disposeSafely(disposers.pop())
      const scope = disposeScope
      disposeScope = undefined
      disposeSafely(scope)
    }
    const routeKey = () => JSON.stringify(nativeControlSelection(agent) ?? null)
    const readOrStop = () => new Promise(resolve => {
      const finish = value => {
        if (cancelRead !== cancel) return
        cancelRead = undefined
        resolve(value)
      }
      const cancel = () => finish(undefined)
      cancelRead = cancel
      void readNativeVisionControlState(ctx, store, agent, {
        ...readOptions, signal,
      }).then(finish, () => finish({ kind: 'unavailable', reason: 'policy-read-failed' }))
    })

    signal.addEventListener('abort', retire, { once: true })
    callerSignal?.addEventListener('abort', stop, { once: true })
    try {
      if (callerSignal?.aborted) { stop(); return }
      try {
        const scope = ctx.effect(() => () => {
          // Fiber retirement must not try to dispose its own running effect.
          disposeScope = undefined
          stop()
        }, 'vision-router: native control observer')
        if (typeof scope !== 'function') throw new TypeError('observer scope disposer required')
        if (signal.aborted) disposeSafely(scope)
        else disposeScope = scope
        own(store.subscribe(sessionId, notify))
        own(ctx.on('session/event', (current, event) => {
          if (current !== session) return
          if (event?.type === 'model/selection' ||
              (event?.type === 'request/header' && routeKey() !== lastRoute)) notify()
        }, { global: true }))
        own(ctx.on('agent/disposed', ({ agent: disposed }) => {
          if (disposed === agent) stop()
        }, { global: true }))
        own(ctx.on('llm/adapters-updated', notify))
        const settingsChanged = ns => { if (String(ns) === 'vision-router') notify() }
        own(ctx.on('settings/updated', settingsChanged))
        own(ctx.on('settings/document-updated', settingsChanged))
      } catch {
        const cancelled = signal.aborted
        stop()
        if (!cancelled) yield unavailable
        return
      }

      let previous
      while (!signal.aborted) {
        const observed = revision
        lastRoute = routeKey()
        const value = await readOrStop()
        if (signal.aborted) return
        if (observed !== revision) continue
        // The read contract is a bounded, detached JSON value, not an Agent,
        // adapter or a borrowed store object.
        const fingerprint = JSON.stringify(value)
        if (fingerprint !== previous) {
          previous = fingerprint
          yield value
        }
        if (signal.aborted) return
        if (observed !== revision) continue
        await new Promise(resolve => { wake = resolve })
      }
    } finally {
      stop()
    }
  })()

  // AsyncGenerator.return() alone queues behind a blocked next(). Closing
  // this iterator explicitly aborts that pending read or idle wait first.
  return {
    [Symbol.asyncIterator]() { return this },
    next() { return stream.next() },
    return() { stop(); return stream.return(undefined) },
  }
}
