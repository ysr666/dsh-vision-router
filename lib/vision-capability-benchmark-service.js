import {
  createCapabilityProfileStore,
  runExactCapabilityBenchmark,
} from './vision-capability-probe.js'
import { collectCapabilityShadowCandidates } from './vision-capability-shadow.js'
import { visionCapabilityTags } from './vision-capability-router.js'

export const CAPABILITY_BENCHMARK_PATH = '/_dsh/vision-router/capability-benchmark'
const REQUEST_MAX_BYTES = 32 * 1024
const DEFAULT_RUN_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_FIXTURE_TIMEOUT_MS = 60 * 1000

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
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const value = JSON.parse(text)
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
      if (kind === 'error' || kind === 'aborted') {
        throw failureError(chunk.reason?.failure, kind)
      }
    }
    if (chunk?.type === 'error' || chunk?.type === 'aborted') {
      throw failureError(chunk.failure, chunk.type)
    }
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

function publicCandidate(candidate) {
  const measured = candidate?.measured && typeof candidate.measured === 'object'
    ? {
        scores: candidate.measured,
        measuredAt: candidate.measuredAt,
        latencyMs: candidate.latencyMs,
        tags: visionCapabilityTags({ scores: candidate.measured }, 0.8),
      }
    : undefined
  return {
    key: candidate.key,
    provider: candidate.provider,
    model: candidate.model,
    local: candidate.local === true,
    benchmarkable: candidate.benchmarkable === true,
    evidenceScope: candidate.evidenceScope,
    fingerprint: candidate.endpointFingerprint,
    ...(measured ? { measured } : {}),
  }
}

function allFixturesFailed(record) {
  const fixtureCount = Math.max(0, Math.floor(Number(record?.fixtureCount) || 0))
  const failureCount = Math.max(0, Math.floor(Number(record?.failureCount) || 0))
  return fixtureCount > 0 && failureCount >= fixtureCount
}

export function createCapabilityBenchmarkManager(ctx, config, core, options = {}) {
  const logger = options.logger ?? ctx?.logger
  const store = options.store ?? createCapabilityProfileStore({ logger })
  const runBenchmark = options.runBenchmark ?? runExactCapabilityBenchmark
  const runTimeoutMs = Math.max(10_000, Number(options.runTimeoutMs) || DEFAULT_RUN_TIMEOUT_MS)
  let runningKey

  const candidates = async () => {
    const current = activeSettings(ctx, config)
    const rows = await collectCapabilityShadowCandidates(ctx, current, core, store)
    return { current, rows }
  }

  return {
    store,
    async snapshot() {
      const { rows } = await candidates()
      return { ok: true, runningKey, candidates: rows.map(publicCandidate) }
    },
    async run(key, intents, requestSignal) {
      const wanted = typeof key === 'string' ? key.trim() : ''
      if (wanted === '') {
        const error = new Error('backend key is required')
        error.code = 'CAPABILITY_BENCHMARK_BACKEND_REQUIRED'
        throw error
      }
      if (runningKey !== undefined) {
        const error = new Error(`capability benchmark already running for ${runningKey}`)
        error.code = 'CAPABILITY_BENCHMARK_BUSY'
        throw error
      }
      const { current, rows } = await candidates()
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
      const requestedIntents = Array.isArray(intents)
        ? intents.filter((value) => typeof value === 'string').slice(0, 10)
        : undefined
      const signal = mergedSignal(requestSignal, AbortSignal.timeout(runTimeoutMs))
      const backend = {
        provider: candidate.provider,
        model: candidate.model,
        endpoint: candidate.endpoint,
        config: candidate.endpointConfig,
      }
      const expectedFingerprint = candidate.endpointFingerprint
      runningKey = wanted
      try {
        const invoke = createExactCapabilityInvoker(ctx, core, candidate, current, options)
        const result = await runBenchmark({ backend, invoke, intents: requestedIntents, signal })
        if (result?.record?.fingerprint !== expectedFingerprint) {
          const error = new Error('benchmark result fingerprint changed while the run was active')
          error.code = 'CAPABILITY_BENCHMARK_FINGERPRINT_CHANGED'
          throw error
        }
        if (allFixturesFailed(result?.record)) {
          await store.remove?.(expectedFingerprint)
          const firstError = Array.isArray(result?.results)
            ? result.results.find((entry) => typeof entry?.details?.error === 'string' && entry.details.error !== '')?.details?.error
            : undefined
          const error = new Error(
            firstError
              ? `capability benchmark produced no usable evidence: ${bounded(firstError, 260)}`
              : 'capability benchmark produced no usable evidence: every fixture failed',
          )
          error.code = 'CAPABILITY_BENCHMARK_NO_USABLE_EVIDENCE'
          throw error
        }
        const record = await store.put(result.record)
        logger?.info?.(
          'vision-router: capability benchmark completed backend=%s fixtures=%d failures=%d',
          wanted,
          record.fixtureCount,
          record.failureCount,
        )
        return {
          ok: true,
          key: wanted,
          record,
          tags: visionCapabilityTags({ scores: record.scores }, 0.8),
          results: result.results,
        }
      } finally {
        runningKey = undefined
      }
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
            sendJson(res, 500, { ok: false, code: 'CAPABILITY_BENCHMARK_SNAPSHOT_FAILED', error: bounded(error?.message ?? error) })
          }
          return
        }
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'GET, POST')
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const controller = new AbortController()
        const abort = () => controller.abort()
        req.once?.('aborted', abort)
        try {
          const body = await readJsonBody(req)
          sendJson(res, 200, await manager.run(body.key, body.intents, controller.signal))
        } catch (error) {
          const code = error?.code
          const status = code === 'CAPABILITY_BENCHMARK_BUSY'
            ? 409
            : code === 'CAPABILITY_BENCHMARK_BODY_TOO_LARGE'
              ? 413
              : code === 'CAPABILITY_BENCHMARK_NO_USABLE_EVIDENCE'
                ? 422
                : code === 'CAPABILITY_BENCHMARK_BACKEND_REQUIRED' ||
                    code === 'CAPABILITY_BENCHMARK_BACKEND_STALE' ||
                    code === 'CAPABILITY_BENCHMARK_ENDPOINT_UNKNOWN' ||
                    code === 'CAPABILITY_BENCHMARK_INVALID_JSON'
                  ? 400
                  : 500
          sendJson(res, status, { ok: false, code: code ?? 'CAPABILITY_BENCHMARK_FAILED', error: bounded(error?.message ?? error) })
        } finally {
          req.off?.('aborted', abort)
        }
      },
    }), 'vision-router: exact capability benchmark service')
  })
  return manager
}
