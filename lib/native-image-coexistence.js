import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Turn-local image ownership used by the public entry composition.
 *
 * This module intentionally does NOT rewrite messages and does NOT gate tool
 * execution. It answers one question only: who owns image handling for the
 * currently selected session route? Core owns the image-history transform;
 * the tool runtime boundary owns live tool permissions.
 */
export const IMAGE_OWNERSHIP = Object.freeze({
  VISION_ROUTER: 'vision-router-owned',
  NATIVE: 'native-image',
  TEXT_ONLY: 'text-only',
  UNKNOWN: 'unknown',
})

/**
 * Cross-wrapper ownership marker. Symbol.for() gives every private context
 * wrapper in this package the same key without importing this module, while
 * an enumerable symbol also survives the rare Object.assign/object-spread
 * adapter wrapper. Normal JSON/Object.keys surfaces still ignore symbols.
 */
export const VISION_ROUTER_ADAPTER_OWNER = Symbol.for('dsh-vision-router.adapter-owner')

const imageTurn = new AsyncLocalStorage()
const markedAdapters = new WeakMap()

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function isWeakKey(value) {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function routeFrom(value) {
  if (!isObject(value)) return undefined
  const provider = typeof value.provider === 'string' ? value.provider : ''
  const model = typeof value.model === 'string' ? value.model : ''
  return provider !== '' && model !== '' ? { provider, model } : undefined
}

function rememberSessionRoute(state, session, route) {
  if (!state || !isWeakKey(session) || !route) return route
  state.sessionRoutes.set(session, route)
  return route
}

function sessionRoute(session, agent, state) {
  try {
    const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined
    const direct = routeFrom(header?.config)
    if (direct !== undefined) return rememberSessionRoute(state, session, direct)
  } catch {
    // Restored/cold sessions may not expose a request header immediately.
  }

  const candidates = [
    agent?.options?.config,
    agent?.options,
    agent?.config,
    session?.agent?.options?.config,
    session?.agent?.options,
    session?.options?.config,
    session?.options,
    session?.config,
    session?.header?.config,
    session?.header,
  ]
  for (const candidate of candidates) {
    const route = routeFrom(candidate)
    if (route !== undefined) return rememberSessionRoute(state, session, route)
  }

  if (state && isWeakKey(session)) return state.sessionRoutes.get(session)
  return undefined
}

function scopeConfig(state) {
  try {
    const value = state?.settingsScope?.get?.()
    return isObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

function liveVisionRouterConfig(ctx, fallback, state) {
  const scoped = scopeConfig(state)
  if (scoped !== undefined) return scoped
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    if (isObject(value)) return value
  } catch {
    // Settings may be between service generations; composition config remains
    // the authoritative fallback until the next injected scope appears.
  }
  return fallback
}

function currentAdapter(ctx, provider) {
  const registration = ctx?.llm?.registration
  if (typeof registration !== 'function') return undefined
  try {
    return registration.call(ctx.llm, provider)?.adapter
  } catch {
    return undefined
  }
}

/**
 * Mark an adapter before it enters the lower wrapper stack. Unknown property
 * reads on the package's adapter proxies are transparent, so the token is
 * observable on the final Host-visible adapter even after stream wrappers.
 * Frozen/sealed adapters receive one tiny marker proxy instead of mutation.
 */
export function markVisionRouterAdapter(adapter, token) {
  if (!isWeakKey(adapter) || !isWeakKey(token)) return adapter
  try {
    if (adapter[VISION_ROUTER_ADAPTER_OWNER] === token) return adapter
  } catch {
    // Continue to a local marker.
  }

  try {
    Object.defineProperty(adapter, VISION_ROUTER_ADAPTER_OWNER, {
      configurable: true,
      enumerable: true,
      writable: false,
      value: token,
    })
    return adapter
  } catch {
    let byToken = markedAdapters.get(adapter)
    if (!byToken) {
      byToken = new WeakMap()
      markedAdapters.set(adapter, byToken)
    }
    const cached = byToken.get(token)
    if (cached) return cached
    const marked = new Proxy(adapter, {
      get(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
        if (descriptor?.configurable === false) {
          if ('value' in descriptor && descriptor.writable === false) return descriptor.value
          if (!('value' in descriptor) && descriptor.get === undefined) return undefined
        }
        if (property === VISION_ROUTER_ADAPTER_OWNER) return token
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    byToken.set(token, marked)
    return marked
  }
}

export function visionRouterAdapterOwner(adapter) {
  if (!isWeakKey(adapter)) return undefined
  try {
    return adapter[VISION_ROUTER_ADAPTER_OWNER]
  } catch {
    return undefined
  }
}

function routeList(routes) {
  const list = Array.isArray(routes) ? routes : [routes]
  return list
    .map((route) => (typeof route === 'string' ? route : String(route ?? '')))
    .filter((route) => route !== '')
}

function activateRegistration(state, routes, token) {
  const record = {
    token,
    active: true,
    routes: new Set(routeList(routes)),
  }
  for (const route of record.routes) state.activeRegistrations.set(route, record)
  return record
}

function releaseRegistration(state, record) {
  if (!record || record.active !== true) return
  record.active = false
  for (const route of record.routes) {
    if (state.activeRegistrations.get(route) === record) state.activeRegistrations.delete(route)
  }
  record.routes.clear()
}

function replaceRegistrationRoutes(state, record, routes) {
  if (!record || record.active !== true) return
  const next = new Set(routeList(routes))
  for (const route of record.routes) {
    if (!next.has(route) && state.activeRegistrations.get(route) === record) {
      state.activeRegistrations.delete(route)
    }
  }
  record.routes = next
  for (const route of record.routes) state.activeRegistrations.set(route, record)
}

function wrapRegistrationHandle(handle, state, record) {
  if (typeof handle !== 'function') return handle
  let active = true
  return new Proxy(handle, {
    apply(target, thisArg, args) {
      if (!active) return undefined
      active = false
      try {
        return Reflect.apply(target, thisArg, args)
      } finally {
        releaseRegistration(state, record)
      }
    },
    get(target, property, receiver) {
      if (property === 'replace' && typeof target.replace === 'function') {
        return (routes, ...args) => {
          if (!active || record.active !== true) return undefined
          const result = target.replace.call(target, routes, ...args)
          if (result && typeof result.then === 'function') {
            return result.then((value) => {
              replaceRegistrationRoutes(state, record, routes)
              return value
            })
          }
          replaceRegistrationRoutes(state, record, routes)
          return result
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function stateOwnsRoute(ctx, state, provider) {
  if (!state || !(state.activeRegistrations instanceof Map)) return false
  const record = state.activeRegistrations.get(provider)
  if (!record || record.active !== true || !isWeakKey(record.token)) return false

  // A live registration lookup is authoritative. The ownership token survives
  // package-local Proxy layers, but disappears when a Host/foreign adapter
  // genuinely replaces the route with a different adapter.
  if (typeof ctx?.llm?.registration === 'function') {
    return visionRouterAdapterOwner(currentAdapter(ctx, provider)) === record.token
  }

  // Minimum Host shims without registration() still have the registration
  // handle lifecycle, which is the strongest proof available there.
  return true
}

function pluginOwnedRoute(ctx, provider, config = {}, state) {
  if (state) return stateOwnsRoute(ctx, state, provider)

  // Compatibility fallback for direct helper callers outside the public entry
  // composition. Runtime classification never guesses from a generic suffix.
  const wrapper = typeof config.wrapperRoute === 'string' && config.wrapperRoute !== ''
    ? config.wrapperRoute
    : 'deepseek-vision'
  const chain = typeof config.chainRoute === 'string' && config.chainRoute !== ''
    ? config.chainRoute
    : 'vision-chain'
  if (provider === wrapper || provider === chain || provider === 'vision-http') return true
  if (config.stealth === true && provider === 'deepseek-official') return true
  return false
}

function capabilityCacheOf(state, adapter) {
  if (!state || !isWeakKey(adapter)) return undefined
  let cache = state.adapterCapabilities.get(adapter)
  if (!cache) {
    cache = new Map()
    state.adapterCapabilities.set(adapter, cache)
  }
  return cache
}

function capabilityKey(route) {
  return `${route.provider}\u0000${route.model}`
}

async function modelCapability(ctx, route, state) {
  const adapter = currentAdapter(ctx, route.provider)
  const trustedCache = capabilityCacheOf(state, adapter)
  const key = capabilityKey(route)

  const classify = (info) => {
    if (!info || !Array.isArray(info.inputModalities)) return undefined
    const capability = info.inputModalities.includes('image')
      ? IMAGE_OWNERSHIP.NATIVE
      : IMAGE_OWNERSHIP.TEXT_ONLY
    trustedCache?.set(key, capability)
    return capability
  }

  try {
    const resolved = classify(await ctx?.llm?.resolveModelInfo?.(route.provider, route.model))
    if (resolved !== undefined) return resolved
  } catch {
    // Try the selected adapter itself before treating a cold catalog as unknown.
  }

  try {
    if (adapter && typeof adapter.resolveModel === 'function') {
      const resolved = classify(await adapter.resolveModel(route.provider, route.model))
      if (resolved !== undefined) return resolved
    }
  } catch {
    // Fall through to trusted per-adapter/provider/model memory.
  }

  return trustedCache?.get(key) ?? IMAGE_OWNERSHIP.UNKNOWN
}

export async function classifySessionImageOwnership(
  ctx,
  session,
  fallbackConfig = {},
  options = {},
) {
  const route = sessionRoute(session, options.agent, options.state)
  if (route === undefined) return IMAGE_OWNERSHIP.UNKNOWN
  const config = liveVisionRouterConfig(ctx, fallbackConfig, options.state)
  if (pluginOwnedRoute(ctx, route.provider, config, options.state)) {
    return IMAGE_OWNERSHIP.VISION_ROUTER
  }
  return modelCapability(ctx, route, options.state)
}

/**
 * Produce one immutable policy per pre-step. UNKNOWN deliberately does not
 * authorize a destructive image rewrite: only explicit text-only metadata (or
 * a trusted cache for the same adapter/provider/model) may bridge raw images.
 */
export async function resolveSessionVisionPolicy(
  ctx,
  session,
  fallbackConfig = {},
  options = {},
) {
  const route = sessionRoute(session, options.agent, options.state)
  const config = liveVisionRouterConfig(ctx, fallbackConfig, options.state)
  let ownership = IMAGE_OWNERSHIP.UNKNOWN
  if (route !== undefined) {
    ownership = pluginOwnedRoute(ctx, route.provider, config, options.state)
      ? IMAGE_OWNERSHIP.VISION_ROUTER
      : await modelCapability(ctx, route, options.state)
  }

  const native = ownership === IMAGE_OWNERSHIP.NATIVE
  const pluginOwned = ownership === IMAGE_OWNERSHIP.VISION_ROUTER
  const textOnly = ownership === IMAGE_OWNERSHIP.TEXT_ONLY

  return Object.freeze({
    route: route ? Object.freeze({ ...route }) : undefined,
    ownership,
    preserveRawImages: native || pluginOwned || ownership === IMAGE_OWNERSHIP.UNKNOWN,
    rewriteCurrentImages:
      textOnly && config?.rewriteImages !== false && config?.routing !== true,
    suppressGenericAutoMount: native,
    // Native multimodal routes already own image understanding. Keep Vision
    // Router tools available, but do not turn the optional tool surface into a
    // mandatory structured 1+x contract for a Host-native image model.
    allowStructuredBootstrap: !native,
  })
}

export async function sessionUsesNativeImageModel(ctx, session, fallbackConfig = {}) {
  return (
    await classifySessionImageOwnership(ctx, session, fallbackConfig)
  ) === IMAGE_OWNERSHIP.NATIVE
}

export function currentSessionImageOwnership() {
  return imageTurn.getStore()?.policy?.ownership
}

export function currentSessionVisionPolicy() {
  return imageTurn.getStore()?.policy
}

function settingsServiceView(settings, state) {
  if (!isObject(settings)) return settings
  return new Proxy(settings, {
    get(target, property) {
      if (property === 'register') {
        const register = Reflect.get(target, property, target)
        if (typeof register !== 'function') return register
        return (namespace, ...args) => {
          const scope = register.call(target, namespace, ...args)
          if (namespace === 'vision-router') state.settingsScope = scope
          return scope
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function injectedContextView(child, state) {
  if (!isObject(child)) return child
  const settings = settingsServiceView(child.settings, state)
  return new Proxy(child, {
    get(target, property) {
      if (property === 'settings') return settings
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function llmView(llm, state) {
  if (!isObject(llm)) return llm
  const cached = state.llmCache.get(llm)
  if (cached) return cached
  const wrapped = new Proxy(llm, {
    get(target, property) {
      if (property !== 'registerAdapter') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const register = Reflect.get(target, property, target)
      if (typeof register !== 'function') return register
      return (routes, adapter, ...rest) => {
        const token = Object.freeze({})
        const marked = markVisionRouterAdapter(adapter, token)
        // Record ownership only after the complete lower registration chain has
        // accepted the adapter. Thrown registrations cannot leave stale state.
        const handle = register.call(target, routes, marked, ...rest)
        const record = activateRegistration(state, routes, token)
        return wrapRegistrationHandle(handle, state, record)
      }
    },
  })
  state.llmCache.set(llm, wrapped)
  return wrapped
}

/**
 * Private entry-context wrapper. It marks plugin-owned adapter registrations
 * and scopes one policy through AsyncLocalStorage while core runs. It never
 * mutates the user's config, tool schema, tool execution, or message content.
 */
export function contextWithNativeImageCoexistence(ctx, config = {}) {
  if (!isObject(ctx)) return { ctx, config }
  const state = {
    settingsScope: undefined,
    sessionRoutes: new WeakMap(),
    activeRegistrations: new Map(),
    adapterCapabilities: new WeakMap(),
    llmCache: new WeakMap(),
  }

  const wrappedCtx = new Proxy(ctx, {
    get(target, property) {
      if (property === 'llm') return llmView(Reflect.get(target, property, target), state)
      if (property === 'on') {
        const on = Reflect.get(target, property, target)
        if (typeof on !== 'function') return on
        return (event, handler, ...rest) => {
          if (event !== 'agent/pre-step' || typeof handler !== 'function') {
            return on.call(target, event, handler, ...rest)
          }
          return on.call(target, event, async function imageOwnershipAwarePreStep(payload, next) {
            const policy = await resolveSessionVisionPolicy(
              target,
              payload?.agent?.session,
              config,
              { agent: payload?.agent, state },
            )
            return imageTurn.run({ policy }, () => handler.call(this, payload, next))
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
            (child) => callback(injectedContextView(child, state)),
            ...rest,
          )
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  return { ctx: wrappedCtx, config }
}