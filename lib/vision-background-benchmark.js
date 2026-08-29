import { runExactCapabilityBenchmark } from './vision-capability-probe.js'
import { listCapabilityBenchmarkFixtures } from './vision-capability-benchmark.js'
import { collectVisionRoutingCandidates } from './vision-routing-evidence.js'
import {
  classifyCapabilityBenchmarkFailure,
  createExactCapabilityInvoker,
} from './vision-capability-benchmark-service.js'
import { withHardDeadline } from './vision-capability-benchmark-hardening.js'
import { resolveVisionRoutingAuthority } from './vision-routing-authority.js'
import { resolveVisionCredential } from './vision-capability-identity.js'
import { redactDiagnosticText } from './diagnostic-redaction.js'
import { injectVisionExactCheckClient } from './vision-exact-check-client.js'
import { createImageInputVerdictStore } from './vision-image-input-verdict.js'
import { createBackgroundBenchmarkStopStore } from './vision-background-stop-store.js'
import {
  backgroundFailurePolicy,
  credentialFingerprintChanged,
} from './vision-background-failure-policy.js'
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
const VISION_CHECK_TIMEOUT_MS = 45_000
const MODEL_WIDE_NON_RETRYABLE_BACKGROUND_FAILURES = new Set([
  'auth',
  'protocol',
  'unavailable',
])
const PERMANENT_MODEL_UNAVAILABLE_CODES = new Set([
  'MODEL_NOT_FOUND',
  'MODEL_DOES_NOT_EXIST',
  'UNKNOWN_MODEL',
])

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

async function hostExplicitlyTextOnly(ctx, candidate) {
  if (!candidate || candidate.provider === 'vision-http') return false
  try {
    const info = typeof ctx?.llm?.resolveModelInfo === 'function'
      ? await ctx.llm.resolveModelInfo(candidate.provider, candidate.model)
      : undefined
    const modalities = Array.isArray(info?.inputModalities)
      ? info.inputModalities.filter((item) => typeof item === 'string')
      : []
    return modalities.length > 0 && !modalities.includes('image')
  } catch {
    return false
  }
}

function unattendedEligibility(_ctx, candidate, mode, core) {
  // Host image metadata is advisory. Once the user explicitly grants standing
  // background measurement authority, configured benchmarkable routes are
  // actually tested instead of trusting a possibly stale text-only label.
  return { eligible: candidateCanRunInBackground(candidate, mode, core) }
}

function candidateNeedsBackgroundWork(candidate) {
  return orderedAxes().some((axis) => !Number.isFinite(Number(candidate?.measured?.[axis])))
}

function workStillAuthorized(work, config, core) {
  const authority = resolveVisionRoutingAuthority(config)
  if (!authority.backgroundMeasurementActive) return false
  return candidateCanRunInBackground(work?.candidate, authority.backgroundMeasurement, core)
}

function backoffKey(candidate, axis) {
  return `${candidate?.key ?? ''}\u0000${candidate?.endpointFingerprint ?? ''}\u0000${axis}`
}

function classifyUnavailable(value) {
  const status = Number(value?.status)
  const code = String(value?.code ?? '').toUpperCase()
  const text = bounded(value?.message ?? value, 800).toLowerCase()
  if (status === 404 || status === 410) return true
  if (PERMANENT_MODEL_UNAVAILABLE_CODES.has(code)) return true
  return /model[^\n]{0,80}(?:not found|does not exist|unknown model)|no such model/.test(text)
}

export function classifyBackgroundBenchmarkFailure(value) {
  let failureClass = value?.benchmarkClass ?? classifyCapabilityBenchmarkFailure(value)
  if (classifyUnavailable(value)) failureClass = 'unavailable'
  if (!failureClass || failureClass === 'cancelled') failureClass = 'provider'
  const policy = backgroundFailurePolicy(failureClass)
  return {
    errorClass: failureClass,
    errorCode: typeof value?.code === 'string' && value.code !== '' ? value.code : undefined,
    retryable: policy.retryable === true,
  }
}

