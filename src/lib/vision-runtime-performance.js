import { AsyncLocalStorage } from 'node:async_hooks'
import { benchmarkAxisForVisionIntent } from './vision-capability-evidence.js'
import { inferToolVisionIntent } from './vision-capability-router.js'
import { capabilityEvidenceFingerprint } from './vision-capability-identity.js'
import { providerTransportFor } from './live-model-discovery.js'
import { createVisionRuntimePerformanceSampleStore } from './vision-runtime-performance-store.js'

export {
  DEFAULT_RUNTIME_PERFORMANCE_MAX_AGE_MS,
  DEFAULT_RUNTIME_PERFORMANCE_MAX_SAMPLES,
  DEFAULT_RUNTIME_PERFORMANCE_MIN_SAMPLES,
  DEFAULT_RUNTIME_PERFORMANCE_MAX_BACKENDS,
} from './vision-runtime-performance-store.js'

const runtimeScope = new AsyncLocalStorage()

function backendParts(backendKey) {
  const key = cleanBackendKey(backendKey)
  if (!key) return undefined
  const slash = key.indexOf('/')
  if (slash <= 0 || slash === key.length - 1) return undefined
  return { key, provider: key.slice(0, slash), model: key.slice(slash + 1) }
}

function registeredAdapterIdentity(ctx, provider, model) {
  try {
    const registration = ctx?.llm?.registration?.(provider)
    const adapter = registration?.adapter
    if (!adapter) return undefined
    const adapterKind = typeof adapter?.constructor?.name === 'string' && adapter.constructor.name.trim() !== ''
      ? adapter.constructor.name.trim()
      : 'registered-adapter'
    return capabilityEvidenceFingerprint({
      provider,
      model,
      endpoint: `dsh-adapter://registered/${encodeURIComponent(provider)}`,
      config: { api: 'dsh-adapter', adapterKind },
    })
  } catch {
    return undefined
  }
}

export function runtimePerformanceIdentityFor(ctx, backendKey) {
  const parts = backendParts(backendKey)
  if (!parts) return undefined
  try {
    const transport = providerTransportFor(ctx, parts.provider)
    if (transport?.baseURL) {
      return capabilityEvidenceFingerprint({
        provider: parts.provider,
        model: parts.model,
        endpoint: transport.baseURL,
        config: { api: transport.api },
      })
    }
  } catch {}
  return registeredAdapterIdentity(ctx, parts.provider, parts.model)
}

function successFinish(chunk) {
  if (!chunk || chunk.type !== 'finish') return false
  const kind = chunk.reason?.kind
  return kind !== 'error' && kind !== 'aborted'
}

function failureFinish(chunk) {
  if (!chunk) return false
  if (chunk.type === 'error' || chunk.type === 'aborted') return true
  if (chunk.type !== 'finish') return false
  const kind = chunk.reason?.kind
  return kind === 'error' || kind === 'aborted'
}

export function createVisionRuntimePerformanceStore(options = {}) {
  const identityResolver = typeof options.identityResolver === 'function'
    ? options.identityResolver
    : (backendKey, ctx) => runtimePerformanceIdentityFor(ctx, backendKey)
  return createVisionRuntimePerformanceSampleStore({
    ...options,
    identityResolver,
  })
}

export function withVisionRuntimePerformanceScope(toolName, args, fn) {
  const intent = inferToolVisionIntent(toolName, args)
  const axis = benchmarkAxisForVisionIntent(intent)
  if (!axis) return fn()
  return runtimeScope.run({ axis, intent }, fn)
}

export function currentVisionRuntimePerformanceScope() {
  return runtimeScope.getStore()
}

export function contextWithVisionRuntimePerformance(ctx, store, options = {}) {
  if (!ctx || typeof ctx !== 'object' || !store || typeof store.record !== 'function') return ctx
  const now = typeof options.now === 'function' ? options.now : Date.now
  const logger = options.logger ?? ctx.logger
  // Production must supply a live authority check. Defaulting to false keeps
  // direct/programmatic callers from accidentally collecting future-routing
  // evidence without an explicit grant.
  const observationAllowed = typeof options.observationAllowed === 'function'
    ? options.observationAllowed
    : () => false
  const canObserve = () => {
    try { return observationAllowed() === true } catch { return false }
  }
  const wrappedLlm = new WeakMap()
  try { store.bindContext?.(ctx) } catch {}

  const llmView = (llm) => {
    if (!llm || (typeof llm !== 'object' && typeof llm !== 'function')) return llm
    const cached = wrappedLlm.get(llm)
    if (cached) return cached
    const proxy = new Proxy(llm, {
      get(target, property) {
        if (property !== 'stream') {
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
        const stream = Reflect.get(target, property, target)
        if (typeof stream !== 'function') return stream
        return function observedStream(options = {}) {
          const scope = runtimeScope.getStore()
          const provider = typeof options.provider === 'string' ? options.provider : ''
          const model = typeof options.model === 'string' ? options.model : ''
          const backendKey = provider && model ? `${provider}/${model}` : undefined
          if (!scope?.axis || !backendKey || !canObserve()) return stream.call(target, options)
          const source = stream.call(target, options)
          return (async function* () {
            const started = Number(now())
            let succeeded = false
            let failed = false
            try {
              for await (const chunk of source) {
                if (failureFinish(chunk)) failed = true
                if (successFinish(chunk)) succeeded = true
                yield chunk
              }
            } finally {
              // Re-check at publication time as well: revoking Auto while a
              // call is in flight must prevent that call from becoming future
              // routing evidence.
              if (succeeded && !failed && canObserve()) {
                const finished = Number(now())
                const latencyMs = Number.isFinite(started) && Number.isFinite(finished)
                  ? Math.max(0, finished - started)
                  : undefined
                if (latencyMs !== undefined && store.record(backendKey, scope.axis, latencyMs, finished)) {
                  logger?.debug?.(
                    'vision-router: runtime performance backend=%s axis=%s latencyMs=%d',
                    backendKey,
                    scope.axis,
                    latencyMs,
                  )
                }
              }
            }
          })()
        }
      },
    })
    wrappedLlm.set(llm, proxy)
    return proxy
  }

  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'llm') return llmView(target.llm)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
