import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Per-turn image ownership for DSH 0.1.1+.
 *
 * One image turn has one routing owner:
 * - vision-router-owned: an adapter route registered by Vision Router itself;
 * - native-image: the exact selected Host model declares image input;
 * - text-only: the exact selected Host model explicitly does not accept image;
 * - unknown: the selected route or model capability metadata could not be resolved.
 *
 * The runtime path never infers ownership from a provider-name suffix. Instead,
 * this boundary observes only adapter registrations performed through Vision
 * Router's private context. Host/third-party registrations keep their identity
 * and are classified from the selected model's exact metadata.
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

function routeFrom(value) {
  if (!isObject(value)) return undefined
  const provider = typeof value.provider === 'string' ? value.provider : ''
  const model = typeof value.model === 'string' ? value.model : ''
  return provider !== '' && model !== '' ? { provider, model } : undefined
}

function sessionRoute(session, agent) {
  try {
    const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined
    const direct = routeFrom(header?.config)
    if (direct !== undefined) return direct
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
    if (route !== undefined) return route
  }
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

function stateOwnsRoute(state, provider) {
  if (!state || !(state.ownedRouteCounts instanceof Map)) return false
  return (state.ownedRouteCounts.get(provider) ?? 0) > 0
}

function pluginOwnedRoute(provider, config = {}, state) {
  if (state) return stateOwnsRoute(state, provider)

  // Compatibility fallback for direct helper callers that are not running
  // through contextWithNativeImageCoexistence(). Runtime classification uses
  // the observed-registration state above and therefore never guesses from a
  // generic `*-vision` provider name.
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

/**
 * Resolve the selected session route to one image owner.
 *
 * Unknown metadata is intentionally left UNKNOWN rather than forced through a
 * new rewrite path. Capability discovery can be transient during cold resume;
 * preserving the pre-existing Host/adapter behavior is safer than destroying
 * a native inline image because one metadata lookup briefly failed.
 */
export async function classifySessionImageOwnership(
  ctx,
  session,
  fallbackConfig = {},
  options = {},
) {
  const route = sessionRoute(session, options.agent)
  if (route === undefined) return IMAGE_OWNERSHIP.UNKNOWN
  const config = liveVisionRouterConfig(ctx, fallbackConfig, options.state)
  if (pluginOwnedRoute(route.provider, config, options.state)) {
    return IMAGE_OWNERSHIP.VISION_ROUTER
  }
  try {
    const info = await ctx?.llm?.resolveModelInfo?.(route.provider, route.model)
    if (!info || !Array.isArray(info.inputModalities)) return IMAGE_OWNERSHIP.UNKNOWN
    return info.inputModalities.includes('image')
      ? IMAGE_OWNERSHIP.NATIVE
      : IMAGE_OWNERSHIP.TEXT_ONLY
  } catch {
    return IMAGE_OWNERSHIP.UNKNOWN
  }
}

/** Backwards-compatible helper retained for callers/tests. */
export async function sessionUsesNativeImageModel(ctx, session, fallbackConfig = {}) {
  return (
    await classifySessionImageOwnership(ctx, session, fallbackConfig)
  ) === IMAGE_OWNERSHIP.NATIVE
}

export function currentSessionImageOwnership() {
  return imageTurn.getStore()?.ownership
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

function shouldBridgeTextOnlyImages(config) {
  return config?.rewriteImages !== false && config?.routing !== true
}

function configView(value, state) {
  if (!isObject(value)) return value
  return new Proxy(value, {
    get(target, property, receiver) {
      // Build a stable tool schema independently of the persisted runtime
      // toggle. After the first real turn starts, policy reads return the live
      // value; actual tool executions are guarded centrally below.
      if (property === 'tool' && state.runtimeStarted !== true) return true

      const ownership = imageTurn.getStore()?.ownership
      if (ownership === IMAGE_OWNERSHIP.NATIVE) {
        if (property === 'rewriteImages' || property === 'instantDescribe') return false
        // Native models already see pixels. Suppress the generic convenience
        // auto-mount only; an explicit structured 1+x setting still activates
        // its bootstrap/evidence tools through the dedicated structured path.
        if (property === 'autoActivateOnImage') return false
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

function noteOwnedRoutes(state, routes, delta) {
  for (const route of routeList(routes)) {
    const next = Math.max(0, (state.ownedRouteCounts.get(route) ?? 0) + delta)
    if (next === 0) state.ownedRouteCounts.delete(route)
    else state.ownedRouteCounts.set(route, next)
  }
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
        // Observe ownership only after a successful registration. Do not wrap,
        // clone or tag the adapter: DSH native replay/cold-resume depends on the
        // original registration identity and immutable prepared-call snapshot.
        const handle = register.call(target, routes, adapter, ...rest)
        noteOwnedRoutes(state, routes, 1)
        if (typeof handle !== 'function') return handle
        let active = true
        return (...disposeArgs) => {
          if (!active) return undefined
          active = false
          try {
            return handle(...disposeArgs)
          } finally {
            noteOwnedRoutes(state, routes, -1)
          }
        }
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
 *
 * Tool definitions are always constructible so false -> true works without a
 * restart. Tool execution consults the actual live setting, so true -> false
 * takes effect without unregistering tools or changing the model-visible schema.
 */
export function contextWithNativeImageCoexistence(ctx, config = {}) {
  if (!isObject(ctx)) return { ctx, config }
  const state = {
    runtimeStarted: false,
    liveConfig: undefined,
    ownedRouteCounts: new Map(),
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
            const ownership = await classifySessionImageOwnership(
              target,
              payload?.agent?.session,
              config,
              { agent: payload?.agent, state },
            )
            return imageTurn.run({ ownership }, async () => {
              const result = await handler.call(this, payload, next)
              // Only explicit text-only metadata authorizes the compatibility
              // marker bridge. UNKNOWN retains the Host/adapter contract so a
              // transient catalog miss during cold resume cannot destroy raw
              // native image content.
              if (ownership !== IMAGE_OWNERSHIP.TEXT_ONLY) return result
              const live = liveVisionRouterConfig(target, config, state)
              if (!shouldBridgeTextOnlyImages(live) || !isObject(result) || !Array.isArray(result.messages)) {
                return result
              }
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
