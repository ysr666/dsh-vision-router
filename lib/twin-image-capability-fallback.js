import { AsyncLocalStorage } from 'node:async_hooks'

const TWIN_SUFFIX = '-vision'
const DEFAULT_MAIN_WRAPPER_ROUTE = 'deepseek-vision'
const DEFAULT_CHAIN_ROUTE = 'vision-chain'
const forcedTextBridgeScope = new AsyncLocalStorage()

export const TWIN_IMAGE_CAPABILITY_NEGATIVE_TTL_MS = 60_000
export const MAX_TWIN_IMAGE_CAPABILITY_NEGATIVE_MODELS = 64

function isObject(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function blocksHaveImage(content) {
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (!block) continue
    if (block.type === 'image') return true
    if (Array.isArray(block.content) && blocksHaveImage(block.content)) return true
  }
  return false
}

export function twinRequestHasImage(messages) {
  return (messages ?? []).some(
    (message) => message && Array.isArray(message.content) && blocksHaveImage(message.content),
  )
}

function failureText(failure, seen = new Set()) {
  if (failure === undefined || failure === null) return ''
  if (typeof failure === 'string') return failure
  if (!isObject(failure) || seen.has(failure)) return ''
  seen.add(failure)
  const pieces = []
  for (const key of ['message', 'detail', 'reason', 'error']) {
    const value = failure[key]
    if (typeof value === 'string') pieces.push(value)
    else if (isObject(value)) {
      const nested = failureText(value, seen)
      if (nested !== '') pieces.push(nested)
    }
  }
  if (isObject(failure.cause)) {
    const nested = failureText(failure.cause, seen)
    if (nested !== '') pieces.push(nested)
  }
  return pieces.join(' | ')
}

function failureCodes(failure, seen = new Set(), out = new Set()) {
  if (!isObject(failure) || seen.has(failure)) return out
  seen.add(failure)
  if (typeof failure.code === 'string' && failure.code.trim() !== '') {
    out.add(failure.code.trim().toUpperCase())
  }
  for (const key of ['error', 'cause', 'detail', 'reason']) {
    failureCodes(failure[key], seen, out)
  }
  return out
}

/**
 * True only for an explicit runtime rejection of image input. Generic 400s,
 * max-token errors, auth failures, rate limits and transport errors must never
 * trigger a second model call. Capability prose is deliberately end-bounded:
 * "does not support image inputs larger than ..." describes a size/format
 * restriction, not proof that the model is text-only.
 */
export function isImageInputUnsupportedFailure(failure) {
  const text = failureText(failure)
  const terminal = String.raw`(?:\s*(?:[.!?。！？]|$)|\s*\|)`
  const explicitImageRejection = [
    new RegExp(`does not support (?:images?|image inputs?|image content)${terminal}`, 'i'),
    new RegExp(
      `(?:images?|image inputs?|image content) (?:is|are) not supported(?:\\s+(?:by|for) (?:this|the) (?:model|endpoint))?${terminal}`,
      'i',
    ),
    new RegExp(
      `unsupported (?:images?|image inputs?|image content)(?:\\s+(?:by|for) (?:this|the) (?:model|endpoint))?${terminal}`,
      'i',
    ),
    new RegExp(`cannot (?:accept|process|handle) (?:images?|image inputs?)${terminal}`, 'i'),
    new RegExp(`(?:model|adapter).*text[- ]only.*(?:images?|image inputs?)${terminal}`, 'i'),
    new RegExp(`(?:模型|适配器).*不支持(?:图片|图像)(?:输入)?${terminal}`),
    new RegExp(`(?:图片|图像)输入(?:不被支持|暂不支持|不支持)${terminal}`),
  ].some((pattern) => pattern.test(text))
  if (explicitImageRejection) return true

  const codes = failureCodes(failure)
  return codes.has('MODEL_DOES_NOT_SUPPORT_IMAGES') || codes.has('UNSUPPORTED_IMAGE_INPUT')
}

