import {
  BENCHMARK_AXES,
  benchmarkAxisForVisionIntent,
  inferToolVisionIntent,
} from './vision-capability-router.js'
import {
  capabilityProfileAxisFreshness,
  runExactCapabilityBenchmark,
} from './vision-capability-probe.js'
import { listCapabilityBenchmarkFixtures } from './vision-capability-benchmark.js'
import { collectCapabilityShadowCandidates } from './vision-capability-shadow.js'
import { createExactCapabilityInvoker } from './vision-capability-benchmark-service.js'
import { resolveVisionRoutingProduct } from './vision-routing-product.js'

const FOREGROUND_VISION_TOOLS = new Set([
  'vision_bootstrap',
  'vision_describe',
  'vision_ground',
  'vision_detect',
  'vision_ocr',
  'vision_long_screenshot_ocr',
])

export const BACKGROUND_BENCHMARK_MODES = Object.freeze(['local-free', 'all', 'off'])
export const DEFAULT_BACKGROUND_BENCHMARK_IDLE_MS = 30_000
export const DEFAULT_BACKGROUND_BENCHMARK_GAP_MS = 15_000
export const DEFAULT_BACKGROUND_BENCHMARK_RETRY_MS = 30 * 60 * 1000
export const DEFAULT_BACKGROUND_BENCHMARK_SCAN_MS = 5 * 60 * 1000
export const BACKGROUND_AXIS_PRIORITY = Object.freeze(['ocr', 'general', 'document', 'structured', 'grounding'])

function bounded(value, max = 400) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, max)
}

function activeSettings(ctx, fallback = {}) {
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    return value && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}

function backgroundMode(config = {}) {
  return BACKGROUND_BENCHMARK_MODES.includes(config?.backgroundBenchmarking)
    ? config.backgroundBenchmarking
    : 'local-free'
}

function abortError(message = 'foreground vision activity') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function orderedAxes(preferredAxis) {
  const first = BENCHMARK_AXES.includes(preferredAxis) ? [preferredAxis] : []
  return [...first, ...BACKGROUND_AXIS_PRIORITY.filter((axis) => !first.includes(axis))]
}

function candidateCanRunInBackground(candidate, mode) {
  if (!candidate || candidate.benchmarkable !== true) return false
  if (candidate.routeRole === 'fallback-only') return false
  if (mode === 'all') return true
  if (mode !== 'local-free') return false
  return candidate.local === true || candidate.cost === 0
}

function backoffKey(candidate, axis) {
  return `${candidate?.key ?? ''}\u0000${axis}`
}

async function chooseNextWork({ ctx, config, core, store, now, preferredAxis, backoff }) {
  const product = resolveVisionRoutingProduct(config)
  const mode = backgroundMode(config)
  if (product.mode !== 'auto' || mode === 'off') return undefined
  const candidates = await collectCapabilityShadowCandidates(ctx, config, core, store)
  const axes = orderedAxes(preferredAxis)
  for (const candidate of candidates) {
    if (!candidateCanRunInBackground(candidate, mode)) continue
    const record = candidate.endpointFingerprint ? await store.get(candidate.endpointFingerprint) : undefined
    for (const axis of axes) {
      const blockedUntil = Number(backoff.get(backoffKey(candidate, axis)) || 0)
      if (blockedUntil > now) continue
      if (capabilityProfileAxisFreshness(record, axis, now) === 'fresh') continue
      return { candidate, axis, mode }
    }
  }
  return undefined
}

async function runAxis({ ctx, config, core, store, candidate, axis, signal, logger, options }) {
  const backend = {
    provider: candidate.provider,
    model: candidate.model,
    endpoint: candidate.endpoint,
    config: candidate.endpointConfig,
    credentialFingerprint: candidate.credentialFingerprint,
  }
  const invoke = createExactCapabilityInvoker(ctx, core, candidate, config, options)
  await invoke.preflight?.(listCapabilityBenchmarkFixtures([axis]))
  const result = await runExactCapabilityBenchmark({ backend, invoke, intents: [axis], signal })
  const record = await store.put(result.record)
  logger?.info?.(
    'vision-router: background benchmark completed backend=%s axis=%s score=%s latency=%s',
    candidate.key,
    axis,
    record?.scores?.[axis],
    record?.medianLatencyMs?.[axis],
  )
  return record
}

