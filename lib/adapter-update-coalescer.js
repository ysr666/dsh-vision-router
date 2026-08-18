const wrappedContexts = new WeakMap()

export const DEFAULT_ADAPTER_RECONCILE_MAX_PASSES = 32

/**
 * Turn a synchronous reconciliation pass into a bounded fixed-point runner.
 *
 * Calling the returned function while a pass is already running never recurses.
 * Instead it marks the world dirty; the outer call immediately runs another
 * pass after the current one returns. The pass count is deliberately bounded:
 * a foreign plugin or future host can emit llm/adapters-updated on every
 * reconciliation attempt even when the topology never converges. Without a
 * bound, one synchronous event can pin the Node process at 100% CPU forever.
 *
 * Hitting the bound fails open for availability: stop this reconciliation
 * cycle, report the non-convergence, and let a later real topology event try
 * again. Throwing here would turn another plugin's bad event semantics into a
 * host-wide startup failure, which is worse than temporarily stale twins.
 */
export function createCoalescingRunner(run, options = {}) {
  if (typeof run !== 'function') throw new TypeError('createCoalescingRunner: run must be a function')

  const maxPasses =
    Number.isInteger(options.maxPasses) && options.maxPasses > 0
      ? options.maxPasses
      : DEFAULT_ADAPTER_RECONCILE_MAX_PASSES
  const onNonConverging =
    typeof options.onNonConverging === 'function' ? options.onNonConverging : undefined

  let running = false
  let dirty = false
  let latestThis
  let latestArgs = []

  return function coalesced(...args) {
    latestThis = this
    latestArgs = args
    dirty = true
    if (running) return undefined

    running = true
    let result
    let passes = 0
    try {
      do {
        dirty = false
        passes += 1
        result = run.apply(latestThis, latestArgs)
        if (result && typeof result.then === 'function') {
          throw new TypeError('createCoalescingRunner: asynchronous reconciliation is not supported')
        }
        if (dirty && passes >= maxPasses) {
          // Consume the pathological re-entry marker so this invocation can
          // return to the event loop. A later host event is still free to call
          // the runner again from a clean state.
          dirty = false
          try {
            onNonConverging?.({ passes, maxPasses, thisArg: latestThis, args: latestArgs })
          } catch {
            // Diagnostics must never recreate the availability failure this
            // guard exists to prevent.
          }
          break
        }
      } while (dirty)
      return result
    } finally {
      running = false
    }
  }
}

/**
 * Narrow context wrapper for Vision Router's core.apply(). DSH rc.7 commits
 * adapter routes and synchronously emits llm/adapters-updated before
 * registerAdapter() returns. Only Vision Router listeners registered through
 * this wrapped context are coalesced; host and other plugin listeners keep
 * their native event semantics.
 */
export function contextWithCoalescedAdapterUpdates(ctx) {
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return ctx
  const cached = wrappedContexts.get(ctx)
  if (cached) return cached

  const wrapped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'on') {
        const on = Reflect.get(target, property, target)
        if (typeof on !== 'function') return on
        return (event, listener, ...rest) => {
          if (event !== 'llm/adapters-updated' || typeof listener !== 'function') {
            return on.call(target, event, listener, ...rest)
          }
          let warned = false
          const guarded = createCoalescingRunner(listener, {
            onNonConverging({ passes }) {
              if (warned) return
              warned = true
              try {
                target.logger?.error?.(
                  'vision-router: adapter reconciliation did not converge after %d synchronous passes; stopping this cycle to keep the host responsive',
                  passes,
                )
              } catch {
                /* diagnostics must never break event delivery */
              }
            },
          })
          return on.call(target, event, guarded, ...rest)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  wrappedContexts.set(ctx, wrapped)
  return wrapped
}
