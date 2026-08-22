import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Per-turn image ownership for DSH 0.1.1+.
 *
 * One image turn has one routing owner:
 * - vision-router-owned: the selected provider is currently bound to an adapter
 *   registered through Vision Router's private context;
 * - native-image: the exact selected Host model declares image input;
 * - text-only: the exact selected Host model explicitly does not accept image;
 * - unknown: the selected route or model capability metadata could not be resolved.
 *
 * Runtime ownership never depends on provider/model naming. Registration state
 * follows the adapter registration handle, including replace() and dispose().
 */
export const IMAGE_OWNERSHIP = Object.freeze({
  VISION_ROUTER: 'vision-router-owned',
  NATIVE: 'native-image',
  TEXT_ONLY: 'text-only',
  UNKNOWN: 'unknown',
})

const imageTurn = new AsyncLocalStorage()

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
    // A restored/cold session may not have a readable request header yet.
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

function liveVisionRouterConfig(ctx, fallback, state) {
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    if (isObject(value)) {
      if (state) state.liveConfig = value
      return value
    }
  } catch {
    // Fall through to the last settings scope observed through inject().
  }
  if (isObject(state?.liveConfig)) return state.liveConfig
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

function stateOwnsRoute(ctx, state, provider) {
  if (!state || !(state.activeRegistrations instanceof Map)) return false
  const registration = state.activeRegistrations.get(provider)
  if (!registration || registration.active !== true) return false
  if (!isWeakKey(registration.adapter) || !state.ownedAdapters.has(registration.adapter)) return false

  // When DSH exposes the live registration lookup, adapter identity is the
  // authoritative ownership proof. This also makes ownership disappear if a
  // Host/third-party adapter replaces the same provider behind our back.
  if (typeof ctx?.llm?.registration === 'function') {
    return currentAdapter(ctx, provider) === registration.adapter
  }

  // Older service shims do not expose registration(). In that case the DSH
  // registration handle lifecycle is our strongest available identity proof.
  return true
}

function pluginOwnedRoute(ctx, provider, config = {}, state) {
  if (state) return stateOwnsRoute(ctx, state, provider)

  // Compatibility fallback for direct helper callers that are not running
  // through contextWithNativeImageCoexistence(). Runtime classification always
  // uses adapter-registration identity above and therefore never guesses from
  // a generic `*-vision` provider name.
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

async function modelCapability(ctx, route, state) {
  const adapter = currentAdapter(ctx, route.provider)
  const trustedCache = capabilityCacheOf(state, adapter)
  try {
    const info = await ctx?.llm?.resolveModelInfo?.(route.provider, route.model)
    if (!info || !Array.isArray(info.inputModalities)) {
      return trustedCache?.get(route.model) ?? IMAGE_OWNERSHIP.UNKNOWN
    }
    const capability = info.inputModalities.includes('image')
      ? IMAGE_OWNERSHIP.NATIVE
      : IMAGE_OWNERSHIP.TEXT_ONLY
    trustedCache?.set(route.model, capability)
    return capability
  } catch {
    return trustedCache?.get(route.model) ?? IMAGE_OWNERSHIP.UNKNOWN
  }
}

/**
 * Resolve the selected session route to one image owner.
 *
 * Capability cache entries are scoped to the currently registered adapter
 * identity. Replacing an adapter therefore cannot inherit stale native-image
 * capability from the old registration.
 */
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
 * One immutable policy object is produced for every pre-step. Downstream
 * config/tool/image layers consume it instead of independently re-classifying
 * the selected model.
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
  const bridgeTextOnlyImages =
    !native &&
    !pluginOwned &&
    config?.rewriteImages !== false &&
    config?.routing !== true

  return Object.freeze({
    route: route ? Object.freeze({ ...route }) : undefined,
    ownership,
    preserveRawImages: native || pluginOwned,
    suppressCoreRewrite: native,
    bridgeTextOnlyImages,
    instantDescribe: native ? false : config?.instantDescribe,
    autoActivateOnImage: native ? false : config?.autoActivateOnImage,
  })
}

/** Backwards-compatible helper retained for callers/tests. */
export async function sessionUsesNativeImageModel(ctx, session, fallbackConfig = {}) {
  return (
    await classifySessionImageOwnership(ctx, session, fallbackConfig)
  ) === IMAGE_OWNERSHIP.NATIVE
}

