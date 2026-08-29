import {
  capabilityProfileAxisMeasuredAt,
  createCapabilityProfileStore,
  runExactCapabilityBenchmark,
} from './vision-capability-probe.js'
import { collectVisionRoutingCandidates } from './vision-routing-evidence.js'
import { BENCHMARK_AXES } from './vision-capability-router.js'
import {
  CAPABILITY_BENCHMARK_SUITE_REVISION,
  listCapabilityBenchmarkFixtures,
} from './vision-capability-benchmark.js'
import { resolveVisionCredential } from './vision-capability-identity.js'
import { redactDiagnosticText } from './diagnostic-redaction.js'
import {
  hardenCapabilityBenchmarkFixture,
  verifyAndStripBenchmarkVisualProof,
  withHardDeadline,
} from './vision-capability-benchmark-hardening.js'
import {
  assertManualMeasurementAuthority,
  grantManualMeasurementFromUserAction,
} from './vision-routing-authority.js'

export const CAPABILITY_BENCHMARK_PATH = '/_dsh/vision-router/capability-benchmark'
export const CAPABILITY_BENCHMARK_QUICK_INTENTS = Object.freeze(['ocr', 'general'])
export const CAPABILITY_BENCHMARK_MODE_REQUESTS = Object.freeze({ quick: 3, full: 6 })

const REQUEST_MAX_BYTES = 32 * 1024
const DEFAULT_RUN_TIMEOUT_MS = 13 * 60 * 1000
const DEFAULT_FIXTURE_TIMEOUT_MS = 120 * 1000
const DEFAULT_BENCHMARK_MAX_TOKENS = 512
const JOB_HISTORY_LIMIT = 64
const MAX_ACTIVE_JOBS = 32
const MAX_JOB_RECORDS = JOB_HISTORY_LIMIT + MAX_ACTIVE_JOBS

let benchmarkSharpPromise

function bounded(value, max = 400) {
  return redactDiagnosticText(value?.message ?? value, max)
}

function activeSettings(ctx, fallback) {
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    return value && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req, maxBytes = REQUEST_MAX_BYTES) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > maxBytes) {
      const error = new Error('request body too large')
      error.code = 'CAPABILITY_BENCHMARK_BODY_TOO_LARGE'
      throw error
    }
    chunks.push(bytes)
  }
  if (chunks.length === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    const error = new Error('invalid JSON request body')
    error.code = 'CAPABILITY_BENCHMARK_INVALID_JSON'
    throw error
  }
}

function mergedSignal(...signals) {
  const usable = signals.filter((signal) => signal && typeof signal === 'object')
  if (usable.length === 0) return undefined
  if (usable.length === 1) return usable[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(usable)
  return usable[0]
}

async function resolvedCredentialValue(ctx, ref) {
  return (await resolveVisionCredential(ctx, ref)).value
}

function directProviderFor(candidate, config, core) {
  if (candidate?.provider !== 'vision-http') {
    if (
      candidate?.evidenceScope !== 'endpoint' ||
      typeof candidate?.endpoint !== 'string' ||
      candidate.endpoint === '' ||
      candidate?.endpointConfig?.api !== 'openai-completions'
    ) return undefined
    return {
      name: candidate.provider,
      baseURL: candidate.endpoint,
      model: candidate.model,
      apiKeyEnv: typeof candidate.endpointCredentialRef === 'string' ? candidate.endpointCredentialRef : '',
      maxTokens: DEFAULT_BENCHMARK_MAX_TOKENS,
    }
  }
  const targetModel = String(candidate.model ?? '')
  let locals = []
  try { locals = core.localProvidersOf(config) } catch { locals = [] }
  for (const provider of Array.isArray(locals) ? locals : []) {
    if (`${provider.name}/${provider.model}` === targetModel) return provider
  }
  let http = []
  try { http = core.httpProvidersOf(config) } catch { http = [] }
  for (const provider of Array.isArray(http) ? http : []) {
    if (`${provider.name}/${provider.model}` === targetModel) return provider
  }
  return undefined
}

async function loadBenchmarkSharp(core) {
  if (typeof core?.loadSharp === 'function') return core.loadSharp()
  if (!benchmarkSharpPromise) {
    benchmarkSharpPromise = import('sharp')
      .then((mod) => mod.default ?? mod)
      .catch((cause) => {
        benchmarkSharpPromise = undefined
        const error = new Error('sharp renderer is unavailable for capability benchmark')
        error.code = 'CAPABILITY_BENCHMARK_INFRASTRUCTURE'
        error.cause = cause
        throw error
      })
  }
  return benchmarkSharpPromise
}

export async function renderCapabilityBenchmarkFixturePng(core, fixture) {
  try {
    const sharp = await loadBenchmarkSharp(core)
    return await sharp(Buffer.from(String(fixture?.svg ?? ''), 'utf8'), { failOn: 'none' }).png().toBuffer()
  } catch (cause) {
    if (cause?.code === 'CAPABILITY_BENCHMARK_INFRASTRUCTURE') throw cause
    const error = new Error(`capability fixture rendering failed: ${bounded(cause?.message ?? cause, 220)}`)
    error.code = 'CAPABILITY_BENCHMARK_INFRASTRUCTURE'
    error.cause = cause
    throw error
  }
}

function openAIMessages(png, prompt) {
  return [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
      { type: 'text', text: String(prompt ?? '') },
    ],
  }]
}

