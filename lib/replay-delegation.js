import { AsyncLocalStorage } from 'node:async_hooks'

const wrappedContexts = new WeakMap()
const wrappedLlmServices = new WeakMap()
const wrapperDelegateScope = new AsyncLocalStorage()
const dynamicWrapperAdapters = new WeakMap()

const NATIVE_DEEPSEEK_ROUTE = 'deepseek-official-native'

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

function currentTextProvider(ctx, fallbackProvider) {
  // Stealth takeover can become active after the main wrapper was constructed.
  // Its hidden native route is the real delegate in that state; route directly
  // to it rather than bouncing through the public DeepSeek wrapper.
  if (fallbackProvider === NATIVE_DEEPSEEK_ROUTE || nativeDeepSeekActive(ctx)) {
    return NATIVE_DEEPSEEK_ROUTE
  }
  const provider = visionRouterSettings(ctx)?.textProvider?.provider
  return isNonEmptyString(provider) ? provider : fallbackProvider
}

function explicitReasoningEffort(options) {
  return isNonEmptyString(options?.reasoningEffort) ? options.reasoningEffort : undefined
}

function withoutReasoningEffort(options) {
  if (!options || !Object.prototype.hasOwnProperty.call(options, 'reasoningEffort')) return options
  const { reasoningEffort: _reasoningEffort, ...rest } = options
  return rest
}

function dynamicWrapperAdapter(adapter) {
  if (!adapter || (typeof adapter !== 'object' && typeof adapter !== 'function')) return adapter
  const cached = dynamicWrapperAdapters.get(adapter)
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
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  dynamicWrapperAdapters.set(adapter, wrapped)
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
  const cached = wrappedLlmServices.get(llm)
  if (cached) return cached

  // The core wrapper remembers reasoning effort by the delegate string it
  // captured at construction time. Once textProvider changes, that key is
  // stale too. Keep a second, entry-layer memory keyed by the provider that is
  // actually receiving the call so an effort selected on one relay never
  // leaks into another relay (and switching back restores that provider's own
  // last explicit choice).
  const liveReasoningEffort = new Map()

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
          return register.call(target, providers, isMainWrapper ? dynamicWrapperAdapter(adapter) : adapter)
        }
      }
      if (property === 'stream') {
        const stream = Reflect.get(target, property, target)
        if (typeof stream !== 'function') return stream
        return (options) => {
          let routed = options
          const store = wrapperDelegateScope.getStore()
          if (store?.pendingDelegate === true && options && typeof options === 'object') {
            // Consume exactly one nested llm.stream call: this is the delegate
            // dispatch made by createWrapperStreamBody. If the chosen target
            // is itself another Vision Router adapter, its own nested calls
            // must keep their explicit provider.
            store.pendingDelegate = false
            const provider = currentTextProvider(ctx, options.provider)
            const effortKey = `${provider}\u0000${options.model ?? ''}`
            const explicit = store.explicitEffort
            if (explicit !== undefined) {
              liveReasoningEffort.set(effortKey, explicit)
              routed = { ...options, provider, reasoningEffort: explicit }
            } else {
              const remembered = liveReasoningEffort.get(effortKey)
              routed = remembered === undefined
                ? { ...withoutReasoningEffort(options), provider }
                : { ...options, provider, reasoningEffort: remembered }
            }
          }
          return stream.call(target, rebindDelegatedReplayOptions(routed))
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  wrappedLlmServices.set(llm, wrapped)
  return wrapped
}

/**
 * Give Vision Router a private context view whose llm.stream preserves replay
 * identity across wrapper -> delegate calls. The host service itself is never
 * mutated, so unrelated plugins and direct DSH calls keep their native rules.
 *
 * The same private view also keeps the special DeepSeek + 自动识图 wrapper's
 * delegate live: the core adapter is constructed before the settings document
 * may switch textProvider to a relay, so this entry-layer boundary resolves
 * that one nested delegate call against the current settings at stream time.
 */
export function contextWithDelegatedReplay(ctx, options = {}) {
  if (!ctx || typeof ctx !== 'object') return ctx
  const cached = wrappedContexts.get(ctx)
  if (cached) return cached

  const fallbackWrapperRoute = isNonEmptyString(options.wrapperRoute)
    ? options.wrapperRoute
    : 'deepseek-vision'
  const llm = llmWithDelegatedReplay(ctx.llm, ctx, fallbackWrapperRoute)
  const wrapped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'llm') return llm
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  wrappedContexts.set(ctx, wrapped)
  return wrapped
}
