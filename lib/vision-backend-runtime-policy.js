import { AsyncLocalStorage } from 'node:async_hooks'

const visionBackendScope = new AsyncLocalStorage()
const wrappedContexts = new WeakMap()
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_TASK_TIMEOUT_MS = 120_000
const FALLBACK_RESERVE_FRACTION = 0.25

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function positiveMs(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function currentConfig(ctx, fallback) {
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    return isObject(value) ? value : fallback
  } catch {
    return fallback
  }
}

function configuredPairKeys(config = {}) {
  const keys = new Set()
  if (Array.isArray(config.providers)) {
    for (const entry of config.providers) {
      if (!entry || typeof entry.provider !== 'string' || typeof entry.model !== 'string') continue
      keys.add(`${entry.provider}/${entry.model}`)
      for (const fallback of entry.fallbacks ?? []) {
        if (typeof fallback === 'string' && fallback !== '') keys.add(`${entry.provider}/${fallback}`)
      }
    }
  }
  if (keys.size === 0 && typeof config.provider === 'string' && typeof config.model === 'string') {
    keys.add(`${config.provider}/${config.model}`)
    for (const fallback of config.fallbacks ?? []) {
      if (typeof fallback === 'string' && fallback !== '') keys.add(`${config.provider}/${fallback}`)
    }
  }
  return keys
}

export function hostImageDeliveryFromInfo(info) {
  if (!Array.isArray(info?.inputModalities)) return 'unknown'
  return info.inputModalities.includes('image') ? 'native-image' : 'text-projected'
}

export function adapterAttemptBudgetMs(config = {}, provider = '') {
  const requestBudget = positiveMs(config.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS)
  const taskBudget = positiveMs(config.visionTaskTimeoutMs, DEFAULT_TASK_TIMEOUT_MS)
  const pairs = configuredPairKeys(config)
  const hasFallback = config.freeFallback !== false || pairs.size > 1
  if (!hasFallback || provider === 'vision-http') return requestBudget
  const reserve = Math.max(1_000, Math.floor(taskBudget * FALLBACK_RESERVE_FRACTION))
  return Math.max(1_000, Math.min(requestBudget, taskBudget - reserve))
}

function safeLog(logger, level, ...args) {
  const method = logger && typeof logger[level] === 'function' ? logger[level] : undefined
  if (!method) return
  try { method.apply(logger, args) } catch { /* diagnostics must not affect routing */ }
}

function rawChannelProfileOf(ctx, provider) {
  try {
    const settings = ctx?.get?.('settings')
    const section = settings?.get?.('llm-pi-ai')
    return section?.providers?.[provider]
  } catch {
    return undefined
  }
}

function resolvedChannelProfileOf(llm, provider) {
  try {
    const registration = llm?.registration?.(provider)
    const profiles = registration?.adapter?.config?.profiles?.()
    return typeof profiles?.get === 'function' ? profiles.get(provider) : undefined
  } catch {
    return undefined
  }
}

function bridgePlan(ctx, llm, core, provider, model) {
  if (typeof core?.resolveChannelBridgeTransport !== 'function') {
    return { ok: false, reason: 'bridge transport resolver unavailable' }
  }
  const rawProfile = rawChannelProfileOf(ctx, provider)
  const resolvedProfile = resolvedChannelProfileOf(llm, provider)
  const transport = core.resolveChannelBridgeTransport(rawProfile, resolvedProfile, model)
  const supported = typeof core?.isOpenAIHttpBridgeTransport === 'function'
    ? core.isOpenAIHttpBridgeTransport(transport)
    : transport?.api === 'openai-completions' && /^https?:/.test(String(transport?.baseURL ?? ''))
  if (!supported) {
    return { ok: false, reason: 'no safe OpenAI-compatible HTTP transport', rawProfile, resolvedProfile, transport }
  }
  return { ok: true, rawProfile, resolvedProfile, transport }
}

