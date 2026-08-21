const wrappedContexts = new WeakMap()
const wrappedLlmServices = new WeakMap()
const preparedAdapterCompat = new WeakMap()

export const DEFAULT_ADAPTER_RECONCILE_MAX_PASSES = 32

/**
 * DSH 0.1.1 dispatches every model call through adapter.prepareCall(). Older
 * Vision Router adapters are intentionally duck-typed objects and therefore do
 * not inherit LlmAdapter's default implementation. Normalize only adapters
 * registered through Vision Router's wrapped context so host/foreign adapters
 * keep their native identity and behavior.
 */
export function ensureAdapterPrepareCall(adapter) {
  if (!adapter || (typeof adapter !== 'object' && typeof adapter !== 'function')) return adapter
  if (typeof adapter.prepareCall === 'function') return adapter

  const cached = preparedAdapterCompat.get(adapter)
  if (cached) return cached

  const prepareCall = async (provider, model, signal) => {
    const fallbackModel = { provider, id: model, name: model }
    const resolved =
      typeof adapter.resolveModel === 'function'
        ? await adapter.resolveModel.call(adapter, provider, model, signal)
        : fallbackModel
    return {
      model: resolved && typeof resolved === 'object' ? resolved : fallbackModel,
      stream(options) {
        return adapter.stream.call(adapter, options)
      },
    }
  }

  // Preserve the exact adapter object whenever possible. Some runtime paths
  // retain registration.adapter and compare/reuse it later, so mutation is less
  // surprising than substituting a wrapper. Frozen/sealed adapters fall back to
  // a proxy that exposes only the missing contract method.
  try {
    Object.defineProperty(adapter, 'prepareCall', {
      configurable: true,
      writable: true,
      value: prepareCall,
    })
    preparedAdapterCompat.set(adapter, adapter)
    return adapter
  } catch {
    const wrapped = new Proxy(adapter, {
      get(target, property) {
        if (property === 'prepareCall') return prepareCall
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    preparedAdapterCompat.set(adapter, wrapped)
    return wrapped
  }
}

function wrapLlmService(llm) {
  if (!llm || (typeof llm !== 'object' && typeof llm !== 'function')) return llm
  const cached = wrappedLlmServices.get(llm)
  if (cached) return cached

  const wrapped = new Proxy(llm, {
    get(target, property) {
      if (property === 'registerAdapter') {
        const registerAdapter = Reflect.get(target, property, target)
        if (typeof registerAdapter !== 'function') return registerAdapter
        return (providers, adapter, ...rest) =>
          registerAdapter.call(target, providers, ensureAdapterPrepareCall(adapter), ...rest)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  wrappedLlmServices.set(llm, wrapped)
  return wrapped
}

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
 *
 * The same boundary also normalizes Vision Router-owned adapter registrations
 * to the DSH 0.1.1 prepareCall contract. This stays scoped to the wrapped
 * context instead of monkey-patching the Host LLM service process-wide.
 */
export function contextWithCoalescedAdapterUpdates(ctx) {
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return ctx
  const cached = wrappedContexts.get(ctx)
  if (cached) return cached

  const wrapped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'llm') {
        return wrapLlmService(Reflect.get(target, property, target))
      }
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
