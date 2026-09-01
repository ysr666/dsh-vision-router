import { AsyncLocalStorage } from 'node:async_hooks'

import { installRuntimeI18nBoundary } from './runtime-i18n-boundary.js'

function objectLike(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

/**
 * Create a deferred i18n view for the final legacy-Core context.
 *
 * Composition can hand the decorated context through later runtime installers
 * without changing their Host-facing semantics: outside run(), every property
 * is read from the ordinary context. During run(), the same outer context
 * resolves through installRuntimeI18nBoundary(), so Core registrations and
 * pre-step callbacks are localized at their actual ownership boundary.
 *
 * AsyncLocalStorage keeps the activation scoped to Core.apply even when apply
 * returns a promise; there is no process-global locale or permanent mode bit.
 */
export function createRuntimeI18nCoreScope({ config = {} } = {}) {
  const activation = new AsyncLocalStorage()
  const localizedContexts = new WeakMap()
  const decoratedContexts = new WeakMap()

  const localized = (ctx) => {
    const cached = localizedContexts.get(ctx)
    if (cached) return cached
    const next = installRuntimeI18nBoundary(ctx, config)
    localizedContexts.set(ctx, next)
    return next
  }

  const decorate = (ctx) => {
    if (!objectLike(ctx)) return ctx
    const cached = decoratedContexts.get(ctx)
    if (cached) return cached
    const wrapped = new Proxy(ctx, {
      get(target, property) {
        const view = activation.getStore() === true ? localized(target) : target
        return Reflect.get(view, property, view)
      },
    })
    decoratedContexts.set(ctx, wrapped)
    return wrapped
  }

  const run = (callback) => {
    if (typeof callback !== 'function') {
      throw new TypeError('runtime i18n core scope requires a callback')
    }
    return activation.run(true, callback)
  }

  return Object.freeze({ decorate, run })
}