async function resolveCredential(ctx, plan) {
  const ref = plan?.transport?.apiKeyEnv
  if (typeof ref === 'string' && ref !== '') {
    try {
      const hit = await ctx?.get?.('credentials')?.resolve?.(ref)
      if (typeof hit?.value === 'string' && hit.value !== '') return hit.value
    } catch {
      /* fall through to environment/native auth */
    }
    if (typeof process !== 'undefined' && typeof process.env?.[ref] === 'string' && process.env[ref] !== '') {
      return process.env[ref]
    }
  }
  try {
    const auth = plan?.resolvedProfile?.piProvider?.auth?.apiKey
    if (typeof auth?.resolve === 'function') {
      const hit = await auth.resolve({ credential: undefined })
      if (typeof hit?.auth?.apiKey === 'string' && hit.auth.apiKey !== '') return hit.auth.apiKey
    }
  } catch {
    /* anonymous endpoints are allowed below */
  }
  return undefined
}

function contentHasImage(core, messages) {
  return (messages ?? []).some((message) => {
    if (!Array.isArray(message?.content)) return false
    if (typeof core?.blocksHaveImage === 'function') return core.blocksHaveImage(message.content)
    return message.content.some((block) => block?.type === 'image')
  })
}

async function toOpenAIMessages(ctx, messages) {
  const attachments = ctx?.get?.('attachments')
  if (!attachments || typeof attachments.readImage !== 'function') {
    const error = new Error('vision preflight bridge unavailable: attachment service is not registered')
    error.code = 'VISION_IMAGE_DELIVERY_UNAVAILABLE'
    throw error
  }
  const out = []
  const convertContent = async (content) => {
    const converted = []
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        converted.push({ type: 'text', text: block.text })
        continue
      }
      if (block?.type === 'image' && block.attachment) {
        const stored = await attachments.readImage(block.attachment)
        const mediaType = block.attachment.mediaType || stored?.mediaType || 'image/png'
        const data = Buffer.from(stored.data).toString('base64')
        converted.push({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } })
        continue
      }
      if (block?.type === 'tool-result' && Array.isArray(block.content)) {
        converted.push(...await convertContent(block.content))
      }
    }
    return converted
  }
  for (const message of messages ?? []) {
    if (!message || !Array.isArray(message.content)) continue
    const content = await convertContent(message.content)
    if (content.length === 0) continue
    const role = message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user'
    out.push({ role, content })
  }
  return out
}

async function resolvedHostInfo(llm, call) {
  if (typeof llm?.prepareCall === 'function') {
    try {
      const prepared = await llm.prepareCall(
        { provider: call.provider, model: call.model },
        call.signal,
      )
      if (Array.isArray(prepared?.inputModalities)) {
        return { inputModalities: [...prepared.inputModalities] }
      }
    } catch {
      // Capability lookup is advisory. The ordinary adapter path remains the
      // source of truth when preparation itself cannot describe the model.
    }
  }
  if (typeof llm?.resolveModelInfo === 'function') {
    try { return await llm.resolveModelInfo(call.provider, call.model) } catch { /* unknown */ }
  }
  return undefined
}

function failureStream(message, code = 'VISION_IMAGE_DELIVERY_UNAVAILABLE') {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message, code } },
      }
    },
  }
}

function directStream(ctx, core, plan, call, logger, source) {
  return {
    async *[Symbol.asyncIterator]() {
      const started = Date.now()
      safeLog(
        logger,
        'info',
        'vision-router: vision preflight bridge attempt [%s/%s] source=%s reason=host-text-projection',
        call.provider,
        call.model,
        source,
      )
      try {
        if (typeof core?.callOpenAICompatible !== 'function') {
          throw new Error('vision preflight bridge unavailable: OpenAI-compatible dispatcher is unavailable')
        }
        const apiKey = await resolveCredential(ctx, plan)
        if (typeof plan.transport?.apiKeyEnv === 'string' && plan.transport.apiKeyEnv !== '' && !apiKey) {
          throw new Error('vision preflight bridge unavailable: channel credential could not be resolved')
        }
        const messages = await toOpenAIMessages(ctx, call.messages)
        if (messages.length === 0) {
          throw new Error('vision preflight bridge unavailable: no representable image request content')
        }
        const keyRef = apiKey ? '__vision-router-preflight-channel__' : ''
        const text = await core.callOpenAICompatible(
          {
            name: call.provider,
            baseURL: plan.transport.baseURL,
            model: call.model,
            apiKeyEnv: keyRef,
          },
          messages,
          {
            maxTokens: call.maxTokens ?? 4096,
            signal: call.signal,
            resolveCredential: async (ref) => ref === keyRef ? apiKey : undefined,
          },
        )
        if (text !== '') {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        }
        safeLog(
          logger,
          'info',
          'vision-router: vision backend success [%s/%s] via=preflight-direct-bridge source=%s elapsed=%dms',
          call.provider,
          call.model,
          source,
          Date.now() - started,
        )
        yield { type: 'finish', reason: { kind: 'stop' } }
      } catch (error) {
        safeLog(
          logger,
          'info',
          'vision-router: vision preflight bridge failed [%s/%s] source=%s code=%s detail=%s',
          call.provider,
          call.model,
          source,
          error?.code ?? error?.status ?? error?.name ?? 'ERROR',
          error?.message ?? String(error),
        )
        throw error
      }
    },
  }
}

