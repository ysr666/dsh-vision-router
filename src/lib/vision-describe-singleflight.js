/**
 * One in-flight vision_describe operation may serve duplicate tool calls
 * only within the SAME Host Session AND the SAME parent cancellation signal.
 *
 * The caller must provide an authorized, content-based cache key (never an
 * attachment identity that bypasses Host permission checks). Distinct runs,
 * sessions, cancellation domains or unknown identity execute independently.
 *
 * The map is weakly scoped; every settle evicts its key. Failures are not
 * cached. Persistent successful-result caching belongs to the caller.
 */
export function createVisionDescribeSingleFlight() {
  const sessions = new WeakMap()
  return function run(session, signal, key, factory) {
    if (typeof factory !== 'function') throw new TypeError('vision_describe requires an executor')
    if (!session || typeof session !== 'object' ||
        !signal || typeof signal !== 'object' || typeof signal.aborted !== 'boolean' ||
        signal.aborted || typeof key !== 'string' || key.length === 0) {
      return Promise.resolve().then(factory)
    }
    let signals = sessions.get(session)
    if (!signals) {
      signals = new WeakMap()
      sessions.set(session, signals)
    }
    let entries = signals.get(signal)
    if (!entries) {
      entries = new Map()
      signals.set(signal, entries)
    }
    const existing = entries.get(key)
    if (existing) return existing

    const promise = Promise.resolve().then(() => {
      if (signal.aborted) {
        const error = new Error('vision_describe cancelled before dispatch')
        error.name = 'AbortError'
        throw error
      }
      return factory()
    })
    entries.set(key, promise)
    const clean = () => {
      if (entries.get(key) === promise) entries.delete(key)
    }
    // Side-effect cleanup is attached to BOTH settlements. Returning this
    // promise keeps rejections visible to the original tool callers.
    void promise.then(clean, clean)
    return promise
  }
}