function publicBackoffEntries(backoff, at) {
  const out = []
  for (const entry of backoff.values()) {
    if (!entry || typeof entry !== 'object') continue
    const until = Number(entry.until)
    if (Number.isFinite(until) && until <= at) continue
    out.push({
      key: entry.key,
      axis: entry.axis,
      errorClass: entry.errorClass,
      ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
      retryable: entry.retryable === true,
      ...(Number.isFinite(until) ? { until } : {}),
    })
    if (out.length >= 32) break
  }
  return out
}

function publicExcludedEntries(excluded) {
  return [...excluded.values()]
    .filter((entry) => entry && typeof entry.key === 'string' && typeof entry.reason === 'string')
    .slice(0, 32)
    .map((entry) => ({ key: entry.key, reason: entry.reason }))
}

async function candidateCredentialFingerprint(ctx, candidate) {
  const ref = typeof candidate?.endpointCredentialRef === 'string'
    ? candidate.endpointCredentialRef.trim()
    : ''
  if (!ref) return undefined
  try {
    return (await resolveVisionCredential(ctx, ref)).fingerprint
  } catch {
    return 'unresolved'
  }
}

async function pruneBackoff(backoff, candidates, ctx, at) {
  const valid = new Set()
  const byKey = new Map()
  for (const candidate of candidates) {
    byKey.set(candidate.key, candidate)
    for (const axis of orderedAxes()) valid.add(backoffKey(candidate, axis))
  }
  const credentialCache = new Map()
  for (const [key, entry] of backoff.entries()) {
    if (!valid.has(key)) {
      backoff.delete(key)
      continue
    }
    const until = Number(entry?.until)
    if (Number.isFinite(until) && until <= at) {
      backoff.delete(key)
      continue
    }
    if (entry?.errorClass !== 'auth' || !entry.credentialFingerprint) continue
    const candidate = byKey.get(entry.key)
    if (!candidate) continue
    let currentFingerprint = credentialCache.get(candidate.key)
    if (currentFingerprint === undefined) {
      currentFingerprint = await candidateCredentialFingerprint(ctx, candidate)
      credentialCache.set(candidate.key, currentFingerprint ?? null)
    }
    if (credentialFingerprintChanged(entry.credentialFingerprint, currentFingerprint ?? undefined)) {
      backoff.delete(key)
    }
  }
}

async function restorePersistentStops(backoff, candidates, backgroundStopStore, ctx, at) {
  if (typeof backgroundStopStore?.list !== 'function') return
  let stops
  try { stops = await backgroundStopStore.list() } catch { return }
  if (!Array.isArray(stops) || stops.length === 0) return
  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]))
  const axes = new Set(orderedAxes())
  const credentialCache = new Map()
  for (const stop of stops) {
    const candidate = byKey.get(stop?.key)
    if (!candidate || candidate.endpointFingerprint !== stop?.fingerprint || !axes.has(stop?.axis)) continue
    if (!Number.isFinite(Number(stop.expiresAt)) || Number(stop.expiresAt) <= at) {
      try { await backgroundStopStore.clearStop?.(stop.fingerprint, stop.axis) } catch {}
      continue
    }
    if (stop.errorClass === 'auth' && stop.credentialFingerprint) {
      let currentFingerprint = credentialCache.get(candidate.key)
      if (currentFingerprint === undefined) {
        currentFingerprint = await candidateCredentialFingerprint(ctx, candidate)
        credentialCache.set(candidate.key, currentFingerprint ?? null)
      }
      if (credentialFingerprintChanged(stop.credentialFingerprint, currentFingerprint ?? undefined)) {
        try { await backgroundStopStore.clearStop?.(stop.fingerprint, stop.axis) } catch {}
        continue
      }
    }
    backoff.set(backoffKey(candidate, stop.axis), {
      key: candidate.key,
      fingerprint: candidate.endpointFingerprint,
      axis: stop.axis,
      errorClass: stop.errorClass,
      ...(stop.errorCode ? { errorCode: stop.errorCode } : {}),
      ...(stop.credentialFingerprint ? { credentialFingerprint: stop.credentialFingerprint } : {}),
      retryable: false,
      until: Number(stop.expiresAt),
      persisted: true,
    })
  }
}