export function currentSessionImageOwnership() {
  return imageTurn.getStore()?.policy?.ownership ?? imageTurn.getStore()?.ownership
}

export function currentSessionVisionPolicy() {
  return imageTurn.getStore()?.policy
}

function imageMarker(id) {
  return `[attached image: ${id}] The current model cannot see images. To examine it, call vision_describe with attachmentIds: [\"${id}\"] and a specific question.`
}

function rewriteImagesDeep(content, replace) {
  if (!Array.isArray(content)) return { content, changed: false }
  let changed = false
  const next = []
  for (const block of content) {
    if (block && block.type === 'image') {
      const out = replace(block)
      changed = true
      if (Array.isArray(out)) next.push(...out)
      else if (out !== undefined) next.push(out)
      continue
    }
    if (block && Array.isArray(block.content)) {
      const inner = rewriteImagesDeep(block.content, replace)
      if (inner.changed) {
        changed = true
        next.push({ ...block, content: inner.content })
        continue
      }
    }
    next.push(block)
  }
  return { content: changed ? next : content, changed }
}

function rewriteTextOnlyMessages(messages) {
  let changed = false
  const rewritten = (messages ?? []).map((message) => {
    if (!message || !Array.isArray(message.content)) return message
    const result = rewriteImagesDeep(message.content, (block) => {
      const attachment = block.attachment || {}
      const id = attachment.attachmentId || attachment.id || 'unknown'
      return { type: 'text', text: imageMarker(id) }
    })
    if (result.changed) changed = true
    return result.changed ? { ...message, content: result.content } : message
  })
  return changed ? rewritten : messages
}

function configView(value, state) {
  if (!isObject(value)) return value
  return new Proxy(value, {
    get(target, property, receiver) {
      // Temporary boot-only projection retained until the tool-definition and
      // execution gates are split in the next refactor step.
      if (property === 'tool' && state.runtimeStarted !== true) return true

      const policy = imageTurn.getStore()?.policy
      if (policy?.suppressCoreRewrite === true) {
        if (property === 'rewriteImages') return false
        if (property === 'instantDescribe') return policy.instantDescribe
        if (property === 'autoActivateOnImage') return policy.autoActivateOnImage
      }
      const result = Reflect.get(target, property, receiver)
      return typeof result === 'function' ? result.bind(target) : result
    },
  })
}