async function adapterMessages(ctx, png, fixture) {
  const attachments = ctx?.get?.('attachments')
  if (!attachments || typeof attachments.saveImage !== 'function') {
    const error = new Error('attachment service is unavailable for exact adapter benchmark')
    error.code = 'CAPABILITY_BENCHMARK_INFRASTRUCTURE'
    throw error
  }
  const ref = await attachments.saveImage({
    data: png,
    mediaType: 'image/png',
    name: `vision-router-benchmark-${String(fixture?.id ?? 'fixture')}.png`,
  })
  return [{
    role: 'user',
    content: [
      { type: 'image', attachment: ref },
      { type: 'text', text: String(fixture?.prompt ?? '') },
    ],
  }]
}

function failureError(failure, fallback) {
  if (failure instanceof Error) return failure
  const error = new Error(
    failure && typeof failure.message === 'string' && failure.message !== ''
      ? failure.message
      : String(fallback ?? 'vision adapter failed'),
  )
  if (failure && typeof failure === 'object') {
    for (const key of ['code', 'status', 'name']) {
      if (failure[key] !== undefined) error[key] = failure[key]
    }
  }
  return error
}

async function collectStreamText(streamLike) {
  const stream = await streamLike
  let text = ''
  for await (const chunk of stream) {
    if (chunk && typeof chunk.text === 'string') text += chunk.text
    if (chunk?.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error' || kind === 'aborted') throw failureError(chunk.reason?.failure, kind)
    }
    if (chunk?.type === 'error' || chunk?.type === 'aborted') throw failureError(chunk.failure, chunk.type)
  }
  return text
}

function tagInvocationError(value) {
  const error = value instanceof Error ? value : failureError(value)
  error.benchmarkFatal = true
  error.benchmarkClass = error.benchmarkClass ?? classifyCapabilityBenchmarkFailure(error)
  return error
}

function mayUseExactAdapterBridge(core, error, directProvider) {
  if (directProvider === undefined) return false
  try {
    const classification = core?.classifyVisionFailure?.(error)
    const kinds = core?.VISION_FAILURE_KINDS
    const allowed = new Set([
      kinds?.INVALID_REQUEST,
      kinds?.NETWORK,
      kinds?.OTHER,
    ].filter(Boolean))
    return classification && allowed.has(classification.kind)
  } catch {
    return false
  }
}

function benchmarkMaxTokensForProvider(provider) {
  const configured = Number(provider?.maxTokens)
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_BENCHMARK_MAX_TOKENS
  return Math.min(DEFAULT_BENCHMARK_MAX_TOKENS, Math.floor(configured))
}

