const wrappedContexts = new WeakMap()

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * Read the producer identity from DSH rc.7's durable pi-ai replay envelope.
 *
 * rc.7 stores provider/model below replayState.response; older Vision Router
 * code looked for replayState.provider/model at the top level and therefore
 * failed to prove wrapper -> delegate ownership. Keep this parser deliberately
 * exact so arbitrary plugin replay metadata cannot authorize a source rewrite.
 */
export function replayEnvelopeV2Producer(replayState) {
  if (!isRecord(replayState) || !isRecord(replayState.response)) return undefined
  const response = replayState.response
  if (response.kind !== 'pi-ai' || response.version !== 2) return undefined
  if (!nonEmpty(response.provider) || !nonEmpty(response.model)) return undefined
  return { provider: response.provider, model: response.model }
}

/**
 * Rebind only assistant histories whose rc.7 replay envelope proves that the
 * currently selected delegate provider/model produced the persisted response.
 * The durable replayState object itself is kept by identity.
 */
export function rebindReplayEnvelopeV2Sources(messages, delegateProvider) {
  if (!Array.isArray(messages) || !nonEmpty(delegateProvider)) return messages
  let changed = false
  const rebound = messages.map((message) => {
    if (!isRecord(message) || message.role !== 'assistant') return message
    const source = message.source
    if (!isRecord(source) || source.kind !== 'model') return message
    if (!nonEmpty(source.provider) || source.provider === delegateProvider || !nonEmpty(source.model)) return message
    const producer = replayEnvelopeV2Producer(source.replayState)
    if (producer?.provider !== delegateProvider || producer.model !== source.model) return message
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

export function rebindReplayEnvelopeV2Options(options) {
  if (!isRecord(options)) return options
  const messages = rebindReplayEnvelopeV2Sources(options.messages, options.provider)
  return messages === options.messages ? options : { ...options, messages }
}

/**
 * Private rc.7 compatibility view layered around Vision Router's existing
 * delegated-replay context. It does not mutate the host LLM service; only
 * stream calls made through the plugin-private Context are normalized.
 */
export function contextWithReplayEnvelopeV2Compat(ctx) {
  if (!ctx || typeof ctx !== 'object') return ctx
  const cached = wrappedContexts.get(ctx)
  if (cached) return cached
  const llm = ctx.llm
  if (!llm || (typeof llm !== 'object' && typeof llm !== 'function')) return ctx
  const stream = llm.stream
  if (typeof stream !== 'function') return ctx

  const wrappedLlm = new Proxy(llm, {
    get(target, property) {
      if (property === 'stream') {
        return (options) => stream.call(target, rebindReplayEnvelopeV2Options(options))
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const wrapped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'llm') return wrappedLlm
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
      'vision-router: rc7 replay envelope compatibility lifecycle',
    )
  } catch {
    /* lifecycle hardening must not block plugin apply */
  }
  return wrapped
}