function llmWithRuntimePolicy(ctx, llm, options) {
  if (!llm || (typeof llm !== 'object' && typeof llm !== 'function')) return llm
  const core = options.core
  const logger = options.logger
  return new Proxy(llm, {
    get(target, property) {
      if (property !== 'stream') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const stream = Reflect.get(target, property, target)
      if (typeof stream !== 'function') return stream
      return (call) => {
        const scope = visionBackendScope.getStore()
        if (!scope || !call || !contentHasImage(core, call.messages)) return stream.call(target, call)
        const provider = typeof call.provider === 'string' ? call.provider : ''
        const model = typeof call.model === 'string' ? call.model : ''
        if (provider === '' || model === '') return stream.call(target, call)
        const config = currentConfig(ctx, options.config ?? {})
        const source = typeof options.evidenceSource === 'function'
          ? options.evidenceSource(provider, model) ?? 'configured'
          : 'configured'
        return {
          async *[Symbol.asyncIterator]() {
            const info = await resolvedHostInfo(target, call)
            const delivery = hostImageDeliveryFromInfo(info)
            const capability = typeof core?.decideVisionBackendCapability === 'function'
              ? core.decideVisionBackendCapability(info, provider, model, config.extraVisionModels)
              : { image: false, inferred: false }
            const explicit = configuredPairKeys(config).has(`${provider}/${model}`)
            if (delivery === 'text-projected' && (capability.image === true || explicit)) {
              const plan = bridgePlan(ctx, target, core, provider, model)
              if (!plan.ok) {
                safeLog(
                  logger,
                  'info',
                  'vision-router: vision preflight blocks text projection [%s/%s] source=%s reason=%s',
                  provider,
                  model,
                  source,
                  plan.reason,
                )
                yield* failureStream(
                  `vision backend ${provider}/${model} is declared text-only by the Host and no safe pixel transport is available`,
                )
                return
              }
              yield* directStream(ctx, core, plan, call, logger, source)
              return
            }

            const attemptBudget = adapterAttemptBudgetMs(config, provider)
            const signal = typeof AbortSignal?.any === 'function'
              ? AbortSignal.any([call.signal, AbortSignal.timeout(attemptBudget)].filter(Boolean))
              : call.signal
            yield* stream.call(target, { ...call, signal })
          },
        }
      }
    },
  })
}

function toolsWithScope(tools) {
  if (!tools || (typeof tools !== 'object' && typeof tools !== 'function')) return tools
  const cache = new WeakMap()
  return new Proxy(tools, {
    get(target, property) {
      if (property !== 'register') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const register = Reflect.get(target, property, target)
      if (typeof register !== 'function') return register
      return (definition, ...rest) => {
        if (!definition || typeof definition.execute !== 'function' || !String(definition.name ?? '').startsWith('vision_')) {
          return register.call(target, definition, ...rest)
        }
        let wrapped = cache.get(definition)
        if (!wrapped) {
          wrapped = {
            ...definition,
            execute(...args) {
              return visionBackendScope.run({ toolName: definition.name }, () => definition.execute.apply(definition, args))
            },
          }
          cache.set(definition, wrapped)
        }
        return register.call(target, wrapped, ...rest)
      }
    },
  })
}

export function contextWithVisionBackendRuntimePolicy(ctx, options = {}) {
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return ctx
  const cached = wrappedContexts.get(ctx)
  if (cached) return cached
  let wrapped
  wrapped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'llm') return llmWithRuntimePolicy(wrapped, target.llm, options)
      if (property === 'tools') return toolsWithScope(target.tools)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const finalContextDecorator = options?.finalContextDecorator
  const result = typeof finalContextDecorator === 'function'
    ? finalContextDecorator(wrapped)
    : wrapped
  wrappedContexts.set(ctx, result)
  return result
}