export function createExactCapabilityInvoker(ctx, core, candidate, config, options = {}) {
  const fixtureTimeoutMs = Math.max(1_000, Number(options.fixtureTimeoutMs) || DEFAULT_FIXTURE_TIMEOUT_MS)
  const renderFixture = options.renderFixture ?? ((fixture) => renderCapabilityBenchmarkFixturePng(core, fixture))
  const callDirect = options.callDirect ?? ((provider, messages, callOptions) =>
    core.callOpenAICompatible(provider, messages, callOptions))
  const streamExact = options.streamExact ?? ((callOptions) => ctx.llm.stream(callOptions))
  const now = typeof options.now === 'function' ? options.now : Date.now
  const prepared = new Map()

  const prepareFixture = async (fixture) => {
    const key = String(fixture?.id ?? '')
    if (prepared.has(key)) return prepared.get(key)
    const hardenedFixture = hardenCapabilityBenchmarkFixture(fixture)
    const png = await renderFixture(hardenedFixture)
    const value = candidate.provider === 'vision-http'
      ? {
          png,
          prompt: hardenedFixture.prompt,
          challenge: hardenedFixture.visualProofChallenge,
        }
      : {
          png,
          prompt: hardenedFixture.prompt,
          challenge: hardenedFixture.visualProofChallenge,
          messages: await adapterMessages(ctx, png, hardenedFixture),
        }
    prepared.set(key, value)
    return value
  }

  const invoke = async ({ backend, fixture, exactBackend, allowFallback, signal }) => {
    if (exactBackend !== true || allowFallback !== false) {
      throw new Error('exact capability invoker refuses non-exact/fallback benchmark requests')
    }
    try {
      const assets = await withHardDeadline(
        prepareFixture(fixture),
        fixtureTimeoutMs,
        'capability benchmark fixture preparation timed out',
      )
      const callSignal = mergedSignal(signal, AbortSignal.timeout(fixtureTimeoutMs))
      const exactHttpProvider = directProviderFor(candidate, config, core)
      const callExactHttp = async () => {
        if (exactHttpProvider === undefined) {
          const error = new Error('exact HTTP bridge is unavailable for this benchmark backend')
          error.code = 'CAPABILITY_BENCHMARK_PROTOCOL'
          throw error
        }
        const started = Number(now())
        const output = await withHardDeadline(
          callDirect(exactHttpProvider, openAIMessages(assets.png, assets.prompt), {
            maxTokens: benchmarkMaxTokensForProvider(exactHttpProvider),
            signal: callSignal,
            resolveCredential: (ref) => resolvedCredentialValue(ctx, ref),
          }),
          fixtureTimeoutMs,
          'capability benchmark HTTP fixture timed out',
        )
        const finished = Number(now())
        return {
          output,
          latencyMs: Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : undefined,
        }
      }

      let output
      let transport
      let latencyMs
      if (candidate.provider === 'vision-http') {
        const direct = await callExactHttp()
        output = direct.output
        latencyMs = direct.latencyMs
        transport = 'http-direct'
      } else {
        const started = Number(now())
        try {
          output = await withHardDeadline(
            collectStreamText(streamExact({
              provider: candidate.provider,
              model: candidate.model,
              messages: assets.messages,
              maxTokens: DEFAULT_BENCHMARK_MAX_TOKENS,
              reasoningEffort: undefined,
              signal: callSignal,
            })),
            fixtureTimeoutMs,
            'capability benchmark adapter fixture timed out',
          )
          const finished = Number(now())
          latencyMs = Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : undefined
          transport = 'adapter'
        } catch (adapterError) {
          if (!mayUseExactAdapterBridge(core, adapterError, exactHttpProvider)) throw adapterError
          const direct = await callExactHttp()
          output = direct.output
          latencyMs = direct.latencyMs
          transport = 'adapter-bridge'
        }
      }
      const verifiedOutput = verifyAndStripBenchmarkVisualProof(output, assets.challenge)
      return { output: verifiedOutput, usedFingerprint: backend.fingerprint, transport, latencyMs }
    } catch (error) {
      throw tagInvocationError(error)
    }
  }

  invoke.preflight = async (fixtures = []) => {
    for (const fixture of fixtures) {
      await withHardDeadline(
        prepareFixture(fixture),
        fixtureTimeoutMs,
        'capability benchmark preflight timed out',
      )
    }
  }
  return invoke
}

function normalizeMode(value) {
  if (value === 'full') return value
  return 'quick'
}

function modeIntents(mode) {
  if (mode === 'full') return undefined
  return [...CAPABILITY_BENCHMARK_QUICK_INTENTS]
}

function profileCoverage(record) {
  const scores = record?.scores && typeof record.scores === 'object' ? record.scores : {}
  return BENCHMARK_AXES.filter((axis) => Number.isFinite(Number(scores[axis])))
}

async function declaredImageState(ctx, core, config, candidate) {
  if (candidate?.provider === 'vision-http') return 'declared'
  try {
    const info = typeof ctx?.llm?.resolveModelInfo === 'function'
      ? await ctx.llm.resolveModelInfo(candidate.provider, candidate.model)
      : undefined
    const decision = core?.decideVisionBackendCapability?.(
      info,
      candidate.provider,
      candidate.model,
      config?.extraVisionModels,
    )
    if (decision?.image === true) return 'declared'
    if (decision?.image === false) return 'text-only'
  } catch {
    // Metadata is advisory. Exact configured routes remain force-testable.
  }
  return 'unknown'
}