export function createBackgroundCapabilityProfiler({
  ctx,
  config = {},
  core,
  store,
  logger,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  idleMs = DEFAULT_BACKGROUND_BENCHMARK_IDLE_MS,
  gapMs = DEFAULT_BACKGROUND_BENCHMARK_GAP_MS,
  retryMs = DEFAULT_BACKGROUND_BENCHMARK_RETRY_MS,
  scanMs = DEFAULT_BACKGROUND_BENCHMARK_SCAN_MS,
  runAxisBenchmark,
  invokerOptions = {},
} = {}) {
  if (!ctx || !core || !store) throw new TypeError('ctx, core and store are required')
  let timer
  let stopped = false
  let activeForeground = 0
  let lastForegroundAt = Number(now())
  let preferredAxis
  let runningController
  let runningWork
  const backoff = new Map()

  const schedule = (delay = idleMs) => {
    if (stopped) return
    if (timer !== undefined) clearTimer(timer)
    timer = setTimer(() => {
      timer = undefined
      void tick()
    }, Math.max(0, Number(delay) || 0))
  }

  const tick = async () => {
    if (stopped || runningController) return
    const currentNow = Number(now())
    const current = activeSettings(ctx, config)
    if (activeForeground > 0) {
      schedule(idleMs)
      return
    }
    const sinceForeground = Math.max(0, currentNow - lastForegroundAt)
    if (sinceForeground < idleMs) {
      schedule(idleMs - sinceForeground)
      return
    }

    let work
    try {
      work = await chooseNextWork({ ctx, config: current, core, store, now: currentNow, preferredAxis, backoff })
    } catch (error) {
      logger?.warn?.('vision-router: background benchmark scan failed: %s', bounded(error?.message ?? error))
      schedule(scanMs)
      return
    }
    if (!work) {
      schedule(scanMs)
      return
    }

    const controller = new AbortController()
    runningController = controller
    runningWork = work
    const key = backoffKey(work.candidate, work.axis)
    try {
      const runner = runAxisBenchmark ?? ((args) => runAxis({ ...args, options: invokerOptions }))
      await runner({
        ctx,
        config: current,
        core,
        store,
        candidate: work.candidate,
        axis: work.axis,
        signal: controller.signal,
        logger,
      })
      backoff.delete(key)
      schedule(gapMs)
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        logger?.info?.(
          'vision-router: background benchmark yielded backend=%s axis=%s',
          work.candidate.key,
          work.axis,
        )
        schedule(idleMs)
      } else {
        backoff.set(key, Number(now()) + retryMs)
        logger?.warn?.(
          'vision-router: background benchmark deferred backend=%s axis=%s error=%s',
          work.candidate.key,
          work.axis,
          bounded(error?.message ?? error),
        )
        schedule(gapMs)
      }
    } finally {
      runningController = undefined
      runningWork = undefined
    }
  }

  const foregroundStart = ({ toolName, args, bootstrap } = {}) => {
    activeForeground += 1
    lastForegroundAt = Number(now())
    const intent = inferToolVisionIntent(toolName, args, { bootstrap })
    preferredAxis = benchmarkAxisForVisionIntent(intent) ?? preferredAxis
    if (runningController && !runningController.signal.aborted) runningController.abort(abortError())
    schedule(idleMs)
  }

  const foregroundEnd = () => {
    activeForeground = Math.max(0, activeForeground - 1)
    lastForegroundAt = Number(now())
    schedule(idleMs)
  }

  const stop = () => {
    stopped = true
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    if (runningController && !runningController.signal.aborted) runningController.abort(abortError('background profiler stopped'))
  }

  schedule(idleMs)
  return {
    tick,
    schedule,
    stop,
    foregroundStart,
    foregroundEnd,
    snapshot() {
      return {
        stopped,
        activeForeground,
        lastForegroundAt,
        preferredAxis,
        running: runningWork ? { key: runningWork.candidate.key, axis: runningWork.axis } : undefined,
        backoffSize: backoff.size,
      }
    },
  }
}

function wrapTools(tools, profiler) {
  if (!tools || (typeof tools !== 'object' && typeof tools !== 'function')) return tools
  return new Proxy(tools, {
    get(target, property) {
      if (property !== 'register') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const register = Reflect.get(target, property, target)
      if (typeof register !== 'function') return register
      return (def) => {
        if (!def || !FOREGROUND_VISION_TOOLS.has(def.name) || typeof def.execute !== 'function') return register.call(target, def)
        return register.call(target, {
          ...def,
          async execute(args, exec) {
            profiler.foregroundStart({ toolName: def.name, args })
            try {
              return await def.execute(args, exec)
            } finally {
              profiler.foregroundEnd()
            }
          },
        })
      }
    },
  })
}

export function installBackgroundCapabilityProfiling(ctx, config, core, store, options = {}) {
  const profiler = createBackgroundCapabilityProfiler({
    ctx,
    config,
    core,
    store,
    logger: options.logger ?? ctx?.logger,
    ...options,
  })
  try {
    ctx?.effect?.(() => () => profiler.stop(), 'vision-router: background capability profiler')
  } catch {
    // Cleanup registration is best-effort; the profiler remains process-scoped.
  }
  const wrapped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') return wrapTools(target.tools, profiler)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { ctx: wrapped, profiler }
}