function candidateBlockedByNonRetryableFailure(backoff, candidate, at) {
  if (!candidate?.endpointFingerprint) return false
  for (const entry of backoff.values()) {
    if (entry?.retryable !== false) continue
    const until = Number(entry?.until)
    if (Number.isFinite(until) && until <= at) continue
    if (entry?.key !== candidate.key || entry?.fingerprint !== candidate.endpointFingerprint) continue
    if (MODEL_WIDE_NON_RETRYABLE_BACKGROUND_FAILURES.has(entry.errorClass)) return true
  }
  return false
}

async function imageVerdictFor(imageVerdictStore, candidate) {
  if (!candidate?.endpointFingerprint || typeof imageVerdictStore?.get !== 'function') return undefined
  try { return await imageVerdictStore.get(candidate.endpointFingerprint) } catch { return undefined }
}

async function chooseNextWork({ ctx, config, core, store, now, backoff, excluded, imageVerdictStore, backgroundStopStore }) {
  const authority = resolveVisionRoutingAuthority(config)
  excluded.clear()
  if (!authority.backgroundMeasurementActive) return undefined
  const collected = await collectVisionRoutingCandidates(ctx, config, core, store)
  await pruneBackoff(backoff, collected, ctx, now)
  await restorePersistentStops(backoff, collected, backgroundStopStore, ctx, now)
  const candidates = []
  for (const candidate of collected) {
    const verdict = await imageVerdictFor(imageVerdictStore, candidate)
    if (verdict?.state === 'unsupported') {
      excluded.set(candidate.key, { key: candidate.key, reason: 'measured-text-only' })
      continue
    }
    if (candidateBlockedByNonRetryableFailure(backoff, candidate, now)) continue
    const eligibility = unattendedEligibility(ctx, candidate, authority.backgroundMeasurement, core)
    if (eligibility.eligible) {
      candidates.push(candidate)
    } else if (eligibility.reason && candidateNeedsBackgroundWork(candidate)) {
      excluded.set(candidate.key, { key: candidate.key, reason: eligibility.reason })
    }
  }
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
      const key = backoffKey(candidate, axis)
      const deferred = backoff.get(key)
      if (deferred) {
        const blockedUntil = Number(deferred.until)
        if (Number.isFinite(blockedUntil) && blockedUntil <= now) {
          backoff.delete(key)
        } else if (deferred.retryable === false || blockedUntil > now) {
          continue
        }
      }
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
  const current = await collectVisionRoutingCandidates(ctx, live, core, store)
  throwIfBackgroundAborted(signal)
  const same = current.find((entry) => entry?.key === candidate.key)
  const authority = resolveVisionRoutingAuthority(live)
  if (
    !same ||
    same.benchmarkable !== true ||
    same.endpointFingerprint !== candidate.endpointFingerprint ||
    !candidateCanRunInBackground(same, authority.backgroundMeasurement, core)
  ) {
    throw abortError('background backend identity or eligibility changed before evidence publish')
  }
}