async function publicCandidate(ctx, core, config, store, candidate) {
  const record = candidate?.endpointFingerprint ? await store.get(candidate.endpointFingerprint) : undefined
  const coverage = record ? profileCoverage(record) : []
  const measuredAtByAxis = Object.fromEntries(coverage.map((axis) => [axis, capabilityProfileAxisMeasuredAt(record, axis)]))
  const measured = record && coverage.length > 0
    ? {
        scores: record.scores,
        measuredAt: record.measuredAt,
        measuredAtByAxis,
        benchmarkLatencyMs: record.benchmarkLatencyMs,
        benchmarkMedianLatencyMs: record.benchmarkMedianLatencyMsByAxis,
        fixtureCount: record.fixtureCount,
        fixtureCountByAxis: record.fixtureCountByAxis,
        failureCount: record.failureCount,
        suiteRevision: record.suiteRevision,
        measuredAxes: coverage,
        coverage,
        coverageKind: coverage.length === BENCHMARK_AXES.length ? 'full' : 'partial',
        ...(record.groundingDiagnostic ? { groundingDiagnostic: record.groundingDiagnostic } : {}),
      }
    : undefined
  return {
    key: candidate.key,
    provider: candidate.provider,
    model: candidate.model,
    local: candidate.local === true,
    cloudCostWarning: candidate.local !== true && candidate.cost !== 0,
    benchmarkable: candidate.benchmarkable === true,
    evidenceScope: candidate.evidenceScope,
    protocol: candidate?.endpointConfig?.api,
    fingerprint: candidate.endpointFingerprint,
    imageCapability: await declaredImageState(ctx, core, config, candidate),
    ...(measured ? { measured } : {}),
  }
}

export function classifyCapabilityBenchmarkFailure(value) {
  const text = bounded(value?.message ?? value, 800).toLowerCase()
  const status = Number(value?.status)
  const code = String(value?.code ?? '').toUpperCase()
  if (value?.name === 'TimeoutError' || code.includes('TIMEOUT') || /timeout|timed out|deadline/.test(text)) return 'timeout'
  if (value?.name === 'AbortError' || /abort|cancelled|canceled/.test(text)) return 'cancelled'
  if (code === 'CAPABILITY_BENCHMARK_VISUAL_PROOF_FAILED') return 'visual-proof'
  if (status === 401 || status === 403 || /unauthor|forbidden|credential|api[ _-]?key|authentication/.test(text)) return 'auth'
  if (status === 429 || /rate.?limit|too many requests|quota/.test(text)) return 'rate-limit'
  if (
    /MODEL_DOES_NOT_SUPPORT_IMAGES|IMAGE_(?:INPUT_)?(?:NOT_SUPPORTED|UNSUPPORTED)|(?:NOT_SUPPORTED|UNSUPPORTED)_IMAGE/.test(code) ||
    /does not (?:support|accept) image(?: input)?|cannot (?:accept|handle) image(?: input)?|unsupported[_ -]?content[^\n]{0,80}image|image input.*(?:not support|not accepted|unsupported|rejected)|text[- ]only/.test(text)
  ) return 'unsupported-image'
  if (/unsupported protocol|openai-responses|anthropic|messages api/.test(text)) return 'protocol'
  if (code.includes('INFRASTRUCTURE') || /sharp renderer|fixture rendering|attachment service/.test(text)) return 'infrastructure'
  if (/fetch failed|network|econn|enotfound|socket|dns|connection refused/.test(text)) return 'network'
  return 'provider'
}

function firstInvocationFailure(results) {
  if (!Array.isArray(results)) return undefined
  const item = results.find((entry) => typeof entry?.details?.error === 'string' && entry.details.error !== '')
  if (!item) return undefined
  return {
    message: item.details.error,
    class: classifyCapabilityBenchmarkFailure(item.details.error),
  }
}

function cleanCoordinateBox(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out = {}
  for (const key of ['x1', 'y1', 'x2', 'y2']) {
    const n = Number(value[key])
    if (!Number.isFinite(n)) return undefined
    out[key] = Number(n.toFixed(3))
  }
  return out
}

function groundingDiagnosticFromResults(results) {
  if (!Array.isArray(results)) return undefined
  const result = results.find((entry) => entry?.intent === 'grounding')
  if (!result) return undefined
  const details = result.details && typeof result.details === 'object' ? result.details : {}
  const parsed = Array.isArray(details.parsed)
    ? details.parsed.slice(0, 8).map((item) => Number.isFinite(Number(item)) ? Number(item) : bounded(item, 40))
    : undefined
  return {
    score: Number.isFinite(Number(result.score)) ? Number(result.score) : 0,
    iou: Number.isFinite(Number(details.iou)) ? Number(details.iou) : 0,
    formatValid: details.formatValid === true,
    parseSource: bounded(details.parseSource, 64),
    coordinateSpace: bounded(details.coordinateSpace, 64),
    responseShape: bounded(details.responseShape, 64),
    normalized: cleanCoordinateBox(details.normalized),
    ...(parsed ? { parsed } : {}),
    candidateSpaces: Array.isArray(details.candidateSpaces)
      ? details.candidateSpaces.slice(0, 8).map((item) => bounded(item, 48))
      : [],
  }
}