function chunkFailure(chunk) {
  if (!chunk || typeof chunk !== 'object') return undefined
  if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
    return chunk.reason.failure ?? chunk.reason
  }
  if (chunk.type === 'error') return chunk.failure ?? chunk.error ?? chunk
  return undefined
}

function stripImageCapability(info) {
  if (!info || typeof info !== 'object' || !Array.isArray(info.inputModalities)) return info
  if (!info.inputModalities.includes('image')) return info
  return {
    ...info,
    inputModalities: info.inputModalities.filter((item) => item !== 'image'),
  }
}

function facadeFor(source, overrides = {}) {
  const shell = Object.create(Reflect.getPrototypeOf(source))
  const hasOverride = (property) => Object.prototype.hasOwnProperty.call(overrides, property)
  const read = (target, property) => {
    if (Object.prototype.hasOwnProperty.call(target, property)) {
      return Reflect.get(target, property, target)
    }
    if (hasOverride(property)) return overrides[property]
    const value = Reflect.get(source, property, source)
    return typeof value === 'function' ? value.bind(source) : value
  }
  return new Proxy(shell, {
    get(target, property) {
      return read(target, property)
    },
    has(target, property) {
      return Reflect.has(target, property) || hasOverride(property) || Reflect.has(source, property)
    },
    ownKeys(target) {
      return [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(source), ...Reflect.ownKeys(overrides)])]
    },
    getOwnPropertyDescriptor(target, property) {
      const own = Reflect.getOwnPropertyDescriptor(target, property)
      if (own !== undefined) return own
      if (!hasOverride(property) && !Reflect.has(source, property)) return undefined
      const sourceDescriptor = Reflect.getOwnPropertyDescriptor(source, property)
      return {
        configurable: true,
        enumerable: sourceDescriptor?.enumerable ?? true,
        writable: false,
        value: read(target, property),
      }
    },
  })
}

function proxiedRegistrationWithoutImage(registration, provider, model) {
  if (!registration || !isObject(registration)) return registration
  const adapter = registration.adapter
  if (!adapter || !isObject(adapter) || typeof adapter.resolveModel !== 'function') return registration
  const adapterView = facadeFor(adapter, {
    async resolveModel(requestedProvider, requestedModel, ...rest) {
      const info = await adapter.resolveModel(requestedProvider, requestedModel, ...rest)
      if (requestedProvider !== provider || requestedModel !== model) return info
      return stripImageCapability(info)
    },
  })
  return facadeFor(registration, { adapter: adapterView })
}

async function closeIterator(iterator) {
  if (iterator && typeof iterator.return === 'function') {
    try {
      await iterator.return()
    } catch {
      // The failed attempt is already being abandoned. Cleanup errors must not
      // replace the capability rejection or block the safe bridge retry.
    }
  }
}

/**
 * Private Core-only boundary for generated `<provider>-vision` twins.
 *
 * Catalog metadata remains the optimistic fast path: a genuinely multimodal
 * source still receives raw image blocks exactly as before. If that source
 * explicitly rejects image input before producing any model-visible output,
 * runtime evidence overrides the stale metadata for this request and the same
 * twin is re-entered once under a scoped metadata view with `image` removed.
 * The existing Core wrapper then performs its canonical image -> tool-marker /
 * cached-description projection; this layer never duplicates that logic.
 */
