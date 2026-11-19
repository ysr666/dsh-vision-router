import { AsyncLocalStorage } from 'node:async_hooks'

const twinInputScope = new AsyncLocalStorage()

// Core creates this identity before the FIRST composition wrapper. The
// native-image ownership token is minted later, on a facade's independent
// shell, so it cannot prove a relationship to the original Core object.
// This private symbol is only an identity witness for transparent dispatch,
// not another Session policy, provider authority, or public ownership marker.
const TWIN_STREAM_ID = Symbol('vision-router.generated-twin-stream')

export function identifyOwnedTwinStream(adapter) {
  Object.defineProperty(adapter, TWIN_STREAM_ID, {
    configurable: false, enumerable: false, writable: false,
    value: Object.freeze({}),
  })
  return adapter
}

function streamIdentity(adapter) {
  try { return adapter?.[TWIN_STREAM_ID] } catch { return undefined }
}

/**
 * Issue #865: intercept only active, DVR-owned generated twin routes at the
 * documented Host llm/stream waterfall, before LlmRuntime.adapterStream()
 * performs per-adapter replay filtering and tool-history projection.
 *
 * Always invoke Host next(): prepareCall pins an adapter generation that
 * is not exposed in this public waterfall. Only the actual DVR twin body
 * restores the pre-projection input; source Runtime projects it once again
 * for the source adapter. Never dispatch the live registry adapter here.
 *
 * This does NOT grant vision tools to an OFF Session, mutate session history,
 * or intercept a similarly named route owned by another plugin.
 */
export function installOwnedTwinStreamBoundary(ctx, resolveOwnedTwin) {
  if (!ctx || typeof ctx.on !== 'function' || typeof resolveOwnedTwin !== 'function') {
    throw new TypeError('owned twin stream boundary requires a Host event scope and route resolver')
  }
  return ctx.on('llm/stream', (options, next) => {
    const provider = options?.provider
    // The waterfall runs before adapterStream's normal prepareCall() check.
    // A pre-aborted request must stay on the Host's native dispatch path,
    // where cancellation is normalized to its standard aborted finish.
    // Never let a transparent twin short-circuit that validation boundary.
    if (options?.signal?.aborted) return next()
    if (typeof provider !== 'string' || !provider.endsWith('-vision')) return next()

    let adapter
    try {
      adapter = resolveOwnedTwin(provider)
    } catch {
      return next()
    }
    if (!adapter || typeof adapter.stream !== 'function') return next()

    // The map alone is insufficient authority: a route may have been disposed
    // or replaced by another plugin while an event is in flight.
    let registered
    try {
      registered = ctx.llm?.registration?.(provider)?.adapter
    } catch {
      return next()
    }
    if (registered !== adapter) {
      // Match the exact Core-generated identity forwarded by the composed
      // facade/proxies, never the generic ownership marker or route suffix.
      const expected = streamIdentity(adapter)
      if (expected === undefined || streamIdentity(registered) !== expected) return next()
    }
    if (typeof registered?.stream !== 'function') return next()
    const scope = { raw: options }
    const downstream = twinInputScope.run(scope, next)
    return (async function* () {
      let iterator
      let done = false
      try {
        iterator = twinInputScope.run(scope, () => downstream[Symbol.asyncIterator]())
        while (true) {
          const step = await twinInputScope.run(scope, () => iterator.next())
          if (step.done) { done = true; return step.value }
          yield step.value
        }
      } finally {
        scope.raw = undefined
        if (!done && typeof iterator?.return === 'function') {
          await twinInputScope.run(scope, () => iterator.return())
        }
      }
    })()
  }, { global: true })
}

// Called exclusively by generated DVR twin bodies/facades, not by the
// waterfall itself. Keep all Host-resolved execution controls. A prepared old
// generation may consume this input; it is the Host that selected that body.
export function restoreOwnedTwinStreamInput(options, expectedProvider) {
  const scope = twinInputScope.getStore()
  const raw = scope?.raw
  if (!raw || !expectedProvider || options?.provider !== expectedProvider ||
      raw.provider !== expectedProvider || raw.model !== options.model ||
      raw.sessionId !== options.sessionId || raw.signal !== options.signal) return options
  scope.raw = undefined
  if (options.signal?.aborted) return options
  const restored = { ...options, messages: raw.messages }
  for (const key of ['tools', 'toolHistory']) {
    if (Object.hasOwn(raw, key)) restored[key] = raw[key]
    else delete restored[key]
  }
  return restored
}
