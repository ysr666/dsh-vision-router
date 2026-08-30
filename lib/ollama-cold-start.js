import { normalizeRuntimeVisionConfig } from './runtime-config-normalizer.js'
import {
  METADATA_RESPONSE_MAX_BYTES,
  readResponseJsonBounded,
} from './http-body-limit.js'
import { stripTrailingSlashes } from './string-normalization.js'

export const OLLAMA_WARMUP_KEEP_ALIVE = '30m'
export const OLLAMA_WARMUP_TIMEOUT_MS = 120000
export const OLLAMA_PROBE_TIMEOUT_MS = 1500

function errorText(error) {
  return error && error.message ? error.message : String(error)
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

/**
 * Convert the configured OpenAI-compatible Ollama base URL into a native API
 * endpoint without losing a reverse-proxy path prefix.
 *
 *   http://127.0.0.1:11434/v1        -> /api/generate
 *   https://host.example/ollama/v1   -> /ollama/api/generate
 */
export function ollamaNativeApiUrl(baseURL, endpoint) {
  let url
  try {
    url = new URL(
      typeof baseURL === 'string' && baseURL !== ''
        ? baseURL
        : 'http://127.0.0.1:11434/v1',
    )
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  let prefix = stripTrailingSlashes(url.pathname)
  if (prefix.endsWith('/v1')) prefix = prefix.slice(0, -3)
  else if (prefix.endsWith('/api')) prefix = prefix.slice(0, -4)
  url.pathname = `${prefix}/api/${endpoint}`.replace(/\/{2,}/g, '/')
  url.search = ''
  url.hash = ''
  return url
}

export function isAutomaticOllamaWarmupAllowed(provider) {
  const url = ollamaNativeApiUrl(provider?.baseURL, 'generate')
  return url !== undefined && isLoopbackHost(url.hostname)
}

function providerKey(provider) {
  const url = ollamaNativeApiUrl(provider?.baseURL, 'generate')
  if (!url || typeof provider?.model !== 'string' || provider.model === '') return undefined
  return `${url.href}\n${provider.model}`
}

function timeoutSignal(ms, controllers) {
  const controller = new AbortController()
  controllers.add(controller)
  const timer = setTimeout(() => controller.abort(new Error('Ollama warmup timed out')), ms)
  return {
    signal: controller.signal,
    release() {
      clearTimeout(timer)
      controllers.delete(controller)
    },
  }
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel?.()
  } catch {
    /* diagnostics-only response */
  }
}

function comparableModelName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  return name.endsWith(':latest') ? name.slice(0, -7) : name
}

function psContainsModel(payload, model) {
  const wanted = comparableModelName(model)
  if (wanted === '' || !Array.isArray(payload?.models)) return false
  return payload.models.some((entry) => {
    const names = [entry?.name, entry?.model]
    return names.some((name) => comparableModelName(name) === wanted)
  })
}

async function readOllamaJson(response, label) {
  return readResponseJsonBounded(response, METADATA_RESPONSE_MAX_BYTES, { label })
}

/**
 * Host-owned Ollama cold-start manager.
 *
 * The short /api/ps probe has two jobs:
 * 1. distinguish an unreachable/hung service from a merely cold model before
 *    granting the long preload allowance;
 * 2. avoid issuing an empty /api/generate on every image turn when the model is
 *    already resident.
 *
 * A cold model is preloaded with Ollama's native empty-generate mechanism and
 * keep_alive=30m. The response body is consumed completely before the manager
 * reports success; fetch resolving after headers alone is not sufficient proof
 * that the model finished loading.
 */