export function contextWithTwinImageCapabilityFallback(ctx, options = {}) {
  if (!ctx || typeof ctx !== 'object' || !ctx.llm) return ctx
  const llm = ctx.llm
  const configuredMainWrapperRoute = nonEmptyString(options.wrapperRoute)
    ? options.wrapperRoute
    : DEFAULT_MAIN_WRAPPER_ROUTE
  const configuredChainRoute = nonEmptyString(options.chainRoute)
    ? options.chainRoute
    : DEFAULT_CHAIN_ROUTE
  const currentOwnedRoutes = () => {
    try {
      const settings = ctx?.get?.('settings')
      const current = settings?.get?.('vision-router')
      if (current && typeof current === 'object' && !Array.isArray(current)) {
        return new Set([
          nonEmptyString(current.wrapperRoute) ? current.wrapperRoute : configuredMainWrapperRoute,
          nonEmptyString(current.chainRoute) ? current.chainRoute : configuredChainRoute,
        ])
      }
    } catch {
      // Settings can be between generations; composition-time routes remain
      // authoritative until the live namespace becomes readable again.
    }
    return new Set([configuredMainWrapperRoute, configuredChainRoute])
  }
  const logger = options.logger ?? ctx.logger
  const ttlMs = Number.isFinite(Number(options.negativeTtlMs)) && Number(options.negativeTtlMs) > 0
    ? Number(options.negativeTtlMs)
    : TWIN_IMAGE_CAPABILITY_NEGATIVE_TTL_MS

  // Runtime rejection is scoped to the exact source adapter + provider/model.
  // One adapter instance may legitimately serve multiple provider routes, so
  // adapter + model alone is not sufficient isolation. A provider reload or
  // adapter replacement clears stale evidence by identity; the short TTL also
  // self-heals an adapter whose capability changes in place.
  const scopeToken = Object.freeze({})
  const rejectedByAdapter = new WeakMap() // source adapter -> Map(provider\0model -> expiresAt)
  const memoFor = (adapter) => {
    if (!isObject(adapter)) return undefined
    let memo = rejectedByAdapter.get(adapter)
    if (memo === undefined) {
      memo = new Map()
      rejectedByAdapter.set(adapter, memo)
    }
    return memo
  }
  const rejectionKey = (provider, model) => `${provider}\u0000${model}`
  const rejectionCached = (adapter, provider, model) => {
    if (!isObject(adapter) || !nonEmptyString(provider) || !nonEmptyString(model)) return false
    const memo = rejectedByAdapter.get(adapter)
    if (memo === undefined) return false
    const now = Date.now()
    for (const [key, expiresAt] of memo) {
      if (expiresAt <= now) memo.delete(key)
    }
    const key = rejectionKey(provider, model)
    const expiresAt = memo.get(key)
    if (expiresAt === undefined) return false
    if (expiresAt <= now) {
      memo.delete(key)
      return false
    }
    // Refresh recency without extending the proof lifetime.
    memo.delete(key)
    memo.set(key, expiresAt)
    return true
  }
  const rememberRejection = (adapter, provider, model) => {
    if (!isObject(adapter) || !nonEmptyString(provider) || !nonEmptyString(model)) return
    const memo = memoFor(adapter)
    if (memo === undefined) return
    const key = rejectionKey(provider, model)
    if (!memo.has(key) && memo.size >= MAX_TWIN_IMAGE_CAPABILITY_NEGATIVE_MODELS) {
      memo.delete(memo.keys().next().value)
    }
    memo.delete(key)
    memo.set(key, Date.now() + ttlMs)
  }

  const sourceRegistration = (sourceProvider) => {
    try {
      return llm.registration(sourceProvider)
    } catch {
      return undefined
    }
  }

  const wrapTwinAdapter = (adapter, sourceProvider) => {
    if (!adapter || !isObject(adapter) || typeof adapter.stream !== 'function') return adapter
    const stream = adapter.stream
    return facadeFor(adapter, {
      async *stream(options = {}) {
        const messages = options.messages ?? []
        if (!twinRequestHasImage(messages)) {
          yield* stream.call(adapter, options)
          return
        }

        const model = nonEmptyString(options.model) ? options.model : ''
        const sourceAdapter = sourceRegistration(sourceProvider)?.adapter
        const forceBridge = async function* () {
          const store = { token: scopeToken, provider: sourceProvider, model }
          const scopedIterator = stream.call(adapter, options)[Symbol.asyncIterator]()
          let scopedFinished = false
          try {
            while (true) {
              const step = await forcedTextBridgeScope.run(store, () => scopedIterator.next())
              if (step.done) {
                scopedFinished = true
                return step.value
              }
              yield step.value
            }
          } finally {
            if (!scopedFinished && typeof scopedIterator.return === 'function') {
              await forcedTextBridgeScope.run(store, () => scopedIterator.return())
            }
          }
        }

        // Once this exact provider/model on this concrete source adapter has
        // disproved its metadata, skip the known-bad raw-image attempt for the
        // short proof lifetime without poisoning sibling routes on that adapter.
        if (rejectionCached(sourceAdapter, sourceProvider, model)) {
          yield* forceBridge()
          return
        }

        const iterator = stream.call(adapter, options)[Symbol.asyncIterator]()
        const bufferedUsage = []
        let committed = false
        let finished = false
        try {
          while (true) {
            let step
            try {
              step = await iterator.next()
            } catch (error) {
              if (
                !committed &&
                !(options.signal && options.signal.aborted) &&
                isImageInputUnsupportedFailure(error)
              ) {
                await closeIterator(iterator)
                finished = true
                rememberRejection(sourceAdapter, sourceProvider, model)
                logger?.warn?.(
                  'vision-router: source %s/%s rejected raw image input despite image-capable metadata; retrying once through the canonical text bridge',
                  sourceProvider,
                  model,
                )
                yield* forceBridge()
                return
              }
              throw error
            }

            if (step.done) {
              finished = true
              for (const usage of bufferedUsage) yield usage
              return step.value
            }

            const chunk = step.value
            const failure = chunkFailure(chunk)
            if (
              !committed &&
              failure !== undefined &&
              !(options.signal && options.signal.aborted) &&
              isImageInputUnsupportedFailure(failure)
            ) {
              await closeIterator(iterator)
              finished = true
              rememberRejection(sourceAdapter, sourceProvider, model)
              logger?.warn?.(
                'vision-router: source %s/%s rejected raw image input despite image-capable metadata; retrying once through the canonical text bridge',
                sourceProvider,
                model,
              )
              yield* forceBridge()
              return
            }

            // Usage before any model-visible block is provisional. Do not
            // publish accounting from a failed pre-validation attempt; flush
            // it unchanged if that attempt actually commits.
            if (!committed && chunk && chunk.type === 'usage') {
              bufferedUsage.push(chunk)
              continue
            }

            if (!committed) {
              committed = true
              for (const usage of bufferedUsage) yield usage
              bufferedUsage.length = 0
            }
            yield chunk
          }
        } finally {
          if (!finished) await closeIterator(iterator)
        }
      },
    })
  }

  const llmProxy = facadeFor(llm, {
    registration(provider, ...rest) {
      const hit = llm.registration(provider, ...rest)
      const scope = forcedTextBridgeScope.getStore()
      if (!scope || scope.token !== scopeToken || provider !== scope.provider) return hit
      return proxiedRegistrationWithoutImage(hit, scope.provider, scope.model)
    },
    registerAdapter(providers, adapter, ...rest) {
      const route = Array.isArray(providers) && providers.length === 1 ? providers[0] : undefined
      const looksLikeGeneratedTwin =
        nonEmptyString(route) &&
        !currentOwnedRoutes().has(route) &&
        route.endsWith(TWIN_SUFFIX) &&
        route.length > TWIN_SUFFIX.length
      if (!looksLikeGeneratedTwin) return llm.registerAdapter(providers, adapter, ...rest)
      const sourceProvider = route.slice(0, -TWIN_SUFFIX.length)
      // This context is private to Core.apply, and Core creates its generated
      // twins as single `<source>-vision` registrations. Do not require the
      // source route to exist *yet*: explicit wrappedProviders are allowed to
      // register before a settings-backed source adapter appears, then delegate
      // lazily once that source is mounted. Main/custom wrapper and chain routes
      // are excluded above, so preserving this lazy lifecycle does not broaden
      // the boundary to other Core-owned registrations.
      return llm.registerAdapter(providers, wrapTwinAdapter(adapter, sourceProvider), ...rest)
    },
  })

  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'llm') return llmProxy
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