function publicJob(job, position) {
  if (!job) return undefined
  const elapsedMs = job.startedAt
    ? Math.max(0, (job.finishedAt ?? Date.now()) - job.startedAt)
    : 0
  return {
    id: job.id,
    key: job.key,
    mode: job.mode,
    state: job.state,
    position: job.state === 'queued' ? position : 0,
    completed: job.completed,
    total: job.total,
    currentIntent: job.currentIntent,
    currentFixture: job.currentFixture,
    enqueuedAt: job.enqueuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs,
    errorClass: job.errorClass,
    errorCode: job.errorCode,
    error: job.error,
    ...(job.groundingDiagnostic ? { groundingDiagnostic: job.groundingDiagnostic } : {}),
  }
}

function statusForError(error) {
  const code = error?.code
  if (code === 'CAPABILITY_BENCHMARK_AUTHORITY_REQUIRED') return 403
  if (code === 'CAPABILITY_BENCHMARK_QUEUE_FULL') return 429
  if (code === 'CAPABILITY_BENCHMARK_BODY_TOO_LARGE') return 413
  if (
    code === 'CAPABILITY_BENCHMARK_NO_USABLE_EVIDENCE' ||
    code === 'CAPABILITY_BENCHMARK_INCOMPLETE' ||
    code === 'CAPABILITY_BENCHMARK_VISUAL_PROOF_FAILED'
  ) return 422
  if (
    code === 'CAPABILITY_BENCHMARK_BACKEND_REQUIRED' ||
    code === 'CAPABILITY_BENCHMARK_BACKEND_STALE' ||
    code === 'CAPABILITY_BENCHMARK_ENDPOINT_UNKNOWN' ||
    code === 'CAPABILITY_BENCHMARK_INVALID_JSON' ||
    code === 'CAPABILITY_BENCHMARK_JOB_REQUIRED'
  ) return 400
  return 500
}