export function createOllamaWarmupManager({
  fetchImpl = (...args) => globalThis.fetch(...args),
  logger,
  probeTimeoutMs = OLLAMA_PROBE_TIMEOUT_MS,
  warmupTimeoutMs = OLLAMA_WARMUP_TIMEOUT_MS,
  keepAlive = OLLAMA_WARMUP_KEEP_ALIVE,
} = {}) {
  const inFlight = new Map()
  const controllers = new Set()
  let disposed = false

  const run = async (provider, reason, forceKeepAlive) => {
    const key = providerKey(provider)
    if (!key || disposed) return { ok: false, skipped: true, reason: 'invalid-or-disposed' }
    if (!isAutomaticOllamaWarmupAllowed(provider)) {
      return { ok: false, skipped: true, reason: 'non-loopback' }
    }

    const generateUrl = ollamaNativeApiUrl(provider.baseURL, 'generate')
    const psUrl = ollamaNativeApiUrl(provider.baseURL, 'ps')
    const startedAt = Date.now()
    let loaded = false

    const probe = timeoutSignal(probeTimeoutMs, controllers)
    try {
      const response = await fetchImpl(psUrl, { method: 'GET', signal: probe.signal })
      if (!response?.ok) {
        await cancelBody(response)
        return { ok: false, reason: `probe-http-${response?.status ?? 'unknown'}` }
      }
      const payload = await readOllamaJson(response, 'Ollama /api/ps response')
      loaded = psContainsModel(payload, provider.model)
      if (loaded && forceKeepAlive !== true) {
        return {
          ok: true,
          alreadyLoaded: true,
          durationMs: Date.now() - startedAt,
          keepAlive,
        }
      }
    } catch (error) {
      return { ok: false, reason: 'probe-failed', error }
    } finally {
      probe.release()
    }

    const warm = timeoutSignal(warmupTimeoutMs, controllers)
    try {
      const response = await fetchImpl(generateUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: provider.model,
          prompt: '',
          stream: false,
          keep_alive: keepAlive,
        }),
        signal: warm.signal,
      })
      if (!response?.ok) {
        await cancelBody(response)
        return { ok: false, reason: `warmup-http-${response?.status ?? 'unknown'}` }
      }
      // Do not cancel a successful preload body. A real HTTP fetch resolves as
      // soon as headers are available, so draining the bounded JSON response is
      // what proves Ollama finished loading the model before the inference
      // deadline is allowed to start.
      await readOllamaJson(response, 'Ollama preload response')
      const durationMs = Date.now() - startedAt
      if (durationMs >= 1000) {
        try {
          logger?.info?.(
            'vision-router: local Ollama warmup ready [%s] reason=%s duration=%dms keep_alive=%s loaded=%s',
            provider.model,
            reason || 'unspecified',
            durationMs,
            keepAlive,
            loaded ? 'yes' : 'no',
          )
        } catch {
          /* diagnostics must not affect warmup */
        }
      }
      return { ok: true, durationMs, keepAlive, renewed: loaded }
    } catch (error) {
      return { ok: false, reason: 'warmup-failed', error }
    } finally {
      warm.release()
    }
  }

  const ensure = (provider, { reason = 'unspecified', forceKeepAlive = false } = {}) => {
    const key = providerKey(provider)
    if (!key || disposed) {
      return Promise.resolve({ ok: false, skipped: true, reason: 'invalid-or-disposed' })
    }
    // Normal cold-load checks and forced residency renewals are separate work
    // classes. Two cold checks coalesce; two renewals coalesce. In ordinary
    // execution renewal only happens after inference, so the two classes do not
    // race each other on the hot path.
    const flightKey = `${key}\n${forceKeepAlive === true ? 'renew' : 'ensure'}`
    const current = inFlight.get(flightKey)
    if (current) return current
    const promise = run(provider, reason, forceKeepAlive === true)
      .catch((error) => ({ ok: false, reason: 'unexpected', error }))
      .finally(() => {
        if (inFlight.get(flightKey) === promise) inFlight.delete(flightKey)
      })
    inFlight.set(flightKey, promise)
    return promise
  }

  const background = (provider, options = {}) => {
    void ensure(provider, options).then((result) => {
      if (result.ok || result.skipped || disposed) return
      try {
        logger?.warn?.(
          'vision-router: local Ollama warmup skipped/failed [%s] reason=%s detail=%s',
          provider?.model || 'unknown',
          result.reason || 'unknown',
          result.error ? errorText(result.error) : 'no response',
        )
      } catch {
        /* diagnostics only */
      }
    })
  }

  const dispose = () => {
    disposed = true
    for (const controller of controllers) {
      try { controller.abort(new Error('Vision Router disposed')) } catch { /* best effort */ }
    }
    controllers.clear()
    inFlight.clear()
  }

  return { ensure, background, dispose }
}

