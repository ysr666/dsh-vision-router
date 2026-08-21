import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Native multimodal coexistence boundary for DSH 0.1.1+.
 *
 * Vision Router must not promote a Host-native vision model into its own
 * fallback order: that order remains entirely user/config driven. But when a
 * session is ALREADY on an exact model whose Host metadata declares image
 * input, the plugin must not turn that raw image back into a text marker or run
 * the hidden instant-local caption pass before the native model sees it.
 *
 * This boundary is intentionally turn-scoped and read-only. It does not mutate
 * persisted settings and it does not alter provider/model selection. During
 * the core pre-step only, `rewriteImages` and `instantDescribe` read as false
 * for a Host-native image-capable route. Plugin-owned wrapper/chain/twin routes
 * are excluded because they deliberately own their own image rewrite path.
 */

const nativeImageTurn = new AsyncLocalStorage()

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function sessionRoute(session) {
  try {
    const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined
    const config = header?.config
    const provider = typeof config?.provider === 'string' ? config.provider : ''
    const model = typeof config?.model === 'string' ? config.model : ''
    return provider !== '' && model !== '' ? { provider, model } : undefined
  } catch {
    return undefined
  }
}

function liveVisionRouterConfig(ctx, fallback) {
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    return isObject(value) ? value : fallback
  } catch {
    return fallback
  }
}

function pluginOwnedRoute(provider, config = {}) {
  const wrapper = typeof config.wrapperRoute === 'string' && config.wrapperRoute !== ''
    ? config.wrapperRoute
    : 'deepseek-vision'
  const chain = typeof config.chainRoute === 'string' && config.chainRoute !== ''
    ? config.chainRoute
    : 'vision-chain'
  if (provider === wrapper || provider === chain || provider === 'vision-http') return true
  // Auto-wrapped provider twins are implementation routes, not native routes.
  if (typeof provider === 'string' && provider.endsWith('-vision')) return true
  // On the legacy stealth path Vision Router itself owns deepseek-official.
  if (config.stealth === true && provider === 'deepseek-official') return true
  return false
}

/** True only when the session explicitly targets a Host-native image model. */
export async function sessionUsesNativeImageModel(ctx, session, fallbackConfig = {}) {
  const route = sessionRoute(session)
  if (route === undefined) return false
  const config = liveVisionRouterConfig(ctx, fallbackConfig)
  if (pluginOwnedRoute(route.provider, config)) return false
  try {
    const info = await ctx?.llm?.resolveModelInfo?.(route.provider, route.model)
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
  } catch {
    return false
  }
}

function configView(value) {
  if (!isObject(value)) return value
  return new Proxy(value, {
    get(target, property, receiver) {
      if (nativeImageTurn.getStore() === true) {
        if (property === 'rewriteImages' || property === 'instantDescribe') return false
      }
      const result = Reflect.get(target, property, receiver)
      return typeof result === 'function' ? result.bind(target) : result
    },
  })
}

function settingsScopeView(scope) {
  if (!isObject(scope)) return scope
  return new Proxy(scope, {
    get(target, property, receiver) {
      if (property === 'get') {
        const get = Reflect.get(target, property, target)
        if (typeof get !== 'function') return get
        return (...args) => configView(get.apply(target, args))
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function settingsServiceView(settings) {
  if (!isObject(settings)) return settings
  return new Proxy(settings, {
    get(target, property, receiver) {
      if (property === 'register') {
        const register = Reflect.get(target, property, target)
        if (typeof register !== 'function') return register
        return (namespace, ...args) => {
          const scope = register.call(target, namespace, ...args)
          return namespace === 'vision-router' ? settingsScopeView(scope) : scope
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function injectedContextView(child) {
  if (!isObject(child)) return child
  const settings = settingsServiceView(child.settings)
  return new Proxy(child, {
    get(target, property, receiver) {
      if (property === 'settings') return settings
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * Wrap only Vision Router's private context/config view.
 * Returns `{ ctx, config }`; outside a native-image pre-step both are behavior
 * identical to their inputs.
 */
export function contextWithNativeImageCoexistence(ctx, config = {}) {
  if (!isObject(ctx)) return { ctx, config }
  const wrappedConfig = configView(config)
  const wrappedCtx = new Proxy(ctx, {
    get(target, property, receiver) {
      if (property === 'on') {
        const on = Reflect.get(target, property, target)
        if (typeof on !== 'function') return on
        return (event, handler, ...rest) => {
          if (event !== 'agent/pre-step' || typeof handler !== 'function') {
            return on.call(target, event, handler, ...rest)
          }
          return on.call(target, event, async function nativeImageAwarePreStep(payload, next) {
            const native = await sessionUsesNativeImageModel(
              target,
              payload?.agent?.session,
              config,
            )
            return nativeImageTurn.run(native, () => handler.call(this, payload, next))
          }, ...rest)
        }
      }
      if (property === 'inject') {
        const inject = Reflect.get(target, property, target)
        if (typeof inject !== 'function') return inject
        return (dependencies, callback, ...rest) => {
          if (
            !Array.isArray(dependencies) ||
            !dependencies.includes('settings') ||
            typeof callback !== 'function'
          ) {
            return inject.call(target, dependencies, callback, ...rest)
          }
          return inject.call(
            target,
            dependencies,
            (child) => callback(injectedContextView(child)),
            ...rest,
          )
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { ctx: wrappedCtx, config: wrappedConfig }
}
