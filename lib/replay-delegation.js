import { AsyncLocalStorage } from 'node:async_hooks'
import { normalizeRuntimeVisionConfig } from './runtime-config-normalizer.js'

const wrappedContexts = new WeakMap()
const wrapperDelegateScope = new AsyncLocalStorage()
const visionToolScope = new AsyncLocalStorage()
// One shared adapter object can legitimately be registered into more than one
// DSH Context. The wrapper closes over ctx, so cache by BOTH identities; an
// adapter-only cache leaks the first context's settings/catalog into the next.
const dynamicWrapperAdapters = new WeakMap()

const NATIVE_DEEPSEEK_ROUTE = 'deepseek-official-native'
const OFFICIAL_DEEPSEEK_ROUTE = 'deepseek-official'
const VISION_HTTP_ROUTE = 'vision-http'
const MAIN_WRAPPER_MODEL_IDS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash'])

// One entry per (sessionId, provider, model) tuple: a long-running dsh web
// process would otherwise grow the reasoning-effort memory without bound as
// sessions come and go. Evict the oldest entry first; reads refresh recency
// so live sessions survive the cap.
export const MAX_LIVE_EFFORT_MEMORY = 512

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function visionRouterSettings(ctx) {
  try {
    const settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : undefined
    return settings && typeof settings.get === 'function' ? settings.get('vision-router') : undefined
  } catch {
    return undefined
  }
}

function currentWrapperRoute(ctx, fallbackRoute) {
  const route = visionRouterSettings(ctx)?.wrapperRoute
  return isNonEmptyString(route) ? route : fallbackRoute
}

function nativeDeepSeekActive(ctx) {
  try {
    return ctx?.llm?.registration(NATIVE_DEEPSEEK_ROUTE) !== undefined
  } catch {
    return false
  }
}

/**
 * Hard identity invariant for the special "DeepSeek + 自动识图" route.
 *
 * This route is not a generic text-provider alias. A stale/advanced
 * `textProvider` setting must never make a row labelled DeepSeek spend quota on
 * Kimi/OpenRouter/another relay. Third-party providers get their own
 * `<provider>-vision` twins and remain available when the user selects those
 * rows explicitly.
 */
function mainWrapperDelegateProvider(ctx) {
  return nativeDeepSeekActive(ctx) ? NATIVE_DEEPSEEK_ROUTE : OFFICIAL_DEEPSEEK_ROUTE
}

function effectiveVisionConfig(ctx, fallbackConfig) {
  const live = visionRouterSettings(ctx)
  return live && typeof live === 'object'
    ? live
    : fallbackConfig && typeof fallbackConfig === 'object'
      ? fallbackConfig
      : {}
}

/**
 * Exact adapter-backed models the user authorized as Vision Router backends.
 * Merely configuring a provider in DSH Settings -> Models is intentionally NOT
 * authorization for vision tools to call it.
 *
 * `vision-http` is omitted here because its direct/local/built-in fallbacks are
 * owned and authorized by Vision Router's own HTTP/local settings, not by the
 * host LLM registry.
 */
export function configuredVisionAdapterModels(config = {}) {
  config = normalizeRuntimeVisionConfig(config)
  const allowed = new Map()
  const add = (provider, model) => {
    if (!isNonEmptyString(provider) || provider === VISION_HTTP_ROUTE || !isNonEmptyString(model)) return
    let models = allowed.get(provider)
    if (models === undefined) {
      models = new Set()
      allowed.set(provider, models)
    }
    models.add(model)
  }

  let usedRows = false
  if (Array.isArray(config.providers)) {
    for (const entry of config.providers) {
      if (!entry || !isNonEmptyString(entry.provider) || !isNonEmptyString(entry.model)) continue
      usedRows = true
      add(entry.provider, entry.model)
      for (const fallback of entry.fallbacks) add(entry.provider, fallback)
    }
  }

  // Legacy single-provider shape is consulted only when no usable row exists,
  // matching providersOf() in the core implementation.
  if (!usedRows) {
    const provider = isNonEmptyString(config.provider) ? config.provider : VISION_HTTP_ROUTE
    if (isNonEmptyString(config.model)) add(provider, config.model)
    for (const fallback of config.fallbacks) add(provider, fallback)
  }
  return allowed
}