export function createCapabilityBenchmarkManager(ctx, config, core, options = {}) {
  const logger = options.logger ?? ctx?.logger
  const store = options.store ?? createCapabilityProfileStore({ logger })
  const backgroundProfiler = options.backgroundProfiler ?? store?.backgroundProfiler
  const runBenchmark = options.runBenchmark ?? runExactCapabilityBenchmark
  const runTimeoutMs = Math.max(10_000, Number(options.runTimeoutMs) || DEFAULT_RUN_TIMEOUT_MS)
  const queue = []
  const jobs = new Map()
  let sequence = 0
  let running
  let pumping = false
  let pumpPromise = Promise.resolve()
  let candidateCache
  let candidateCacheAt = 0

  const candidates = async (force = false) => {
    const now = Date.now()
    if (!force && candidateCache && now - candidateCacheAt < 1500) return candidateCache
    const current = activeSettings(ctx, config)
    const rows = await collectVisionRoutingCandidates(ctx, current, core, store)
    candidateCache = { current, rows }
    candidateCacheAt = now
    return candidateCache
  }

  const candidateFor = async (key) => {
    const wanted = typeof key === 'string' ? key.trim() : ''
    if (wanted === '') {
      const error = new Error('backend key is required')
      error.code = 'CAPABILITY_BENCHMARK_BACKEND_REQUIRED'
      throw error
    }
    const { current, rows } = await candidates(true)
    const candidate = rows.find((row) => row.key === wanted)
    if (!candidate) {
      const error = new Error('backend is no longer in the current Vision Router candidate pool')
      error.code = 'CAPABILITY_BENCHMARK_BACKEND_STALE'
      throw error
    }
    if (candidate.benchmarkable !== true || !candidate.endpoint || !candidate.endpointFingerprint) {
      const error = new Error('this backend has no stable benchmark fingerprint and cannot persist exact benchmark evidence')
      error.code = 'CAPABILITY_BENCHMARK_ENDPOINT_UNKNOWN'
      throw error
    }
    return { current, candidate }
  }

  const executeCandidate = async ({ candidate, current, intents, signal, onProgress }) => {
    const backend = {
      provider: candidate.provider,
      model: candidate.model,
      endpoint: candidate.endpoint,
      config: candidate.endpointConfig,
    }
    const expectedFingerprint = candidate.endpointFingerprint
    const baseInvoke = createExactCapabilityInvoker(ctx, core, candidate, current, options)
    await withHardDeadline(
      baseInvoke.preflight?.(listCapabilityBenchmarkFixtures(intents)),
      runTimeoutMs,
      'capability benchmark preflight exceeded the run deadline',
    )
    let completed = 0
    const invoke = async (payload) => {
      onProgress?.({
        phase: 'start',
        completed,
        fixture: payload.fixture?.id,
        intent: payload.fixture?.intent,
      })
      try {
        return await baseInvoke(payload)
      } finally {
        completed += 1
        onProgress?.({
          phase: 'finish',
          completed,
          fixture: payload.fixture?.id,
          intent: payload.fixture?.intent,
        })
      }
    }
    const result = await withHardDeadline(
      runBenchmark({ backend, invoke, intents, signal }),
      runTimeoutMs,
      'capability benchmark exceeded the run deadline',
    )
    if (result?.record?.fingerprint !== expectedFingerprint) {
      const error = new Error('benchmark result fingerprint changed while the run was active')
      error.code = 'CAPABILITY_BENCHMARK_FINGERPRINT_CHANGED'
      throw error
    }
    const firstFailure = firstInvocationFailure(result?.results)
    if (Number(result?.record?.failureCount) > 0) {
      const error = new Error(
        firstFailure
          ? `capability benchmark incomplete: ${bounded(firstFailure.message, 260)}`
          : 'capability benchmark incomplete: one or more fixture calls failed',
      )
      error.code = 'CAPABILITY_BENCHMARK_INCOMPLETE'
      error.benchmarkClass = firstFailure?.class ?? 'provider'
      throw error
    }
    const record = await store.put(result.record)
    try { await backgroundProfiler?.recordImageSupported?.(candidate.provider, candidate.model) } catch {}
    logger?.info?.(
      'vision-router: capability benchmark completed backend=%s fixtures=%d failures=%d',
      candidate.key,
      result.record.fixtureCount,
      result.record.failureCount,
    )
    return {
      ok: true,
      key: candidate.key,
      record,
      coverage: profileCoverage(record),
      results: result.results,
    }
  }

  const acquireManualLease = (job) => {
    if (!job || job.manualLease === true) return
    job.manualLease = true
    try { backgroundProfiler?.manualStart?.() } catch {}
  }

  const releaseManualLease = (job) => {
    if (!job || job.manualLease !== true) return
    job.manualLease = false
    try { backgroundProfiler?.manualEnd?.() } catch {}
  }

  const pruneHistory = () => {
    const terminal = [...jobs.values()]
      .filter((job) => job.state !== 'queued' && job.state !== 'running')
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    for (const job of terminal.slice(JOB_HISTORY_LIMIT)) jobs.delete(job.id)
    if (jobs.size <= MAX_JOB_RECORDS) return
    const oldestTerminal = [...jobs.values()]
      .filter((job) => job.state !== 'queued' && job.state !== 'running')
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
    for (const job of oldestTerminal) {
      if (jobs.size <= MAX_JOB_RECORDS) break
      jobs.delete(job.id)
    }
  }

  const executeJob = async (job) => {
    const controller = new AbortController()
    job.controller = controller
    job.state = 'running'
    job.startedAt = Date.now()
    running = job
    try {
      assertManualMeasurementAuthority(job.authority)
      const { current, candidate } = await candidateFor(job.key)
      job.provider = candidate.provider
      job.model = candidate.model
      if (candidate.endpointFingerprint !== job.fingerprint) {
        const error = new Error('queued backend changed before the benchmark started')
        error.code = 'CAPABILITY_BENCHMARK_BACKEND_STALE'
        throw error
      }
      const signal = mergedSignal(controller.signal, AbortSignal.timeout(runTimeoutMs))
      const execution = await executeCandidate({
        candidate,
        current,
        intents: modeIntents(job.mode),
        signal,
        onProgress(progress) {
          job.completed = Math.min(job.total, Math.max(0, Number(progress.completed) || 0))
          job.currentIntent = progress.intent
          job.currentFixture = progress.fixture
        },
      })
      const groundingDiagnostic = execution.record?.groundingDiagnostic ?? groundingDiagnosticFromResults(execution.results)
      job.groundingDiagnostic = groundingDiagnostic
      if (job.groundingDiagnostic) {
        logger?.info?.(
          'vision-router: capability grounding diagnostic backend=%s score=%s parse=%s space=%s shape=%s iou=%s box=%j',
          job.key,
          job.groundingDiagnostic.score,
          job.groundingDiagnostic.parseSource || 'none',
          job.groundingDiagnostic.coordinateSpace || 'none',
          job.groundingDiagnostic.responseShape || 'none',
          job.groundingDiagnostic.iou,
          job.groundingDiagnostic.normalized,
        )
      }
      job.state = 'completed'
      job.completed = job.total
    } catch (error) {
      if (job.cancelRequested) {
        job.state = 'cancelled'
        job.errorClass = 'cancelled'
        job.errorCode = 'CAPABILITY_BENCHMARK_CANCELLED'
        job.error = 'benchmark cancelled'
      } else {
        job.state = 'failed'
        job.errorClass = error?.benchmarkClass ?? classifyCapabilityBenchmarkFailure(error)
        job.errorCode = error?.code ?? (job.errorClass === 'timeout' ? 'CAPABILITY_BENCHMARK_TIMEOUT' : 'CAPABILITY_BENCHMARK_FAILED')
        job.error = bounded(error?.message ?? error, 360)
        if (job.errorClass === 'unsupported-image') {
          try { await backgroundProfiler?.recordImageUnsupported?.(job.provider, job.model) } catch {}
        }
      }
    } finally {
      job.finishedAt = Date.now()
      job.controller = undefined
      job.currentIntent = undefined
      job.currentFixture = undefined
      if (running?.id === job.id) running = undefined
      releaseManualLease(job)
      pruneHistory()
    }
  }

  const pump = () => {
    if (pumping) return pumpPromise
    pumping = true
    pumpPromise = (async () => {
      try {
        while (queue.length > 0) {
          const job = queue.shift()
          if (!job || job.state !== 'queued') continue
          await executeJob(job)
        }
      } finally {
        pumping = false
      }
    })()
    return pumpPromise
  }

  return {
    store,
    async snapshot() {
      pruneHistory()
      const { current, rows } = await candidates()
      const publicCandidates = await Promise.all(rows.map((row) => publicCandidate(ctx, core, current, store, row)))
      const queuedPositions = new Map(queue.map((job, index) => [job.id, index + 1]))
      const publicJobs = [...jobs.values()]
        .sort((a, b) => {
          const rank = (job) => job.state === 'running' ? 0 : job.state === 'queued' ? 1 : 2
          return rank(a) - rank(b) || (b.enqueuedAt ?? 0) - (a.enqueuedAt ?? 0)
        })
        .map((job) => publicJob(job, queuedPositions.get(job.id) ?? 0))

      for (const candidate of publicCandidates) {
        const diagnostic = candidate?.measured?.groundingDiagnostic
        if (!diagnostic) continue
        const same = publicJobs.filter((job) => job.key === candidate.key)
        for (const job of same) {
          if (job.state !== 'running' && job.state !== 'queued' && !job.groundingDiagnostic) {
            job.groundingDiagnostic = diagnostic
          }
        }
        if (same.length === 0) {
          const measuredAt = Number(candidate.measured?.measuredAt) || Date.now()
          publicJobs.push({
            id: `profile-${candidate.fingerprint}`,
            key: candidate.key,
            mode: 'full',
            state: 'completed',
            position: 0,
            completed: Number(candidate.measured?.fixtureCount) || CAPABILITY_BENCHMARK_MODE_REQUESTS.full,
            total: Number(candidate.measured?.fixtureCount) || CAPABILITY_BENCHMARK_MODE_REQUESTS.full,
            enqueuedAt: measuredAt,
            startedAt: measuredAt,
            finishedAt: measuredAt,
            elapsedMs: 0,
            groundingDiagnostic: diagnostic,
            profileDiagnostic: true,
          })
        }
      }

      return {
        ok: true,
        suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
        runningKey: running?.key,
        queueLength: queue.length,
        maxActiveJobs: MAX_ACTIVE_JOBS,
        candidates: publicCandidates,
        jobs: publicJobs,
      }
    },
    async enqueue(key, mode = 'quick', force = false, authority) {
      assertManualMeasurementAuthority(authority)
      pruneHistory()
      const wanted = typeof key === 'string' ? key.trim() : ''
      const wantedMode = normalizeMode(mode)
      const duplicate = [...jobs.values()].find((job) =>
        job.key === wanted && (job.state === 'queued' || job.state === 'running'))
      if (duplicate) return { ok: true, duplicate: true, job: publicJob(duplicate, queue.indexOf(duplicate) + 1) }
      if (queue.length + (running ? 1 : 0) >= MAX_ACTIVE_JOBS) {
        const error = new Error(`capability benchmark queue is full (${MAX_ACTIVE_JOBS} active jobs max)`)
        error.code = 'CAPABILITY_BENCHMARK_QUEUE_FULL'
        throw error
      }
      const { current, candidate } = await candidateFor(wanted)
      const imageCapability = await declaredImageState(ctx, core, current, candidate)
      if (imageCapability === 'text-only' && force !== true) {
        const error = new Error('DSH currently declares this model as text-only; force verification is required')
        error.code = 'CAPABILITY_BENCHMARK_FORCE_REQUIRED'
        throw error
      }
      const job = {
        id: `bench-${Date.now().toString(36)}-${(++sequence).toString(36)}`,
        key: candidate.key,
        fingerprint: candidate.endpointFingerprint,
        mode: wantedMode,
        state: 'queued',
        completed: 0,
        total: CAPABILITY_BENCHMARK_MODE_REQUESTS[wantedMode],
        enqueuedAt: Date.now(),
        authority,
      }
      acquireManualLease(job)
      jobs.set(job.id, job)
      queue.push(job)
      void pump()
      return { ok: true, queued: true, job: publicJob(job, queue.indexOf(job) + 1) }
    },
    async cancel(jobId) {
      const id = typeof jobId === 'string' ? jobId.trim() : ''
      if (id === '') {
        const error = new Error('benchmark job id is required')
        error.code = 'CAPABILITY_BENCHMARK_JOB_REQUIRED'
        throw error
      }
      const job = jobs.get(id)
      if (!job) return { ok: true, cancelled: false }
      if (job.state === 'queued') {
        const index = queue.findIndex((entry) => entry.id === id)
        if (index >= 0) queue.splice(index, 1)
        job.state = 'cancelled'
        job.errorClass = 'cancelled'
        job.errorCode = 'CAPABILITY_BENCHMARK_CANCELLED'
        job.error = 'benchmark cancelled before start'
        job.finishedAt = Date.now()
        releaseManualLease(job)
        const result = { ok: true, cancelled: true, job: publicJob(job, 0) }
        pruneHistory()
        return result
      }
      if (job.state === 'running') {
        job.cancelRequested = true
        job.controller?.abort?.()
        return { ok: true, cancelled: true, job: publicJob(job, 0) }
      }
      return { ok: true, cancelled: false, job: publicJob(job, 0) }
    },
    async run(key, intents, requestSignal, authority) {
      assertManualMeasurementAuthority(authority)
      const lease = { manualLease: false }
      acquireManualLease(lease)
      try {
        const { current, candidate } = await candidateFor(key)
        const signal = mergedSignal(requestSignal, AbortSignal.timeout(runTimeoutMs))
        try {
          return await executeCandidate({ candidate, current, intents, signal })
        } catch (error) {
          const errorClass = error?.benchmarkClass ?? classifyCapabilityBenchmarkFailure(error)
          if (errorClass === 'unsupported-image') {
            try { await backgroundProfiler?.recordImageUnsupported?.(candidate.provider, candidate.model) } catch {}
          }
          throw error
        }
      } finally {
        releaseManualLease(lease)
      }
    },
    async waitForIdle() {
      await pumpPromise
    },
  }
}