async function runAxis({ ctx, config, core, store, candidate, axis, signal, logger, options, onProgress }) {
  const backend = {
    provider: candidate.provider,
    model: candidate.model,
    endpoint: candidate.endpoint,
    config: candidate.endpointConfig,
  }
  const fixtures = listCapabilityBenchmarkFixtures([axis])
  const invoke = createExactCapabilityInvoker(ctx, core, candidate, config, options)
  await invoke.preflight?.(fixtures)
  let completed = 0
  const progressInvoke = async (payload) => {
    const fixture = payload?.fixture
    onProgress?.({
      phase: 'start',
      completed,
      total: fixtures.length,
      fixture: fixture?.id,
      intent: fixture?.intent ?? axis,
    })
    try {
      return await invoke(payload)
    } finally {
      completed += 1
      onProgress?.({
        phase: 'finish',
        completed,
        total: fixtures.length,
        fixture: fixture?.id,
        intent: fixture?.intent ?? axis,
      })
    }
  }
  const result = await runExactCapabilityBenchmark({ backend, invoke: progressInvoke, intents: [axis], signal })
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

function exactAdapterCandidate(ctx, core, provider, model) {
  if (!provider || !model || provider === 'vision-http') return undefined
  try {
    if (typeof core?.adapterAvailable === 'function' && core.adapterAvailable(ctx?.llm, provider) !== true) return undefined
  } catch {
    return undefined
  }
  try {
    const registration = ctx?.llm?.registration?.(provider)
    if (!registration?.adapter && typeof ctx?.llm?.stream !== 'function') return undefined
  } catch {
    if (typeof ctx?.llm?.stream !== 'function') return undefined
  }
  return {
    key: `${provider}/${model}`,
    provider,
    model,
    routeRole: 'user',
    benchmarkable: false,
    evidenceScope: 'explicit-check',
  }
}

export async function runExactVisionCheck({ ctx, config, core, store, provider, model, signal, invokerOptions = {} }) {
  const wantedProvider = typeof provider === 'string' ? provider.trim() : ''
  const wantedModel = typeof model === 'string' ? model.trim() : ''
  if (!wantedProvider || !wantedModel) throw Object.assign(new Error('provider and model are required'), { code: 'VISION_CHECK_BACKEND_REQUIRED' })
  const current = activeSettings(ctx, config)
  const candidates = await collectVisionRoutingCandidates(ctx, current, core, store)
  const candidate = candidates.find((entry) => entry?.provider === wantedProvider && entry?.model === wantedModel)
    ?? exactAdapterCandidate(ctx, core, wantedProvider, wantedModel)
  if (!candidate) {
    throw Object.assign(new Error('selected model is not currently callable for an exact image check'), { code: 'VISION_CHECK_BACKEND_STALE' })
  }
  const fixture = listCapabilityBenchmarkFixtures(['ocr'])[0]
  if (!fixture) throw Object.assign(new Error('image-check fixture is unavailable'), { code: 'VISION_CHECK_INFRASTRUCTURE' })
  const backend = {
    provider: candidate.provider,
    model: candidate.model,
    endpoint: candidate.endpoint,
    config: candidate.endpointConfig,
    fingerprint: candidate.endpointFingerprint ?? `exact:${candidate.provider}/${candidate.model}`,
  }
  const deadlineAt = Date.now() + VISION_CHECK_TIMEOUT_MS
  const remaining = () => Math.max(1, deadlineAt - Date.now())
  const configuredFixtureTimeout = Number(invokerOptions.fixtureTimeoutMs)
  const invoke = createExactCapabilityInvoker(ctx, core, candidate, current, {
    ...invokerOptions,
    fixtureTimeoutMs: Math.min(
      VISION_CHECK_TIMEOUT_MS,
      Number.isFinite(configuredFixtureTimeout) && configuredFixtureTimeout > 0
        ? configuredFixtureTimeout
        : VISION_CHECK_TIMEOUT_MS,
    ),
  })
  await withHardDeadline(
    invoke.preflight?.([fixture]),
    remaining(),
    'exact image check preparation timed out',
  )
  const result = await withHardDeadline(
    invoke({
      backend,
      fixture,
      exactBackend: true,
      allowFallback: false,
      signal,
    }),
    remaining(),
    'exact image check timed out',
  )
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
  imageVerdictStore,
  backgroundStopStore,
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
  const excluded = new Map()

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

  const clearDeferredForCandidate = (candidate) => {
    if (!candidate) return
    for (const [key, entry] of backoff.entries()) {
      if (entry?.key !== candidate.key) continue
      if (candidate.endpointFingerprint && entry?.fingerprint !== candidate.endpointFingerprint) continue
      backoff.delete(key)
    }
  }

  const clearPersistentStopsForCandidate = async (candidate) => {
    if (!candidate?.endpointFingerprint || typeof backgroundStopStore?.clearFingerprint !== 'function') return
    try { await backgroundStopStore.clearFingerprint(candidate.endpointFingerprint) } catch {}
  }

  const candidateForSelection = async (provider, model) => {
    const wantedProvider = typeof provider === 'string' ? provider.trim() : ''
    const wantedModel = typeof model === 'string' ? model.trim() : ''
    if (!wantedProvider || !wantedModel) return undefined
    const live = activeSettings(ctx, config)
    const candidates = await collectVisionRoutingCandidates(ctx, live, core, store)
    return candidates.find((entry) => entry?.provider === wantedProvider && entry?.model === wantedModel)
  }

  const markCandidateUnsupported = async (candidate) => {
    if (!candidate) return
    excluded.set(candidate.key, { key: candidate.key, reason: 'measured-text-only' })
    clearDeferredForCandidate(candidate)
    await clearPersistentStopsForCandidate(candidate)
    if (candidate.endpointFingerprint && typeof imageVerdictStore?.markUnsupported === 'function') {
      try {
        await imageVerdictStore.markUnsupported({
          fingerprint: candidate.endpointFingerprint,
          key: candidate.key,
          provider: candidate.provider,
          model: candidate.model,
          measuredAt: Number(now()),
        })
      } catch (error) {
        logger?.warn?.('vision-router: failed to persist image rejection verdict backend=%s error=%s', candidate.key, bounded(error?.message ?? error))
      }
    }
  }

  const recordImageUnsupported = async (provider, model) => {
    try {
      const candidate = await candidateForSelection(provider, model)
      if (!candidate) return false
      await markCandidateUnsupported(candidate)
      schedule(0)
      return true
    } catch {
      return false
    }
  }

  const recordImageSupported = async (provider, model) => {
    try {
      const candidate = await candidateForSelection(provider, model)
      if (!candidate) return false
      excluded.delete(candidate.key)
      clearDeferredForCandidate(candidate)
      await clearPersistentStopsForCandidate(candidate)
      if (candidate.endpointFingerprint && typeof imageVerdictStore?.clear === 'function') {
        try { await imageVerdictStore.clear(candidate.endpointFingerprint) } catch {}
      }
      schedule(0)
      return true
    } catch {
      return false
    }
  }

  const settingsChanged = () => {
    const live = activeSettings(ctx, config)
    const nextAuthority = resolveVisionRoutingAuthority(live)
    const becameActive = !lastAuthority.backgroundMeasurementActive && nextAuthority.backgroundMeasurementActive
    lastAuthority = nextAuthority
    excluded.clear()
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
    excluded.clear()
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
    const becameActive = !lastAuthority.backgroundMeasurementActive && authority.backgroundMeasurementActive
    if (becameActive) lastForegroundAt = Math.min(lastForegroundAt, currentNow - idleMs)
    lastAuthority = authority
    if (!authority.backgroundMeasurementActive) {
      excluded.clear()
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
      work = await chooseNextWork({
        ctx,
        config: current,
        core,
        store,
        now: currentNow,
        backoff,
        excluded,
        imageVerdictStore,
        backgroundStopStore,
      })
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
    runningWork = {
      ...work,
      startedAt: Number(now()),
      completed: 0,
      total: Math.max(1, listCapabilityBenchmarkFixtures([work.axis]).length),
      currentFixture: undefined,
    }
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
        onProgress(progress = {}) {
          if (!runningWork || runningWork.candidate.key !== work.candidate.key || runningWork.axis !== work.axis) return
          const completed = Math.max(0, Number(progress.completed) || 0)
          const total = Math.max(1, Number(progress.total) || Number(runningWork.total) || 1)
          runningWork.completed = Math.min(total, completed)
          runningWork.total = total
          runningWork.currentFixture = typeof progress.fixture === 'string' ? progress.fixture : runningWork.currentFixture
        },
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
        const failure = classifyBackgroundBenchmarkFailure(error)
        const policy = backgroundFailurePolicy(failure.errorClass)
        const failureAt = Number(now())
        const transientDelay = Number.isFinite(Number(policy.retryAfterMs)) && Number(policy.retryAfterMs) > 0
          ? Number(policy.retryAfterMs)
          : retryMs
        const persistentTtl = Number.isFinite(Number(policy.ttlMs)) && Number(policy.ttlMs) > 0
          ? Number(policy.ttlMs)
          : undefined
        const until = failure.retryable
          ? failureAt + transientDelay
          : policy.persist === true && persistentTtl !== undefined
            ? failureAt + persistentTtl
            : undefined
        const credentialFingerprint = policy.credentialScoped === true
          ? await candidateCredentialFingerprint(ctx, work.candidate)
          : undefined

        if (failure.errorClass === 'unsupported-image') {
          await markCandidateUnsupported(work.candidate)
        } else {
          backoff.set(key, {
            key: work.candidate.key,
            fingerprint: work.candidate.endpointFingerprint,
            axis: work.axis,
            ...failure,
            ...(credentialFingerprint ? { credentialFingerprint } : {}),
            ...(until !== undefined ? { until } : {}),
          })
        }

        if (
          policy.persist === true &&
          until !== undefined &&
          failure.errorClass !== 'unsupported-image' &&
          typeof backgroundStopStore?.mark === 'function'
        ) {
          try {
            await backgroundStopStore.mark({
              fingerprint: work.candidate.endpointFingerprint,
              key: work.candidate.key,
              provider: work.candidate.provider,
              model: work.candidate.model,
              axis: work.axis,
              errorClass: failure.errorClass,
              errorCode: failure.errorCode,
              credentialFingerprint,
              recordedAt: failureAt,
              expiresAt: until,
            })
          } catch (persistError) {
            logger?.warn?.('vision-router: failed to persist background stop backend=%s axis=%s error=%s', work.candidate.key, work.axis, bounded(persistError?.message ?? persistError))
          }
        }
        logger?.warn?.(
          'vision-router: background benchmark deferred backend=%s axis=%s class=%s retryable=%s error=%s',
          work.candidate.key,
          work.axis,
          failure.errorClass,
          failure.retryable ? 'yes' : 'no',
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
    recordImageUnsupported,
    recordImageSupported,
    snapshot() {
      const currentNow = Number(now())
      const startedAt = Number(runningWork?.startedAt)
      const elapsedMs = runningWork && Number.isFinite(startedAt)
        ? Math.max(0, currentNow - startedAt)
        : 0
      return {
        stopped,
        activeForeground,
        activeManualBenchmarks,
        lastForegroundAt,
        idleRemainingMs: Math.max(0, lastForegroundAt + idleMs - currentNow),
        running: runningWork ? {
          key: runningWork.candidate.key,
          axis: runningWork.axis,
          completed: Math.max(0, Number(runningWork.completed) || 0),
          total: Math.max(1, Number(runningWork.total) || 1),
          currentFixture: runningWork.currentFixture,
          startedAt,
          elapsedMs,
        } : undefined,
        deferred: publicBackoffEntries(backoff, currentNow),
        excluded: publicExcludedEntries(excluded),
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
  const logger = options.logger ?? ctx?.logger
  const imageVerdictStore = options.imageVerdictStore ?? createImageInputVerdictStore({ logger })
  const backgroundStopStore = options.backgroundStopStore ?? createBackgroundBenchmarkStopStore({ logger })
  const profiler = createBackgroundCapabilityProfiler({
    ctx,
    config,
    core,
    store,
    logger,
    ...options,
    imageVerdictStore,
    backgroundStopStore,
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
            // This is a sanitized read-only status view. The Benchmark GET
            // already exposes the same public candidate identities remotely;
            // keep background progress equally visible in remote settings UI.
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
                excluded: state.excluded,
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
          let body = {}
          try {
            body = await readJsonBody(req)
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
            await profiler.recordImageSupported(body.provider, body.model)
            sendJson(res, 200, result)
          } catch (error) {
            const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError' || /timed out|timeout|deadline/i.test(String(error?.message ?? ''))
            const failureClass = error?.benchmarkClass ?? classifyCapabilityBenchmarkFailure(error)
            const unsupportedImage = !timedOut && failureClass === 'unsupported-image'
            if (unsupportedImage) await profiler.recordImageUnsupported(body.provider, body.model)
            const code = timedOut
              ? 'VISION_CHECK_TIMEOUT'
              : unsupportedImage
                ? 'VISION_CHECK_UNSUPPORTED_IMAGE'
                : (error?.code ?? 'VISION_CHECK_FAILED')
            const clientError = new Set([
              'VISION_CHECK_BODY_TOO_LARGE',
              'VISION_CHECK_INVALID_JSON',
              'VISION_CHECK_BACKEND_REQUIRED',
              'VISION_CHECK_BACKEND_STALE',
            ]).has(code)
            sendJson(res, unsupportedImage ? 422 : clientError ? 400 : 502, {
              ok: false,
              code,
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
