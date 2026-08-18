const wrappedContexts = new WeakMap()

/**
 * Turn a synchronous reconciliation pass into a fixed-point runner.
 *
 * Calling the returned function while a pass is already running never recurses.
 * Instead it marks the world dirty; the outer call immediately runs another
 * pass after the current one returns, repeating until no synchronous re-entry
 * occurred. This is deliberately a synchronous primitive because DSH rc.7
 * publishes llm/adapters-updated synchronously from registerAdapter().
 */
export function createCoalescingRunner(run) {
  if (typeof run !== 'function') throw new TypeError('createCoalescingRunner: run must be a function')

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
    try {
      do {
        dirty = false
        result = run.apply(latestThis, latestArgs)
        if (result && typeof result.then === 'function') {
          throw new TypeError('createCoalescingRunner: asynchronous reconciliation is not supported')
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
          return on.call(target, event, createCoalescingRunner(listener), ...rest)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  wrappedContexts.set(ctx, wrapped)
  return wrapped
}