export function installCapabilityBenchmarkService(ctx, config, core, options = {}) {
  const manager = createCapabilityBenchmarkManager(ctx, config, core, options)
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: CAPABILITY_BENCHMARK_PATH,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          try {
            sendJson(res, 200, await manager.snapshot())
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              code: 'CAPABILITY_BENCHMARK_SNAPSHOT_FAILED',
              error: bounded(error?.message ?? error),
            })
          }
          return
        }
        if (req.method !== 'POST' && req.method !== 'DELETE') {
          res.setHeader('Allow', 'GET, POST, DELETE')
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const body = await readJsonBody(req)
          if (req.method === 'DELETE') {
            sendJson(res, 200, await manager.cancel(body.jobId))
            return
          }
          // The transport-level local UI fence is installed before this route.
          // Reify that explicit user POST as an opaque one-job authority grant
          // instead of letting manager callers inherit "manual" by convention.
          const authority = grantManualMeasurementFromUserAction('local-ui')
          const result = await manager.enqueue(body.key, body.mode, body.force === true, authority)
          sendJson(res, 202, result)
        } catch (error) {
          const code = error?.code ?? 'CAPABILITY_BENCHMARK_FAILED'
          const status = code === 'CAPABILITY_BENCHMARK_FORCE_REQUIRED' ? 409 : statusForError(error)
          sendJson(res, status, { ok: false, code, error: bounded(error?.message ?? error) })
        }
      },
    }), 'vision-router: queued exact capability benchmark service')
  })
  return manager
}