function visionAuthorizationScope(ctx, fallbackConfig) {
  const configured = configuredVisionAdapterModels(effectiveVisionConfig(ctx, fallbackConfig))
  // Clone the sets so a settings mutation cannot expand permission halfway
  // through one already-running tool/fallback walk.
  const allowed = new Map(
    [...configured.entries()].map(([provider, models]) => [provider, new Set(models)]),
  )
  return { allowed }
}

function visionBackendAllowed(scope, provider, model) {
  if (!scope || provider === VISION_HTTP_ROUTE) return true
  if (!isNonEmptyString(provider) || !isNonEmptyString(model)) return false
  return scope.allowed.get(provider)?.has(model) === true
}

function unauthorizedVisionBackendError(provider, model) {
  const error = new Error(
    `vision-router: blocked unconfigured vision backend "${String(provider)}/${String(model)}"; ` +
      'configure this exact provider/model in Vision Router before a vision tool may call it',
  )
  // NO_ADAPTER is deliberate: the core classifies it as a hard structural
  // denial, so callVisionPairWithOptionalBridge cannot bypass this boundary by
  // retrying the same unauthorized model through a direct HTTP bridge.
  error.code = 'NO_ADAPTER'
  return error
}

function explicitReasoningEffort(options) {
  return isNonEmptyString(options?.reasoningEffort) ? options.reasoningEffort : undefined
}

function sessionIdentity(options) {
  const value = options?.sessionId
  return value === undefined || value === null || String(value) === '' ? undefined : String(value)
}

function withoutReasoningEffort(options) {
  if (!options || !Object.prototype.hasOwnProperty.call(options, 'reasoningEffort')) return options
  const { reasoningEffort: _reasoningEffort, ...rest } = options
  return rest
}

async function mainWrapperModels(ctx, fallbackWrapperRoute) {
  // When the hidden native route is active the public stock DeepSeek row owns
  // the picker and the legacy wrapper is intentionally hidden.
  if (nativeDeepSeekActive(ctx)) return []
  let registration
  try {
    registration = ctx?.llm?.registration(OFFICIAL_DEEPSEEK_ROUTE)
  } catch {
    return []
  }
  const adapter = registration && registration.adapter
  if (!adapter || typeof adapter.listModels !== 'function') return []
  try {
    const listed = await adapter.listModels(OFFICIAL_DEEPSEEK_ROUTE)
    const route = currentWrapperRoute(ctx, fallbackWrapperRoute)
    return (Array.isArray(listed) ? listed : [])
      .filter((model) => model && MAIN_WRAPPER_MODEL_IDS.has(model.id))
      .map((model) => ({
        ...model,
        provider: route,
        inputModalities: ['text', 'image'],
      }))
  } catch {
    return []
  }
}

async function mainWrapperModel(ctx, fallbackWrapperRoute, model, signal) {
  // Composite legacy vision-chain entries are not DeepSeek models; leave them
  // to the core wrapper's existing resolver.
  if (!MAIN_WRAPPER_MODEL_IDS.has(model) || nativeDeepSeekActive(ctx)) return undefined
  let registration
  try {
    registration = ctx?.llm?.registration(OFFICIAL_DEEPSEEK_ROUTE)
  } catch {
    return undefined
  }
  const adapter = registration && registration.adapter
  if (!adapter || typeof adapter.resolveModel !== 'function') return undefined
  const base = await adapter.resolveModel(OFFICIAL_DEEPSEEK_ROUTE, model, signal)
  return {
    ...base,
    provider: currentWrapperRoute(ctx, fallbackWrapperRoute),
    inputModalities: ['text', 'image'],
  }
}

