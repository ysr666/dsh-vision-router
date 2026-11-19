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
 * The selected twin remains registered for model discovery/admission and
 * session model selection. Its existing stream body still delegates through
 * the normal source LlmRuntime, so the source adapter's normal projection
 * happens exactly once.
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
    // Execute the live registered adapter, NOT the raw Core instance:
    // its stream wrappers own local stabilization and other runtime behavior.
    return registered.stream(options)
  }, { global: true })
}