function messagesContainImage(messages, core) {
  if (!Array.isArray(messages)) return false
  return messages.some((message) => {
    const content = message && Array.isArray(message.content) ? message.content : []
    if (typeof core?.blocksHaveImage === 'function') {
      try { return core.blocksHaveImage(content) } catch { /* fall through */ }
    }
    const stack = [...content]
    while (stack.length > 0) {
      const block = stack.pop()
      if (!block || typeof block !== 'object') continue
      if (block.type === 'image') return true
      if (Array.isArray(block.content)) stack.push(...block.content)
    }
    return false
  })
}

function configuredRows(config) {
  if (Array.isArray(config?.providers) && config.providers.length > 0) {
    return config.providers.filter(
      (row) => row && typeof row.provider === 'string' && row.provider !== '',
    )
  }
  if (typeof config?.provider === 'string' && config.provider !== '') {
    return [{ provider: config.provider, model: config.model }]
  }
  return []
}

/**
 * routingPairs() places explicit non-vision-http adapters before local
 * Ollama/LM Studio, then ordinary vision-http rows. Local Ollama is therefore
 * first only when no explicit native adapter row exists.
 */
export function localOllamaIsPrimary(config) {
  return !configuredRows(config).some((row) => row.provider !== 'vision-http')
}

/**
 * Add cold-start handling around the existing local-vision stabilizer without
 * changing core routing semantics.
 *
 * Install this guard BEFORE installLocalVisionStabilizer(). That ordering lets
 * the guard observe the stabilizer's final vision-http adapter, so successful
 * local Ollama calls can renew residency in the background.
 */
