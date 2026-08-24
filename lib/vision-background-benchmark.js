import { runExactCapabilityBenchmark } from './vision-capability-probe.js'
import { listCapabilityBenchmarkFixtures } from './vision-capability-benchmark.js'
import { collectCapabilityShadowCandidates } from './vision-capability-shadow.js'
import { createExactCapabilityInvoker } from './vision-capability-benchmark-service.js'
import { resolveVisionRoutingAuthority } from './vision-routing-authority.js'
import { redactDiagnosticText } from './diagnostic-redaction.js'
import { injectVisionExactCheckClient } from './vision-exact-check-client.js'
import { isLocalUiRequest } from './web-capability-boundary.js'

const FOREGROUND_VISION_TOOLS = new Set([
  'vision_bootstrap',
  'vision_describe',
  'vision_ground',
  'vision_detect',
  'vision_ocr',
  'vision_long_screenshot_ocr',
])

export const BACKGROUND_BENCHMARK_MODES = Object.freeze(['off', 'local-free', 'all'])
export const DEFAULT_BACKGROUND_BENCHMARK_IDLE_MS = 30_000
export const DEFAULT_BACKGROUND_BENCHMARK_GAP_MS = 15_000
export const DEFAULT_BACKGROUND_BENCHMARK_RETRY_MS = 30 * 60 * 1000
export const DEFAULT_BACKGROUND_BENCHMARK_SCAN_MS = 5_000
export const DEFAULT_BACKGROUND_BENCHMARK_POLICY_POLL_MS = 250
export const BACKGROUND_AXIS_PRIORITY = Object.freeze(['ocr', 'general', 'document', 'structured', 'grounding'])
export const VISION_CAPABILITY_RUNTIME_PATH = '/_dsh/vision-router/capability-runtime'

const RUNTIME_REQUEST_MAX_BYTES = 8 * 1024
const VISION_CHECK_TIMEOUT_MS = 65_000

