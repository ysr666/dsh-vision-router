import { AsyncLocalStorage } from 'node:async_hooks'
import {
  benchmarkAxisForVisionIntent,
  inferToolVisionIntent,
} from './vision-capability-router.js'
import { capabilityEvidenceFingerprint } from './vision-capability-identity.js'
import { providerTransportFor } from './live-model-discovery.js'

export const DEFAULT_RUNTIME_PERFORMANCE_MAX_AGE_MS = 60 * 60 * 1000
export const DEFAULT_RUNTIME_PERFORMANCE_MAX_SAMPLES = 8
export const DEFAULT_RUNTIME_PERFORMANCE_MIN_SAMPLES = 2
export const DEFAULT_RUNTIME_PERFORMANCE_MAX_BACKENDS = 128

const runtimeScope = new AsyncLocalStorage()

function finiteLatency(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return undefined
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

function cleanBackendKey(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text === '' ? undefined : text.slice(0, 512)
}

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
  const now = typeof options.now === 'function' ? options.now : Date.now
  const maxAgeMs = Math.max(1_000, Number(options.maxAgeMs) || DEFAULT_RUNTIME_PERFORMANCE_MAX_AGE_MS)
  const maxSamples = Math.max(1, Math.min(64, Math.floor(Number(options.maxSamples) || DEFAULT_RUNTIME_PERFORMANCE_MAX_SAMPLES)))
  const minSamples = Math.max(1, Math.min(maxSamples, Math.floor(Number(options.minSamples) || DEFAULT_RUNTIME_PERFORMANCE_MIN_SAMPLES)))
  const maxBackends = Math.max(1, Math.min(1024, Math.floor(Number(options.maxBackends) || DEFAULT_RUNTIME_PERFORMANCE_MAX_BACKENDS)))
  const records = new Map()
  let identityContext = options.context
  const identityResolver = typeof options.identityResolver === 'function'
    ? options.identityResolver
    : (backendKey, ctx) => runtimePerformanceIdentityFor(ctx, backendKey)

  const resolvedStorageKey = (backendKey) => {
    const key = cleanBackendKey(backendKey)
    if (!key) return undefined
    let identity
    try { identity = identityContext ? identityResolver(key, identityContext) : undefined } catch { identity = undefined }
    return identity ? `${key}\u0000${identity}` : key
  }

  const pruneAxis = (samples, at) => samples.filter((sample) => at - sample.at <= maxAgeMs)

  const pruneBackend = (key, at) => {
    const axes = records.get(key)
    if (!axes) return undefined
    for (const [axis, samples] of axes) {
      const current = pruneAxis(samples, at)
      if (current.length === 0) axes.delete(axis)
      else if (current.length !== samples.length) axes.set(axis, current)
    }
    if (axes.size === 0) {
      records.delete(key)
      return undefined
    }
    // LRU touch only on runtime-observation reads/writes; routing diagnostics
    // are allowed to read this performance store because it is not the v1
    // breaker and has no execution side effects.
    records.delete(key)
    records.set(key, axes)
    return axes
  }

  const bound = () => {
    while (records.size > maxBackends) {
      const oldest = records.keys().next().value
      if (oldest === undefined) break
      records.delete(oldest)
    }
  }

  return {
    maxAgeMs,
    maxSamples,
    minSamples,
    bindContext(ctx) {
      identityContext = ctx
    },
    record(backendKey, axis, latencyMs, at = now()) {
      const key = resolvedStorageKey(backendKey)
      const latency = finiteLatency(latencyMs)
      const timestamp = Number(at)
      if (!key || !benchmarkAxisForVisionIntent(axis) || latency === undefined || !Number.isFinite(timestamp)) return false
      let axes = pruneBackend(key, timestamp)
      if (!axes) {
        axes = new Map()
        records.set(key, axes)
      }
      const current = pruneAxis(axes.get(axis) ?? [], timestamp)
      current.push({ at: timestamp, latencyMs: latency })
      if (current.length > maxSamples) current.splice(0, current.length - maxSamples)
      axes.set(axis, current)
      records.delete(key)
      records.set(key, axes)
      bound()
      return true
    },
    get(backendKey, at = now()) {
      const key = resolvedStorageKey(backendKey)
      const timestamp = Number(at)
      if (!key || !Number.isFinite(timestamp)) return undefined
      const axes = pruneBackend(key, timestamp)
      if (!axes) return undefined
      const observedLatencyMsByAxis = {}
      const runtimeLatencyMsByAxis = {}
      const sampleCountByAxis = {}
      const observedAtByAxis = {}
      for (const [axis, samples] of axes) {
        const latencies = samples.map((sample) => sample.latencyMs)
        const value = median(latencies)
        if (value === undefined) continue
        observedLatencyMsByAxis[axis] = value
        sampleCountByAxis[axis] = samples.length
        observedAtByAxis[axis] = Math.max(...samples.map((sample) => sample.at))
        if (samples.length >= minSamples) runtimeLatencyMsByAxis[axis] = value
      }
      return {
        runtimeLatencyMsByAxis,
        observedLatencyMsByAxis,
        sampleCountByAxis,
        observedAtByAxis,
        maxAgeMs,
        minSamples,
      }
    },
    clear(backendKey) {
      if (backendKey === undefined) {
        records.clear()
        return
      }
      const base = cleanBackendKey(backendKey)
      if (!base) return
      records.delete(base)
      const prefix = `${base}\u0000`
      for (const key of [...records.keys()]) if (key.startsWith(prefix)) records.delete(key)
    },
    size() {
      return records.size
    },
  }
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
