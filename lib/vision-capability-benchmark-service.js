import {
  createCapabilityProfileStore,
  runExactCapabilityBenchmark,
} from './vision-capability-probe.js'
import { collectCapabilityShadowCandidates } from './vision-capability-shadow.js'
import { visionCapabilityTags } from './vision-capability-router.js'

export const CAPABILITY_BENCHMARK_PATH = '/_dsh/vision-router/capability-benchmark'
export const CAPABILITY_BENCHMARK_QUICK_INTENTS = Object.freeze(['structured', 'ocr', 'general'])
export const CAPABILITY_BENCHMARK_MODE_REQUESTS = Object.freeze({ quick: 4, full: 6 })

const REQUEST_MAX_BYTES = 32 * 1024
const DEFAULT_RUN_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_FIXTURE_TIMEOUT_MS = 60 * 1000
const JOB_HISTORY_LIMIT = 64
const PROFILE_FRESH_MS = 7 * 24 * 60 * 60 * 1000
const PROFILE_EXPIRE_MS = 30 * 24 * 60 * 60 * 1000

let benchmarkSharpPromise

function bounded(value, max = 400) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, max)
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

async function resolveCredential(ctx, ref) {
  if (typeof ref !== 'string' || ref === '') return undefined
  let credentials
  try { credentials = ctx?.get?.('credentials') } catch { credentials = undefined }
  if (credentials !== undefined) {
    try {
      const hit = await credentials?.resolve?.(ref)
      return hit && typeof hit.value === 'string' && hit.value !== '' ? hit.value : undefined
    } catch {
      return undefined
    }
  }
  try {
    const launchEnvironment = ctx?.get?.('launchEnvironment')
    const hit = launchEnvironment?.get?.(ref)
    if (hit && typeof hit.value === 'string' && hit.value !== '') return hit.value
  } catch {
    // fall through to legacy process environment
  }
  const ambient = process.env[ref]
  return typeof ambient === 'string' && ambient !== '' ? ambient : undefined
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
      maxTokens: 4096,
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

async function renderFixturePng(core, fixture) {
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

export function createExactCapabilityInvoker(ctx, core, candidate, config, options = {}) {
  const fixtureTimeoutMs = Math.max(1_000, Number(options.fixtureTimeoutMs) || DEFAULT_FIXTURE_TIMEOUT_MS)
  const renderFixture = options.renderFixture ?? ((fixture) => renderFixturePng(core, fixture))
  const callDirect = options.callDirect ?? ((provider, messages, callOptions) =>
    core.callOpenAICompatible(provider, messages, callOptions))
  const streamExact = options.streamExact ?? ((callOptions) => ctx.llm.stream(callOptions))

  return async ({ backend, fixture, exactBackend, allowFallback, signal }) => {
    if (exactBackend !== true || allowFallback !== false) {
      throw new Error('exact capability invoker refuses non-exact/fallback benchmark requests')
    }
    const png = await renderFixture(fixture)
    const callSignal = mergedSignal(signal, AbortSignal.timeout(fixtureTimeoutMs))
    const direct = directProviderFor(candidate, config, core)
    let output
    if (direct !== undefined) {
      output = await callDirect(direct, openAIMessages(png, fixture.prompt), {
        maxTokens: direct.maxTokens ?? 4096,
        signal: callSignal,
        resolveCredential: (ref) => resolveCredential(ctx, ref),
      })
    } else {
      const messages = await adapterMessages(ctx, png, fixture)
      output = await collectStreamText(streamExact({
        provider: candidate.provider,
        model: candidate.model,
        messages,
        maxTokens: 4096,
        reasoningEffort: undefined,
        signal: callSignal,
      }))
    }
    return { output, usedFingerprint: backend.fingerprint }
  }
}

function normalizeMode(value) {
  return value === 'full' ? 'full' : 'quick'
}

function modeIntents(mode) {
  return mode === 'full' ? undefined : [...CAPABILITY_BENCHMARK_QUICK_INTENTS]
}

function profileFreshness(measuredAt, now = Date.now()) {
  const age = Math.max(0, Number(now) - Number(measuredAt || 0))
  if (!Number.isFinite(age) || Number(measuredAt) <= 0) return 'unknown'
  if (age <= PROFILE_FRESH_MS) return 'fresh'
  if (age <= PROFILE_EXPIRE_MS) return 'stale'
  return 'expired'
}

function profileConfidence(record) {
  const fixtures = Math.max(0, Number(record?.fixtureCount) || 0)
  const failures = Math.max(0, Number(record?.failureCount) || 0)
  if (failures > 0 || fixtures < CAPABILITY_BENCHMARK_MODE_REQUESTS.quick) return 'low'
  return fixtures >= CAPABILITY_BENCHMARK_MODE_REQUESTS.full ? 'medium' : 'low'
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
  const freshness = record ? profileFreshness(record.measuredAt) : undefined
  const measured = record && freshness !== 'expired'
    ? {
        scores: record.scores,
        measuredAt: record.measuredAt,
        latencyMs: record.latencyMs,
        fixtureCount: record.fixtureCount,
        failureCount: record.failureCount,
        confidence: profileConfidence(record),
        freshness,
        tags: visionCapabilityTags({ scores: record.scores }, 0.8),
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

function allFixturesFailed(record) {
  const fixtureCount = Math.max(0, Math.floor(Number(record?.fixtureCount) || 0))
  const failureCount = Math.max(0, Math.floor(Number(record?.failureCount) || 0))
  return fixtureCount > 0 && failureCount >= fixtureCount
}

export function classifyCapabilityBenchmarkFailure(value) {
  const text = bounded(value?.message ?? value, 800).toLowerCase()
  const status = Number(value?.status)
  const code = String(value?.code ?? '').toUpperCase()
  if (value?.name === 'AbortError' || value?.name === 'TimeoutError' || /abort|cancelled|canceled/.test(text)) return value?.name === 'TimeoutError' ? 'timeout' : 'cancelled'
  if (status === 401 || status === 403 || /unauthor|forbidden|credential|api[ _-]?key|authentication/.test(text)) return 'auth'
  if (status === 429 || /rate.?limit|too many requests|quota/.test(text)) return 'rate-limit'
  if (code.includes('TIMEOUT') || /timeout|timed out|deadline/.test(text)) return 'timeout'
  if (/does not support image|unsupported[_ -]?content|image input.*not support|text[- ]only/.test(text)) return 'unsupported-image'
  if (/unsupported protocol|openai-responses|anthropic|messages api/.test(text)) return 'protocol'
  if (code.includes('INFRASTRUCTURE') || /sharp renderer|fixture rendering|attachment service/.test(text)) return 'infrastructure'
  if (/fetch failed|network|econn|enotfound|socket|dns|connection refused/.test(text)) return 'network'
  return 'provider'
}

function firstInvocationFailure(results) {
  if (!Array.isArray(results)) return undefined
  const item = results.find((entry) => typeof entry?.details?.error === 'string' && entry.details.error !== '')
  if (!item) return undefined
  return { message: item.details.error, class: classifyCapabilityBenchmarkFailure(item.details.error) }
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
  }
}

function statusForError(error) {
  const code = error?.code
  if (code === 'CAPABILITY_BENCHMARK_BODY_TOO_LARGE') return 413
  if (code === 'CAPABILITY_BENCHMARK_NO_USABLE_EVIDENCE' || code === 'CAPABILITY_BENCHMARK_INCOMPLETE') return 422
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
    const rows = await collectCapabilityShadowCandidates(ctx, current, core, store)
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
    const result = await runBenchmark({ backend, invoke, intents, signal })
    if (result?.record?.fingerprint !== expectedFingerprint) {
      const error = new Error('benchmark result fingerprint changed while the run was active')
      error.code = 'CAPABILITY_BENCHMARK_FINGERPRINT_CHANGED'
      throw error
    }
    const firstFailure = firstInvocationFailure(result?.results)
    if (allFixturesFailed(result?.record)) {
      const error = new Error(
        firstFailure
          ? `capability benchmark produced no usable evidence: ${bounded(firstFailure.message, 260)}`
          : 'capability benchmark produced no usable evidence: every fixture failed',
      )
      error.code = 'CAPABILITY_BENCHMARK_NO_USABLE_EVIDENCE'
      error.benchmarkClass = firstFailure?.class ?? 'provider'
      throw error
    }
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
    logger?.info?.(
      'vision-router: capability benchmark completed backend=%s fixtures=%d failures=%d',
      candidate.key,
      record.fixtureCount,
      record.failureCount,
    )
    return {
      ok: true,
      key: candidate.key,
      record,
      tags: visionCapabilityTags({ scores: record.scores }, 0.8),
      results: result.results,
    }
  }

  const pruneHistory = () => {
    const terminal = [...jobs.values()]
      .filter((job) => job.state !== 'queued' && job.state !== 'running')
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    for (const job of terminal.slice(JOB_HISTORY_LIMIT)) jobs.delete(job.id)
  }

  const executeJob = async (job) => {
    const controller = new AbortController()
    job.controller = controller
    job.state = 'running'
    job.startedAt = Date.now()
    running = job
    try {
      const { current, candidate } = await candidateFor(job.key)
      if (candidate.endpointFingerprint !== job.fingerprint) {
        const error = new Error('queued backend changed before the benchmark started')
        error.code = 'CAPABILITY_BENCHMARK_BACKEND_STALE'
        throw error
      }
      const signal = mergedSignal(controller.signal, AbortSignal.timeout(runTimeoutMs))
      await executeCandidate({
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
      job.state = 'completed'
      job.completed = job.total
    } catch (error) {
      if (job.cancelRequested || error?.name === 'AbortError') {
        job.state = 'cancelled'
        job.errorClass = 'cancelled'
        job.errorCode = 'CAPABILITY_BENCHMARK_CANCELLED'
        job.error = 'benchmark cancelled'
      } else {
        job.state = 'failed'
        job.errorClass = error?.benchmarkClass ?? classifyCapabilityBenchmarkFailure(error)
        job.errorCode = error?.code ?? 'CAPABILITY_BENCHMARK_FAILED'
        job.error = bounded(error?.message ?? error, 360)
      }
    } finally {
      job.finishedAt = Date.now()
      job.controller = undefined
      job.currentIntent = undefined
      job.currentFixture = undefined
      if (running?.id === job.id) running = undefined
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
      const { current, rows } = await candidates()
      const publicCandidates = await Promise.all(rows.map((row) => publicCandidate(ctx, core, current, store, row)))
      const queuedPositions = new Map(queue.map((job, index) => [job.id, index + 1]))
      const publicJobs = [...jobs.values()]
        .sort((a, b) => {
          const rank = (job) => job.state === 'running' ? 0 : job.state === 'queued' ? 1 : 2
          return rank(a) - rank(b) || (b.enqueuedAt ?? 0) - (a.enqueuedAt ?? 0)
        })
        .map((job) => publicJob(job, queuedPositions.get(job.id) ?? 0))
      return {
        ok: true,
        runningKey: running?.key,
        queueLength: queue.length,
        candidates: publicCandidates,
        jobs: publicJobs,
      }
    },
    async enqueue(key, mode = 'quick', force = false) {
      const wanted = typeof key === 'string' ? key.trim() : ''
      const wantedMode = normalizeMode(mode)
      const duplicate = [...jobs.values()].find((job) =>
        job.key === wanted && (job.state === 'queued' || job.state === 'running'))
      if (duplicate) return { ok: true, duplicate: true, job: publicJob(duplicate, queue.indexOf(duplicate) + 1) }
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
      }
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
        return { ok: true, cancelled: true, job: publicJob(job, 0) }
      }
      if (job.state === 'running') {
        job.cancelRequested = true
        job.controller?.abort?.()
        return { ok: true, cancelled: true, job: publicJob(job, 0) }
      }
      return { ok: true, cancelled: false, job: publicJob(job, 0) }
    },
    async run(key, intents, requestSignal) {
      const { current, candidate } = await candidateFor(key)
      const signal = mergedSignal(requestSignal, AbortSignal.timeout(runTimeoutMs))
      return executeCandidate({ candidate, current, intents, signal })
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
          const result = await manager.enqueue(body.key, body.mode, body.force === true)
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
