import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Per-turn image ownership for DSH 0.1.1+.
 *
 * One image turn must have exactly one owner:
 * - vision-router-owned: one of this plugin's wrapper/chain/twin adapters owns
 *   the image contract and decides whether to preserve pixels or bridge them;
 * - native-image: the selected Host model explicitly accepts image input;
 * - text-only: the selected Host model explicitly does not accept images;
 * - unknown: metadata could not be resolved, so we fail safe like text-only.
 *
 * Keeping this decision in one AsyncLocalStorage scope prevents the old split
 * brain where a global "some wrapper exists" flag suppressed rewriting for an
 * unrelated text-only session while another path independently detected native
 * multimodality.
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

function liveVisionRouterConfig(ctx, fallback, state) {
  if (isObject(state?.liveConfig)) return state.liveConfig
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    return isObject(value) ? value : fallback
  } catch {
    return fallback
  }
}

function knownPluginOwnedRoute(provider, config = {}) {
  const wrapper = typeof config.wrapperRoute === 'string' && config.wrapperRoute !== ''
    ? config.wrapperRoute
    : 'deepseek-vision'
  const chain = typeof config.chainRoute === 'string' && config.chainRoute !== ''
    ? config.chainRoute
    : 'vision-chain'
  if (provider === wrapper || provider === chain || provider === 'vision-http') return true
  // Compatibility fallback for routes created before this boundary was
  // installed. New registrations are tracked exactly in state.ownedRoutes.
  if (typeof provider === 'string' && provider.endsWith('-vision')) return true
  if (config.stealth === true && provider === 'deepseek-official') return true
  return false
}

/**
 * Resolve the selected session route to one image owner. Unknown metadata is
 * deliberately NOT treated as native image support: leaking pixels into an
 * adapter that may be text-only is worse than presenting a queryable marker.
 */
export async function classifySessionImageOwnership(
  ctx,
  session,
  fallbackConfig = {},
  ownedRoutes,
) {
  const route = sessionRoute(session)
  if (route === undefined) return IMAGE_OWNERSHIP.UNKNOWN
  const config = liveVisionRouterConfig(ctx, fallbackConfig)
  if (ownedRoutes?.has(route.provider) || knownPluginOwnedRoute(route.provider, config)) {
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
  return `[attached image: ${id}] The current model cannot see images. To examine it, call vision_describe with attachmentIds: ["${id}"] and a specific question.`
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
      // Tool definitions must be constructed regardless of the persisted
      // runtime toggle. Once the first real turn starts, the core sees the
      // actual live value again. Execution itself is guarded separately below.
      if (property === 'tool' && state.runtimeStarted !== true) return true

      const ownership = imageTurn.getStore()?.ownership
      if (ownership === IMAGE_OWNERSHIP.NATIVE) {
        if (property === 'rewriteImages' || property === 'instantDescribe') return false
        // Native models already see the pixels. Suppress only the generic
        // convenience auto-mount; an explicitly enabled structured 1+x flow
        // still calls activateDeepTools through its own bootstrap path.
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
            // The core can continue from the last known live config.
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
            // Late settings are allowed; the boot config remains the fallback.
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

function llmView(llm, state) {
  if (!isObject(llm)) return llm
  const cached = state.llmCache.get(llm)
  if (cached) return cached
  const wrapped = new Proxy(llm, {
    get(target, property, receiver) {
      if (property === 'registerAdapter') {
        const register = Reflect.get(target, property, target)
        if (typeof register !== 'function') return register
        return (routes, adapter, ...rest) => {
          // Mark routes only after registration succeeds. A duplicate owned by
          // another layer must never be misclassified as Vision Router-owned.
          const handle = register.call(target, routes, adapter, ...rest)
          const list = Array.isArray(routes) ? routes : [routes]
          for (const route of list) {
            if (typeof route === 'string' && route !== '') state.ownedRoutes.add(route)
          }
          return handle
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
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
 * The boot phase deliberately exposes `tool: true` so the tool schema can be
 * constructed even when the persisted toggle is off. The first real pre-step
 * flips `runtimeStarted`; from that point every policy read uses the actual
 * live setting, while every registered vision tool has a centralized runtime
 * permission guard. This makes false -> true work without a restart and avoids
 * true -> false schema churn.
 */
export function contextWithNativeImageCoexistence(ctx, config = {}) {
  if (!isObject(ctx)) return { ctx, config }
  const state = {
    runtimeStarted: false,
    liveConfig: undefined,
    ownedRoutes: new Set(),
    llmCache: new WeakMap(),
    toolsCache: new WeakMap(),
  }
  const wrappedConfig = configView(config, state)
  let wrappedCtx
  wrappedCtx = new Proxy(ctx, {
    get(target, property, receiver) {
      if (property === 'llm') return llmView(Reflect.get(target, property, target), state)
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
              state.ownedRoutes,
            )
            return imageTurn.run({ ownership }, async () => {
              const result = await handler.call(this, payload, next)
              if (
                ownership !== IMAGE_OWNERSHIP.TEXT_ONLY &&
                ownership !== IMAGE_OWNERSHIP.UNKNOWN
              ) {
                return result
              }
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