function dynamicWrapperAdapter(adapter, ctx, fallbackWrapperRoute) {
  if (!adapter || (typeof adapter !== 'object' && typeof adapter !== 'function')) return adapter
  let byContext = dynamicWrapperAdapters.get(adapter)
  if (byContext === undefined) {
    byContext = new WeakMap()
    dynamicWrapperAdapters.set(adapter, byContext)
  }
  const cached = byContext.get(ctx)
  if (cached) return cached

  const stream = adapter.stream
  if (typeof stream !== 'function') return adapter
  const wrapped = new Proxy(adapter, {
    get(target, property) {
      if (property === 'stream') {
        return async function* (options) {
          const store = {
            pendingDelegate: true,
            explicitEffort: explicitReasoningEffort(options),
            sessionId: sessionIdentity(options),
          }
          const iterable = stream.call(target, options)
          const iterator = iterable[Symbol.asyncIterator]()
          let finished = false
          try {
            while (true) {
              const step = await wrapperDelegateScope.run(store, () => iterator.next())
              if (step.done) {
                finished = true
                return step.value
              }
              yield step.value
            }
          } finally {
            if (!finished && typeof iterator.return === 'function') {
              await wrapperDelegateScope.run(store, () => iterator.return())
            }
          }
        }
      }
      if (property === 'listModels') {
        const original = Reflect.get(target, property, target)
        return async function (...args) {
          const pinned = await mainWrapperModels(ctx, fallbackWrapperRoute)
          if (typeof original !== 'function') return pinned
          const route = currentWrapperRoute(ctx, fallbackWrapperRoute)
          let composites = []
          try {
            const listed = await original.apply(target, args)
            if (Array.isArray(listed)) {
              // Restore ONLY the core's config-driven composite vision rows
              // ("provider/model（视觉）", published when whole-turn routing is
              // enabled) so the legacy routing mode keeps its picker entries.
              // These rows are structurally composite ids (`provider/model`);
              // any DeepSeek mirror — and any other row the core might emit —
              // is dropped here: normal DeepSeek models must keep coming from
              // the pinned official/native identity above, never from the
              // possibly-stale textProvider.
              composites = listed.filter(
                (row) => row
                  && row.provider === route
                  && !MAIN_WRAPPER_MODEL_IDS.has(row.id)
                  && String(row.id ?? '').includes('/'),
              )
            }
          } catch {
            /* the pinned DeepSeek rows still return */
          }
          return [...pinned, ...composites]
        }
      }
      if (property === 'resolveModel') {
        const resolve = Reflect.get(target, property, target)
        if (typeof resolve !== 'function') return resolve
        return async function (provider, model, signal) {
          const fixed = await mainWrapperModel(ctx, fallbackWrapperRoute, model, signal)
          return fixed === undefined ? resolve.call(target, provider, model, signal) : fixed
        }
      }
      if (property === 'providerRetryPolicy') {
        return function () {
          try {
            return ctx?.llm?.registration(mainWrapperDelegateProvider(ctx))?.retryPolicy
          } catch {
            return undefined
          }
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  byContext.set(ctx, wrapped)
  return wrapped
}

/**
 * Rebind assistant source identity only when replay metadata proves that the
 * response was produced by the provider currently receiving this delegated
 * call. Vision Router wrapper routes persist their public route as
 * source.provider while the adapter-owned replayState keeps the real delegate
 * provider. DSH otherwise treats that state as foreign and strips it before
 * the delegate adapter can replay reasoning/tool metadata.
 */
export function rebindDelegatedReplaySources(messages, delegateProvider) {
  if (!Array.isArray(messages) || !isNonEmptyString(delegateProvider)) return messages

  let changed = false
  const rebound = messages.map((message) => {
    if (!message || message.role !== 'assistant') return message
    const source = message.source
    if (!source || source.kind !== 'model') return message
    if (!isNonEmptyString(source.provider) || source.provider === delegateProvider) return message
    if (!isNonEmptyString(source.model)) return message

    const replayState = source.replayState
    if (!replayState || typeof replayState !== 'object' || Array.isArray(replayState)) return message
    if (replayState.provider !== delegateProvider || replayState.model !== source.model) return message

    changed = true
    return {
      ...message,
      source: {
        ...source,
        provider: delegateProvider,
      },
    }
  })

  return changed ? rebound : messages
}

export function rebindDelegatedReplayOptions(options) {
  if (!options || typeof options !== 'object') return options
  const messages = rebindDelegatedReplaySources(options.messages, options.provider)
  return messages === options.messages ? options : { ...options, messages }
}

function llmWithDelegatedReplay(llm, ctx, fallbackWrapperRoute) {
  if (!llm || (typeof llm !== 'object' && typeof llm !== 'function')) return llm

  // DSH stamps sessionId on loop-built GenerateOptions. Keep reasoning memory
  // inside that session boundary so two chats using the same provider/model
  // cannot overwrite each other's picker state. Hand-built one-shots without a
  // sessionId deliberately get no cross-call memory.
  const liveReasoningEffort = new Map()
  const rememberLiveEffort = (key, value) => {
    if (liveReasoningEffort.size >= MAX_LIVE_EFFORT_MEMORY && !liveReasoningEffort.has(key)) {
      const oldest = liveReasoningEffort.keys().next().value
      liveReasoningEffort.delete(oldest)
    }
    liveReasoningEffort.set(key, value)
  }
  const recallLiveEffort = (key) => {
    if (!liveReasoningEffort.has(key)) return undefined
    const value = liveReasoningEffort.get(key)
    // Refresh recency: hot sessions must survive the cap.
    liveReasoningEffort.delete(key)
    liveReasoningEffort.set(key, value)
    return value
  }

  const wrapped = new Proxy(llm, {
    get(target, property) {
      if (property === 'registerAdapter') {
        const register = Reflect.get(target, property, target)
        if (typeof register !== 'function') return register
        return (providers, adapter) => {
          const route = currentWrapperRoute(ctx, fallbackWrapperRoute)
          const isMainWrapper =
            isNonEmptyString(route) &&
            Array.isArray(providers) &&
            providers.length === 1 &&
            providers[0] === route
          return register.call(
            target,
            providers,
            isMainWrapper ? dynamicWrapperAdapter(adapter, ctx, fallbackWrapperRoute) : adapter,
          )
        }
      }
      if (property === 'listProviders') {
        const list = Reflect.get(target, property, target)
        if (typeof list !== 'function') return list
        return (...args) => {
          // Critical authorization boundary: during a vision tool call the
          // core's capability scanner must not see the host-wide DSH model
          // catalog. Explicit configured pairs are already added separately by
          // resolveToolVisionPairs(); returning an empty discovery view removes
          // implicit paid fallbacks while the normal UI/catalog view outside a
          // tool remains untouched.
          if (visionToolScope.getStore() !== undefined) return []
          return list.apply(target, args)
        }
      }
      if (property === 'stream') {
        const stream = Reflect.get(target, property, target)
        if (typeof stream !== 'function') return stream
        return (options) => {
          let routed = options
          const delegateStore = wrapperDelegateScope.getStore()
          if (delegateStore?.pendingDelegate === true && options && typeof options === 'object') {
            // Consume exactly one nested llm.stream call: this is the delegate
            // dispatch made by the special main wrapper. Its identity is fixed
            // to DeepSeek; `textProvider` is not permission to silently change
            // the provider behind a row labelled DeepSeek.
            delegateStore.pendingDelegate = false
            const provider = mainWrapperDelegateProvider(ctx)
            const model = options.model ?? ''
            const sessionId = delegateStore.sessionId
            const effortKey = sessionId === undefined ? undefined : `${sessionId}\u0000${provider}\u0000${model}`
            const explicit = delegateStore.explicitEffort
            if (explicit !== undefined) {
              if (effortKey !== undefined) rememberLiveEffort(effortKey, explicit)
              routed = { ...options, provider, reasoningEffort: explicit }
            } else {
              const remembered = effortKey === undefined ? undefined : recallLiveEffort(effortKey)
              // createWrapperStreamBody still has a legacy provider/model-only
              // cache. Strip its injected value unless this session has proved
              // its own picker state, preventing cross-session contamination.
              routed = remembered === undefined
                ? { ...withoutReasoningEffort(options), provider }
                : { ...options, provider, reasoningEffort: remembered }
            }
          }

          // Defense in depth: even if a future refactor accidentally re-adds a
          // host-wide model to resolveToolVisionPairs(), the actual network
          // dispatch is denied unless this exact adapter-backed provider/model
          // was selected in Vision Router at the start of this tool call.
          const visionScope = visionToolScope.getStore()
          if (
            visionScope !== undefined &&
            routed &&
            typeof routed === 'object' &&
            !visionBackendAllowed(visionScope, routed.provider, routed.model)
          ) {
            throw unauthorizedVisionBackendError(routed.provider, routed.model)
          }
          return stream.call(target, rebindDelegatedReplayOptions(routed))
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return wrapped
}

function toolsWithVisionAuthorization(tools, ctx, fallbackConfig) {
  if (!tools || (typeof tools !== 'object' && typeof tools !== 'function')) return tools
  const wrappedToolDefinitions = new WeakMap()
  return new Proxy(tools, {
    get(target, property) {
      if (property === 'register') {
        const register = Reflect.get(target, property, target)
        if (typeof register !== 'function') return register
        return (definition, ...rest) => {
          if (
            !definition ||
            typeof definition !== 'object' ||
            !isNonEmptyString(definition.name) ||
            !definition.name.startsWith('vision_') ||
            typeof definition.execute !== 'function'
          ) {
            return register.call(target, definition, ...rest)
          }
          let wrappedDefinition = wrappedToolDefinitions.get(definition)
          if (wrappedDefinition === undefined) {
            const execute = definition.execute
            wrappedDefinition = {
              ...definition,
              execute(...args) {
                const scope = visionAuthorizationScope(ctx, fallbackConfig)
                return visionToolScope.run(scope, () => execute.apply(definition, args))
              },
            }
            wrappedToolDefinitions.set(definition, wrappedDefinition)
          }
          return register.call(target, wrappedDefinition, ...rest)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * Give Vision Router a private context view whose llm.stream preserves replay
 * identity across wrapper -> delegate calls. The host service itself is never
 * mutated, so unrelated plugins and direct DSH calls keep their native rules.
 *
 * The private view also owns two safety boundaries:
 * - the special DeepSeek + 自动识图 wrapper always delegates to official/native
 *   DeepSeek, never to a stale arbitrary `textProvider`;
 * - vision tools may call only adapter-backed models explicitly selected in
 *   Vision Router. The host-wide DSH model catalog remains visible to UI
 *   discovery outside tool execution but cannot become an implicit fallback.
 */
export function contextWithDelegatedReplay(ctx, options = {}) {
  if (!ctx || typeof ctx !== 'object') return ctx
  const cached = wrappedContexts.get(ctx)
  if (cached) return cached

  const fallbackWrapperRoute = isNonEmptyString(options.wrapperRoute)
    ? options.wrapperRoute
    : 'deepseek-vision'
  const fallbackVisionConfig =
    options.visionConfig && typeof options.visionConfig === 'object' ? options.visionConfig : {}
  const llm = llmWithDelegatedReplay(ctx.llm, ctx, fallbackWrapperRoute)
  const tools = toolsWithVisionAuthorization(ctx.tools, ctx, fallbackVisionConfig)
  const wrapped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'llm') return llm
      if (property === 'tools') return tools
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  wrappedContexts.set(ctx, wrapped)
  try {
    ctx.effect?.(
      () => () => {
        if (wrappedContexts.get(ctx) === wrapped) wrappedContexts.delete(ctx)
      },
      'vision-router: delegated replay context lifecycle',
    )
  } catch {
    /* lifecycle hardening must not block plugin apply */
  }
  return wrapped
}
