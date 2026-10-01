import {
  BENCHMARK_AXES,
  type BenchmarkAxis,
  type CapabilityLatencyMap,
  type CapabilityMeasuredAtMap,
  type CapabilitySampleCountMap,
} from './vision-capability-evidence.js'

export const DEFAULT_RUNTIME_PERFORMANCE_MAX_AGE_MS = 60 * 60 * 1000
export const DEFAULT_RUNTIME_PERFORMANCE_MAX_SAMPLES = 8
export const DEFAULT_RUNTIME_PERFORMANCE_MIN_SAMPLES = 2
export const DEFAULT_RUNTIME_PERFORMANCE_MAX_BACKENDS = 128

interface RuntimePerformanceSample {
  readonly at: number
  readonly latencyMs: number
}

type RuntimeAxisSamples = Map<BenchmarkAxis, RuntimePerformanceSample[]>

export interface VisionRuntimePerformanceRecord {
  readonly runtimeLatencyMsByAxis: CapabilityLatencyMap
  readonly observedLatencyMsByAxis: CapabilityLatencyMap
  readonly sampleCountByAxis: CapabilitySampleCountMap
  readonly observedAtByAxis: CapabilityMeasuredAtMap
  readonly maxAgeMs: number
  readonly minSamples: number
}

export interface VisionRuntimePerformanceStore {
  readonly maxAgeMs: number
  readonly maxSamples: number
  readonly minSamples: number
  bindContext(context: unknown): void
  record(
    backendKey: unknown,
    axis: unknown,
    latencyMs: unknown,
    at?: unknown,
  ): boolean
  get(backendKey: unknown, at?: unknown): VisionRuntimePerformanceRecord | undefined
  clear(backendKey?: unknown): void
  size(): number
}

export interface VisionRuntimePerformanceStoreOptions {
  readonly now?: () => number
  readonly maxAgeMs?: unknown
  readonly maxSamples?: unknown
  readonly minSamples?: unknown
  readonly maxBackends?: unknown
  readonly context?: unknown
  readonly identityResolver?: (
    backendKey: string,
    context: unknown,
  ) => unknown
}

function finiteLatency(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function median(values: readonly number[]): number | undefined {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return undefined
  const middle = Math.floor(sorted.length / 2)
  const right = sorted[middle]
  if (right === undefined) return undefined
  if (sorted.length % 2 === 1) return right
  const left = sorted[middle - 1]
  return left === undefined ? right : (left + right) / 2
}

function cleanBackendKey(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : ''
  return text === '' ? undefined : text.slice(0, 512)
}

function isBenchmarkAxis(value: unknown): value is BenchmarkAxis {
  return typeof value === 'string'
    && (BENCHMARK_AXES as readonly string[]).includes(value)
}

export function createVisionRuntimePerformanceSampleStore(
  options: VisionRuntimePerformanceStoreOptions = {},
): VisionRuntimePerformanceStore {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const maxAgeMs = Math.max(
    1_000,
    Number(options.maxAgeMs) || DEFAULT_RUNTIME_PERFORMANCE_MAX_AGE_MS,
  )
  const maxSamples = Math.max(
    1,
    Math.min(
      64,
      Math.floor(Number(options.maxSamples) || DEFAULT_RUNTIME_PERFORMANCE_MAX_SAMPLES),
    ),
  )
  const minSamples = Math.max(
    1,
    Math.min(
      maxSamples,
      Math.floor(Number(options.minSamples) || DEFAULT_RUNTIME_PERFORMANCE_MIN_SAMPLES),
    ),
  )
  const maxBackends = Math.max(
    1,
    Math.min(
      1024,
      Math.floor(Number(options.maxBackends) || DEFAULT_RUNTIME_PERFORMANCE_MAX_BACKENDS),
    ),
  )
  const records = new Map<string, RuntimeAxisSamples>()
  let identityContext = options.context
  const identityResolver = options.identityResolver

  const resolvedStorageKey = (backendKey: unknown): string | undefined => {
    const key = cleanBackendKey(backendKey)
    if (key === undefined) return undefined
    let identity: unknown
    try {
      identity = identityContext !== undefined && identityResolver !== undefined
        ? identityResolver(key, identityContext)
        : undefined
    } catch {
      identity = undefined
    }
    return identity ? `${key}\u0000${String(identity)}` : key
  }

  const pruneAxis = (
    samples: readonly RuntimePerformanceSample[],
    at: number,
  ): RuntimePerformanceSample[] =>
    samples.filter((sample) => at - sample.at <= maxAgeMs)

  const pruneBackend = (
    key: string,
    at: number,
  ): RuntimeAxisSamples | undefined => {
    const axes = records.get(key)
    if (axes === undefined) return undefined
    for (const [axis, samples] of axes) {
      const current = pruneAxis(samples, at)
      if (current.length === 0) axes.delete(axis)
      else if (current.length !== samples.length) axes.set(axis, current)
    }
    if (axes.size === 0) {
      records.delete(key)
      return undefined
    }
    records.delete(key)
    records.set(key, axes)
    return axes
  }

  const bound = (): void => {
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

    bindContext(context: unknown): void {
      identityContext = context
    },

    record(
      backendKey: unknown,
      axisValue: unknown,
      latencyMsValue: unknown,
      atValue: unknown = now(),
    ): boolean {
      const key = resolvedStorageKey(backendKey)
      const latencyMs = finiteLatency(latencyMsValue)
      const at = Number(atValue)
      if (
        key === undefined
        || !isBenchmarkAxis(axisValue)
        || latencyMs === undefined
        || !Number.isFinite(at)
      ) {
        return false
      }

      let axes = pruneBackend(key, at)
      if (axes === undefined) {
        axes = new Map()
        records.set(key, axes)
      }
      const current = pruneAxis(axes.get(axisValue) ?? [], at)
      current.push({ at, latencyMs })
      if (current.length > maxSamples) {
        current.splice(0, current.length - maxSamples)
      }
      axes.set(axisValue, current)
      records.delete(key)
      records.set(key, axes)
      bound()
      return true
    },

    get(
      backendKey: unknown,
      atValue: unknown = now(),
    ): VisionRuntimePerformanceRecord | undefined {
      const key = resolvedStorageKey(backendKey)
      const at = Number(atValue)
      if (key === undefined || !Number.isFinite(at)) return undefined
      const axes = pruneBackend(key, at)
      if (axes === undefined) return undefined

      const observedLatencyMsByAxis: CapabilityLatencyMap = {}
      const runtimeLatencyMsByAxis: CapabilityLatencyMap = {}
      const sampleCountByAxis: CapabilitySampleCountMap = {}
      const observedAtByAxis: CapabilityMeasuredAtMap = {}

      for (const [axis, samples] of axes) {
        const latencyMs = median(samples.map((sample) => sample.latencyMs))
        if (latencyMs === undefined) continue
        observedLatencyMsByAxis[axis] = latencyMs
        sampleCountByAxis[axis] = samples.length
        observedAtByAxis[axis] = Math.max(...samples.map((sample) => sample.at))
        if (samples.length >= minSamples) runtimeLatencyMsByAxis[axis] = latencyMs
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

    clear(backendKey?: unknown): void {
      if (backendKey === undefined) {
        records.clear()
        return
      }
      const base = cleanBackendKey(backendKey)
      if (base === undefined) return
      records.delete(base)
      const prefix = `${base}\u0000`
      for (const key of [...records.keys()]) {
        if (key.startsWith(prefix)) records.delete(key)
      }
    },

    size(): number {
      return records.size
    },
  }
}
