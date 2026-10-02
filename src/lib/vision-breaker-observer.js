import { AsyncLocalStorage } from 'node:async_hooks'

const breakerObserver = new AsyncLocalStorage()

/**
 * Run plugin construction with a scoped observer for any vision circuit
 * breaker created inside that async context. The observer is diagnostic-only:
 * throwing from it must never make plugin apply fail.
 */
export function withVisionCircuitBreakerObserver(observer, run) {
  if (typeof run !== 'function') throw new TypeError('run must be a function')
  if (typeof observer !== 'function') return run()
  return breakerObserver.run(observer, run)
}

/** Internal factory hook used by createVisionCircuitBreaker(). */
export function publishVisionCircuitBreaker(breaker) {
  const observer = breakerObserver.getStore()
  if (typeof observer === 'function') {
    try {
      observer(breaker)
    } catch {
      // Observability can never affect v1 breaker construction or execution.
    }
  }
  return breaker
}