function settingsScopeView(scope, state) {
  if (!isObject(scope)) return scope
  return new Proxy(scope, {
    get(target, property, receiver) {
      if (property === 'get') {
        const get = Reflect.get(target, property, target)
        if (typeof get !== 'function') return get
        return (...args) => {
          const value = get.apply(target, args)
          if (isObject(value)) state.liveConfig = value
          return configView(value, state)
        }
      }
      if (property === 'watch') {
        const watch = Reflect.get(target, property, target)
        if (typeof watch !== 'function') return watch
        return (callback, ...rest) => watch.call(target, (...args) => {
          try {
            const get = Reflect.get(target, 'get', target)
            if (typeof get === 'function') {
              const value = get.call(target)
              if (isObject(value)) state.liveConfig = value
            }
          } catch {
            // Core can continue from the last known live config.
          }
          return typeof callback === 'function' ? callback(...args) : undefined
        }, ...rest)
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function settingsServiceView(settings, state) {
  if (!isObject(settings)) return settings
  return new Proxy(settings, {
    get(target, property, receiver) {
      if (property === 'register') {
        const register = Reflect.get(target, property, target)
        if (typeof register !== 'function') return register
        return (namespace, ...args) => {
          const scope = register.call(target, namespace, ...args)
          if (namespace !== 'vision-router') return scope
          try {
            const value = typeof scope?.get === 'function' ? scope.get() : undefined
            if (isObject(value)) state.liveConfig = value
          } catch {
            // Late settings are allowed; boot config remains the fallback.
          }
          return settingsScopeView(scope, state)
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function injectedContextView(child, state) {
  if (!isObject(child)) return child
  const settings = settingsServiceView(child.settings, state)
  return new Proxy(child, {
    get(target, property, receiver) {
      if (property === 'settings') return settings
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function routeList(routes) {
  const list = Array.isArray(routes) ? routes : [routes]
  return list
    .map((route) => (typeof route === 'string' ? route : String(route ?? '')))
    .filter((route) => route !== '')
}

function activateRegistration(state, routes, adapter) {
  const record = {
    adapter,
    active: true,
    routes: new Set(routeList(routes)),
  }
  if (isWeakKey(adapter)) state.ownedAdapters.add(adapter)
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

function llmView(llm, state) {
  if (!isObject(llm)) return llm
  const cached = state.llmCache.get(llm)
  if (cached) return cached
  const wrapped = new Proxy(llm, {
    get(target, property, receiver) {
      if (property !== 'registerAdapter') {
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const register = Reflect.get(target, property, target)
      if (typeof register !== 'function') return register
      return (routes, adapter, ...rest) => {
        // Ownership is recorded only after DSH accepts the registration. A
        // thrown registration therefore cannot leave stale global state.
        const handle = register.call(target, routes, adapter, ...rest)
        const record = activateRegistration(state, routes, adapter)
        return wrapRegistrationHandle(handle, state, record)
      }
    },
  })
  state.llmCache.set(llm, wrapped)
  return wrapped
}

function toolsView(tools, ctx, fallbackConfig, state) {
  if (!isObject(tools)) return tools
  const cached = state.toolsCache.get(tools)
  if (cached) return cached
  const wrapped = new Proxy(tools, {
    get(target, property, receiver) {
      if (property !== 'register') {
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const register = Reflect.get(target, property, target)
      if (typeof register !== 'function') return register
      return (definition, ...rest) => {
        if (
          !definition ||
          typeof definition.name !== 'string' ||
          !definition.name.startsWith('vision_') ||
          typeof definition.execute !== 'function'
        ) {
          return register.call(target, definition, ...rest)
        }
        const execute = definition.execute
        return register.call(target, {
          ...definition,
          async execute(args, exec) {
            const live = liveVisionRouterConfig(ctx, fallbackConfig, state)
            if (live?.tool === false) {
              throw new Error(`${definition.name}: vision tools are disabled in the Vision Router settings`)
            }
            return execute.call(this, args, exec)
          },
        }, ...rest)
      }
    },
  })
  state.toolsCache.set(tools, wrapped)
  return wrapped
}

/**
 * Wrap only Vision Router's private context/config view.
 */
export function contextWithNativeImageCoexistence(ctx, config = {}) {
  if (!isObject(ctx)) return { ctx, config }
  const state = {
    runtimeStarted: false,
    liveConfig: undefined,
    sessionRoutes: new WeakMap(),
    ownedAdapters: new WeakSet(),
    activeRegistrations: new Map(),
    adapterCapabilities: new WeakMap(),
    llmCache: new WeakMap(),
    toolsCache: new WeakMap(),
  }
  const wrappedConfig = configView(config, state)
  const wrappedCtx = new Proxy(ctx, {
    get(target, property, receiver) {
      if (property === 'llm') {
        return llmView(Reflect.get(target, property, target), state)
      }
      if (property === 'tools') {
        return toolsView(Reflect.get(target, property, target), target, config, state)
      }
      if (property === 'on') {
        const on = Reflect.get(target, property, target)
        if (typeof on !== 'function') return on
        return (event, handler, ...rest) => {
          if (event !== 'agent/pre-step' || typeof handler !== 'function') {
            return on.call(target, event, handler, ...rest)
          }
          return on.call(target, event, async function imageOwnershipAwarePreStep(payload, next) {
            state.runtimeStarted = true
            const policy = await resolveSessionVisionPolicy(
              target,
              payload?.agent?.session,
              config,
              { agent: payload?.agent, state },
            )
            return imageTurn.run({ policy }, async () => {
              const result = await handler.call(this, payload, next)
              // This compatibility bridge is intentionally temporary. The next
              // refactor step moves nested-content traversal into core so core
              // becomes the sole image-history writer.
              if (!policy.bridgeTextOnlyImages) return result
              if (!isObject(result) || !Array.isArray(result.messages)) return result
              const messages = rewriteTextOnlyMessages(result.messages)
              return messages === result.messages ? result : { ...result, messages }
            })
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
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { ctx: wrappedCtx, config: wrappedConfig }
}