export function installOllamaColdStartGuard(ctx, config = {}, core, options = {}) {
  config = normalizeRuntimeVisionConfig(config)
  if (!ctx || typeof ctx !== 'object') return ctx

  let rawScope
  let scopeUnwatch
  const manager = options.manager || createOllamaWarmupManager({ logger: ctx.logger })
  const rawInject = typeof ctx.inject === 'function' ? ctx.inject.bind(ctx) : undefined
  const rawOn = typeof ctx.on === 'function' ? ctx.on.bind(ctx) : undefined
  const rawLlm = ctx.llm

  const actualConfig = () => {
    try {
      const value = rawScope && typeof rawScope.get === 'function' ? rawScope.get() : config
      return normalizeRuntimeVisionConfig(value && typeof value === 'object' ? value : config)
    } catch {
      return config
    }
  }

  const providerOf = () => {
    try {
      return core?.localOllamaProvidersOf?.(actualConfig())?.[0]
    } catch {
      return undefined
    }
  }

  const backgroundWarm = (reason, extra = {}) => {
    const provider = providerOf()
    if (provider) manager.background(provider, { reason, ...extra })
  }

  const bindScope = (scope, ownerCtx) => {
    if (!scope || typeof scope !== 'object') return
    rawScope = scope
    if (typeof scopeUnwatch === 'function') {
      try { scopeUnwatch() } catch { /* best effort */ }
      scopeUnwatch = undefined
    }
    backgroundWarm('settings-ready')
    if (typeof scope.watch === 'function') {
      try {
        scopeUnwatch = scope.watch(() => backgroundWarm('settings-changed'))
      } catch {
        scopeUnwatch = undefined
      }
    }
    try {
      ownerCtx?.effect?.(
        () => () => {
          if (rawScope === scope) rawScope = undefined
          if (typeof scopeUnwatch === 'function') {
            try { scopeUnwatch() } catch { /* best effort */ }
            scopeUnwatch = undefined
          }
        },
        'vision-router: Ollama warmup settings lifecycle',
      )
    } catch {
      /* lifecycle registration is best effort */
    }
  }

  const wrapSettings = (settings, ownerCtx) =>
    new Proxy(settings, {
      get(target, property) {
        if (property !== 'register') {
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return (namespace, schema, registerOptions = {}) => {
          const scope = target.register(namespace, schema, registerOptions)
          if (namespace === 'vision-router') bindScope(scope, ownerCtx)
          return scope
        }
      },
    })

  const inject = rawInject
    ? (deps, callback) =>
        rawInject(deps, (childCtx) => {
          if (!Array.isArray(deps) || !deps.includes('settings') || !childCtx?.settings) {
            return callback(childCtx)
          }
          const wrapped = new Proxy(childCtx, {
            get(target, property) {
              if (property === 'settings') return wrapSettings(target.settings, childCtx)
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
          return callback(wrapped)
        })
    : undefined

  const on = rawOn
    ? (event, handler) => {
        if (event !== 'agent/pre-step') return rawOn(event, handler)
        return rawOn(event, async (...args) => {
          const current = actualConfig()
          const provider = providerOf()
          const payload = args[0]
          if (provider && messagesContainImage(payload?.messages, core)) {
            if (localOllamaIsPrimary(current)) {
              // This wait happens before the core pre-step handler starts the
              // visual task budget. A large cold model can therefore load once
              // instead of being misclassified as a 45s inference timeout.
              await manager.ensure(provider, { reason: 'image-pre-step-primary' })
            } else {
              // A user-selected native provider runs first. Warm Ollama in the
              // background so it is ready if that provider falls through.
              manager.background(provider, { reason: 'image-pre-step-fallback' })
            }
          }
          return handler(...args)
        })
      }
    : undefined

  const wrapVisionHttpAdapter = (adapter) =>
    new Proxy(adapter, {
      get(target, property) {
        if (property !== 'stream') {
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return async function* stream(options) {
          const isLocalOllama =
            typeof options?.model === 'string' && options.model.startsWith('local-ollama/')
          let succeeded = false
          for await (const chunk of target.stream(options)) {
            if (
              isLocalOllama &&
              chunk?.type === 'finish' &&
              chunk?.reason?.kind === 'stop'
            ) {
              succeeded = true
            }
            yield chunk
          }
          if (succeeded) {
            // OpenAI-compatible chat does not expose Ollama's keep_alive field.
            // Renew via the native endpoint after the real response, without
            // delaying the user-visible result. This prevents Ollama's default
            // five-minute residency from reintroducing the cold-start problem.
            backgroundWarm('post-success-renewal', { forceKeepAlive: true })
          }
        }
      },
    })

  const llm = rawLlm && typeof rawLlm === 'object'
    ? new Proxy(rawLlm, {
        get(target, property) {
          if (property !== 'registerAdapter') {
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return (providers, adapter) => {
            const list = Array.isArray(providers) ? providers : []
            const wrapped = list.includes('vision-http') ? wrapVisionHttpAdapter(adapter) : adapter
            return target.registerAdapter(providers, wrapped)
          }
        },
      })
    : rawLlm

  try {
    ctx.effect?.(
      () => () => {
        rawScope = undefined
        if (typeof scopeUnwatch === 'function') {
          try { scopeUnwatch() } catch { /* best effort */ }
          scopeUnwatch = undefined
        }
        manager.dispose()
      },
      'vision-router: Ollama cold-start guard',
    )
  } catch {
    /* cleanup registration is best effort */
  }

  // Composition-level localOllama may already be enabled before Settings
  // mounts. Preload in the background; settings-ready coalesces with the same
  // route/model if it arrives while this is still running.
  backgroundWarm('plugin-start')

  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'inject' && inject) return inject
      if (property === 'on' && on) return on
      if (property === 'llm') return llm
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
