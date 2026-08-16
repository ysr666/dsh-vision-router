const wrappedContexts = new WeakMap()
const wrappedLlmServices = new WeakMap()

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
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

function llmWithDelegatedReplay(llm) {
  if (!llm || (typeof llm !== 'object' && typeof llm !== 'function')) return llm
  const cached = wrappedLlmServices.get(llm)
  if (cached) return cached

  const wrapped = new Proxy(llm, {
    get(target, property) {
      if (property === 'stream') {
        const stream = Reflect.get(target, property, target)
        if (typeof stream !== 'function') return stream
        return (options) => stream.call(target, rebindDelegatedReplayOptions(options))
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
 */
export function contextWithDelegatedReplay(ctx) {
  if (!ctx || typeof ctx !== 'object') return ctx
  const cached = wrappedContexts.get(ctx)
  if (cached) return cached

  const llm = llmWithDelegatedReplay(ctx.llm)
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