function bounded(value, max = 400) {
  return redactDiagnosticText(value, max)
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

function abortError(message = 'foreground vision activity') {
  const error = new Error(message)
  error.name = 'AbortError'
  error.code = 'BACKGROUND_BENCHMARK_YIELD'
  return error
}

function throwIfBackgroundAborted(signal, fallback = 'background benchmark authorization changed') {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw abortError(fallback)
}

function orderedAxes() {
  return [...BACKGROUND_AXIS_PRIORITY]
}

function routeIdentity(entry) {
  const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
  const model = typeof entry?.model === 'string' ? entry.model.trim() : ''
  return name && model ? `${name}/${model}` : undefined
}

function normalizedEndpoint(value) {
  return String(value ?? '').trim().replace(/\/+$/, '').toLowerCase()
}

function trustedBuiltinFree(candidate, core) {
  if (!candidate || candidate.provider !== 'vision-http' || candidate.local === true) return false
  const modelIdentity = typeof candidate.model === 'string' ? candidate.model.trim() : ''
  if (!modelIdentity || !candidate.endpoint) return false
  const builtins = Array.isArray(core?.DEFAULT_HTTP_PROVIDERS) ? core.DEFAULT_HTTP_PROVIDERS : []
  return builtins.some((entry) =>
    routeIdentity(entry) === modelIdentity &&
    normalizedEndpoint(entry?.baseURL) === normalizedEndpoint(candidate.endpoint) &&
    !(typeof entry?.apiKeyEnv === 'string' && entry.apiKeyEnv.trim() !== ''))
}

function candidateCanRunInBackground(candidate, mode, core) {
  if (!candidate || candidate.benchmarkable !== true) return false
  if (candidate.routeRole === 'fallback-only') return false
  if (mode === 'all') return true
  if (mode !== 'local-free') return false
  return candidate.local === true || trustedBuiltinFree(candidate, core)
}

function workStillAuthorized(work, config, core) {
  const authority = resolveVisionRoutingAuthority(config)
  if (!authority.backgroundMeasurementActive) return false
  return candidateCanRunInBackground(work?.candidate, authority.backgroundMeasurement, core)
}

function backoffKey(candidate, axis) {
  return `${candidate?.key ?? ''}\u0000${axis}`
}

function publicBackoffEntries(backoff, at) {
  const out = []
  for (const [compound, rawUntil] of backoff.entries()) {
    const until = Number(rawUntil)
    if (!Number.isFinite(until) || until <= at) continue
    const separator = compound.lastIndexOf('\u0000')
    if (separator <= 0) continue
    out.push({
      key: compound.slice(0, separator),
      axis: compound.slice(separator + 1),
      until,
    })
    if (out.length >= 32) break
  }
  return out
}

async function chooseNextWork({ ctx, config, core, store, now, backoff }) {
  const authority = resolveVisionRoutingAuthority(config)
  if (!authority.backgroundMeasurementActive) return undefined
  const candidates = (await collectCapabilityShadowCandidates(ctx, config, core, store))
    .filter((candidate) => candidateCanRunInBackground(candidate, authority.backgroundMeasurement, core))
  const records = new Map()
  for (const candidate of candidates) {
    records.set(
      candidate.key,
      candidate.endpointFingerprint ? await store.get(candidate.endpointFingerprint) : undefined,
    )
  }
  // Fixed axis-first scheduling is intentionally predictable: establish OCR
  // across every eligible model, then General, before progressively deepening
  // Document, Structured, and Grounding. Recent foreground intent never
  // silently changes this standing background-measurement plan.
  for (const axis of orderedAxes()) {
    for (const candidate of candidates) {
      const blockedUntil = Number(backoff.get(backoffKey(candidate, axis)) || 0)
      if (blockedUntil > now) continue
      const record = records.get(candidate.key)
      if (Number.isFinite(Number(record?.scores?.[axis]))) continue
      return { candidate, axis, mode: authority.backgroundMeasurement }
    }
  }
  return undefined
}

async function assertBackgroundPublishable({ ctx, config, core, store, candidate, axis, signal }) {
  throwIfBackgroundAborted(signal)
  const live = activeSettings(ctx, config)
  const work = { candidate, axis }
  if (!workStillAuthorized(work, live, core)) {
    throw abortError('background authorization changed before evidence publish')
  }
  const current = await collectCapabilityShadowCandidates(ctx, live, core, store)
  throwIfBackgroundAborted(signal)
  const same = current.find((entry) => entry?.key === candidate.key)
  const authority = resolveVisionRoutingAuthority(live)
  if (
    !same ||
    same.benchmarkable !== true ||
    same.endpointFingerprint !== candidate.endpointFingerprint ||
    !candidateCanRunInBackground(same, authority.backgroundMeasurement, core)
  ) {
    throw abortError('background backend identity changed before evidence publish')
  }
}

async function runAxis({ ctx, config, core, store, candidate, axis, signal, logger, options }) {
  const backend = {
    provider: candidate.provider,
    model: candidate.model,
    endpoint: candidate.endpoint,
    config: candidate.endpointConfig,
  }
  const invoke = createExactCapabilityInvoker(ctx, core, candidate, config, options)
  await invoke.preflight?.(listCapabilityBenchmarkFixtures([axis]))
  const result = await runExactCapabilityBenchmark({ backend, invoke, intents: [axis], signal })
  if (result?.record?.fingerprint !== candidate.endpointFingerprint) {
    throw abortError('background benchmark fingerprint changed before evidence publish')
  }
  await assertBackgroundPublishable({ ctx, config, core, store, candidate, axis, signal })
  const record = await store.put(result.record)
  logger?.info?.(
    'vision-router: background benchmark completed backend=%s axis=%s score=%s benchmarkLatency=%s',
    candidate.key,
    axis,
    record?.scores?.[axis],
    record?.benchmarkMedianLatencyMsByAxis?.[axis],
  )
  return record
}

async function readJsonBody(req, maxBytes = RUNTIME_REQUEST_MAX_BYTES) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > maxBytes) throw Object.assign(new Error('request body too large'), { code: 'VISION_CHECK_BODY_TOO_LARGE' })
    chunks.push(bytes)
  }
  if (chunks.length === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    throw Object.assign(new Error('invalid JSON request body'), { code: 'VISION_CHECK_INVALID_JSON' })
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function runExactVisionCheck({ ctx, config, core, store, provider, model, signal, invokerOptions = {} }) {
  const wantedProvider = typeof provider === 'string' ? provider.trim() : ''
  const wantedModel = typeof model === 'string' ? model.trim() : ''
  if (!wantedProvider || !wantedModel) throw Object.assign(new Error('provider and model are required'), { code: 'VISION_CHECK_BACKEND_REQUIRED' })
  const current = activeSettings(ctx, config)
  const candidates = await collectCapabilityShadowCandidates(ctx, current, core, store)
  const candidate = candidates.find((entry) => entry?.provider === wantedProvider && entry?.model === wantedModel)
  if (!candidate || candidate.benchmarkable !== true || !candidate.endpoint || !candidate.endpointFingerprint) {
    throw Object.assign(new Error('backend is no longer available for an exact image check'), { code: 'VISION_CHECK_BACKEND_STALE' })
  }
  const fixture = listCapabilityBenchmarkFixtures(['ocr'])[0]
  if (!fixture) throw Object.assign(new Error('image-check fixture is unavailable'), { code: 'VISION_CHECK_INFRASTRUCTURE' })
  const backend = {
    provider: candidate.provider,
    model: candidate.model,
    endpoint: candidate.endpoint,
    config: candidate.endpointConfig,
  }
  const invoke = createExactCapabilityInvoker(ctx, core, candidate, current, invokerOptions)
  await invoke.preflight?.([fixture])
  const result = await invoke({
    backend,
    fixture,
    exactBackend: true,
    allowFallback: false,
    signal,
  })
  return {
    ok: true,
    key: candidate.key,
    verified: true,
    ...(typeof result?.transport === 'string' ? { transport: result.transport } : {}),
    ...(Number.isFinite(Number(result?.latencyMs)) ? { latencyMs: Number(result.latencyMs) } : {}),
    ...(result?.output !== undefined ? { output: bounded(result.output, 120) } : {}),
  }
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
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  idleMs = DEFAULT_BACKGROUND_BENCHMARK_IDLE_MS,
  gapMs = DEFAULT_BACKGROUND_BENCHMARK_GAP_MS,
  retryMs = DEFAULT_BACKGROUND_BENCHMARK_RETRY_MS,
  scanMs = DEFAULT_BACKGROUND_BENCHMARK_SCAN_MS,
  policyPollMs = DEFAULT_BACKGROUND_BENCHMARK_POLICY_POLL_MS,
  runAxisBenchmark,
  invokerOptions = {},
} = {}) {
  if (!ctx || !core || !store) throw new TypeError('ctx, core and store are required')
  let timer
  let stopped = false
  let activeForeground = 0
  let activeManualBenchmarks = 0
  let lastForegroundAt = Number(now())
  let runningController
  let runningWork
  let topologyDirty = false
  let lastAuthority = resolveVisionRoutingAuthority(activeSettings(ctx, config))
  const backoff = new Map()

  const schedule = (delay = idleMs) => {
    if (stopped) return
    if (timer !== undefined) clearTimer(timer)
    timer = setTimer(() => {
      timer = undefined
      void tick()
    }, Math.max(0, Number(delay) || 0))
    try { timer?.unref?.() } catch {}
  }

  const wake = () => schedule(0)

  const yieldBackground = (message) => {
    if (runningController && !runningController.signal.aborted) runningController.abort(abortError(message))
  }

  const settingsChanged = () => {
    const live = activeSettings(ctx, config)
    const nextAuthority = resolveVisionRoutingAuthority(live)
    const becameActive = !lastAuthority.backgroundMeasurementActive && nextAuthority.backgroundMeasurementActive
    lastAuthority = nextAuthority
    // A direct user opt-in should not be hidden behind the startup idle window.
    // Real foreground vision still resets this clock and keeps its 30s priority.
    if (becameActive) lastForegroundAt = Math.min(lastForegroundAt, Number(now()) - idleMs)
    if (runningWork) {
      if (!workStillAuthorized(runningWork, live, core)) {
        topologyDirty = true
        yieldBackground('background authorization changed')
      }
      return
    }
    schedule(0)
  }

  const topologyChanged = () => {
    topologyDirty = true
    yieldBackground('routing model topology changed')
    if (!runningController) {
      topologyDirty = false
      schedule(0)
    }
  }

  const tick = async () => {
    if (stopped || runningController) return
    const currentNow = Number(now())
    const current = activeSettings(ctx, config)
    const authority = resolveVisionRoutingAuthority(current)
    lastAuthority = authority
    if (!authority.backgroundMeasurementActive) {
      schedule(scanMs)
      return
    }
    if (activeForeground > 0 || activeManualBenchmarks > 0) {
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
      work = await chooseNextWork({ ctx, config: current, core, store, now: currentNow, backoff })
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
    let policyTimer
    try {
      const interval = Math.max(25, Number(policyPollMs) || DEFAULT_BACKGROUND_BENCHMARK_POLICY_POLL_MS)
      policyTimer = setIntervalFn(() => {
        if (controller.signal.aborted) return
        const live = activeSettings(ctx, config)
        if (!workStillAuthorized(work, live, core)) {
          controller.abort(abortError('background authorization revoked'))
        }
      }, interval)
      try { policyTimer?.unref?.() } catch {}

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
      const yielded = controller.signal.aborted || error?.code === 'BACKGROUND_BENCHMARK_YIELD'
      if (yielded) {
        logger?.info?.(
          'vision-router: background benchmark yielded backend=%s axis=%s',
          work.candidate.key,
          work.axis,
        )
        schedule(activeForeground > 0 ? idleMs : gapMs)
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
      if (policyTimer !== undefined) clearIntervalFn(policyTimer)
      runningController = undefined
      runningWork = undefined
      if (topologyDirty) {
        topologyDirty = false
        schedule(0)
      }
    }
  }

  const foregroundStart = () => {
    activeForeground += 1
    lastForegroundAt = Number(now())
    yieldBackground('foreground vision activity')
    schedule(idleMs)
  }

  const foregroundEnd = () => {
    activeForeground = Math.max(0, activeForeground - 1)
    lastForegroundAt = Number(now())
    schedule(idleMs)
  }

  const manualStart = () => {
    activeManualBenchmarks += 1
    yieldBackground('manual capability benchmark queued')
    schedule(idleMs)
  }

  const manualEnd = () => {
    activeManualBenchmarks = Math.max(0, activeManualBenchmarks - 1)
    schedule(activeManualBenchmarks > 0 ? idleMs : gapMs)
  }

  const stop = () => {
    stopped = true
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    yieldBackground('background profiler stopped')
  }

  schedule(idleMs)
  return {
    tick,
    schedule,
    wake,
    settingsChanged,
    topologyChanged,
    stop,
    foregroundStart,
    foregroundEnd,
    manualStart,
    manualEnd,
    snapshot() {
      const currentNow = Number(now())
      return {
        stopped,
        activeForeground,
        activeManualBenchmarks,
        lastForegroundAt,
        idleRemainingMs: Math.max(0, lastForegroundAt + idleMs - currentNow),
        running: runningWork ? { key: runningWork.candidate.key, axis: runningWork.axis } : undefined,
        deferred: publicBackoffEntries(backoff, currentNow),
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
    Object.defineProperty(store, 'backgroundProfiler', {
      configurable: true,
      enumerable: false,
      writable: false,
      value: profiler,
    })
  } catch {
    try { store.backgroundProfiler = profiler } catch {}
  }

  const eventDisposers = []
  const wakeForSettings = (namespace) => {
    if (namespace === undefined || String(namespace) === 'vision-router') profiler.settingsChanged()
  }
  const wakeForModels = () => profiler.topologyChanged()
  try {
    if (typeof ctx?.on === 'function') {
      for (const [event, handler] of [
        ['settings/updated', wakeForSettings],
        ['settings/document-updated', wakeForSettings],
        ['llm/adapters-updated', wakeForModels],
      ]) {
        const stop = ctx.on(event, handler)
        if (typeof stop === 'function') eventDisposers.push(stop)
      }
    }
  } catch {
    // Event-driven wakeups are an optimization; the short authority scan remains.
  }

  try {
    ctx?.effect?.(() => () => {
      for (const dispose of eventDisposers.splice(0)) {
        try { dispose() } catch {}
      }
      profiler.stop()
    }, 'vision-router: background capability profiler')
  } catch {
    // Cleanup registration is best-effort; the profiler remains process-scoped.
  }

  try {
    ctx?.inject?.(['webServer'], (webCtx) => {
      webCtx.effect(
        () => webCtx.webServer.tapIndex(injectVisionExactCheckClient),
        'vision-router: exact image check product control',
      )
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path: VISION_CAPABILITY_RUNTIME_PATH,
        handler: async (req, res) => {
          if (req.method === 'GET') {
            if (!isLocalUiRequest(req)) {
              sendJson(res, 403, { ok: false, error: 'background capability status is available only from the local DSH UI' })
              return
            }
            const current = activeSettings(ctx, config)
            const authority = resolveVisionRoutingAuthority(current)
            const state = profiler.snapshot()
            sendJson(res, 200, {
              ok: true,
              background: {
                mode: authority.backgroundMeasurement,
                active: authority.backgroundMeasurementActive,
                paused: state.activeForeground > 0 || state.activeManualBenchmarks > 0,
                idleRemainingMs: state.idleRemainingMs,
                running: state.running ?? null,
                deferred: state.deferred,
              },
            })
            return
          }
          if (req.method !== 'POST') {
            res.setHeader('Allow', 'GET, POST')
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          if (!isLocalUiRequest(req)) {
            sendJson(res, 403, { ok: false, error: 'this exact image check is available only from the local DSH UI' })
            return
          }
          profiler.manualStart()
          try {
            const body = await readJsonBody(req)
            const result = await runExactVisionCheck({
              ctx,
              config,
              core,
              store,
              provider: body.provider,
              model: body.model,
              signal: AbortSignal.timeout(VISION_CHECK_TIMEOUT_MS),
              invokerOptions: options.invokerOptions ?? {},
            })
            sendJson(res, 200, result)
          } catch (error) {
            const clientError = new Set([
              'VISION_CHECK_BODY_TOO_LARGE',
              'VISION_CHECK_INVALID_JSON',
              'VISION_CHECK_BACKEND_REQUIRED',
              'VISION_CHECK_BACKEND_STALE',
            ]).has(error?.code)
            sendJson(res, clientError ? 400 : 502, {
              ok: false,
              code: error?.code ?? 'VISION_CHECK_FAILED',
              error: bounded(error?.message ?? error),
            })
          } finally {
            profiler.manualEnd()
          }
        },
      }), 'vision-router: capability runtime status and exact image check')
    })
  } catch {
    // Product diagnostics must never prevent the core visual tools from loading.
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