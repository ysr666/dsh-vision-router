import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { resolveDshHome } from './doctor.js'
import { MODEL_RESPONSE_MAX_BYTES, readResponseJsonBounded } from './http-body-limit.js'

export const LIVE_MODELS_PATH = '/_dsh/vision-router/live-models'
export const LIVE_MODEL_CACHE_VERSION = 1
export const DEFAULT_LIVE_MODEL_FRESH_MS = 15 * 60 * 1000
export const DEFAULT_LIVE_MODEL_STALE_MS = 24 * 60 * 60 * 1000
export const DEFAULT_LIVE_MODEL_TIMEOUT_MS = 6_000
export const DEFAULT_LIVE_MODEL_CONCURRENCY = 3
export const DEFAULT_MAX_MODELS_PER_PROVIDER = 2_000

const SUPPORTED_DISCOVERY_PROTOCOLS = new Set(['openai-completions', 'openai-responses'])

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function normalizeBaseURL(value) {
  const text = nonEmpty(value)
  if (text === undefined) return undefined
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  parsed.hash = ''
  parsed.search = ''
  return parsed.toString().replace(/\/+$/, '')
}

function boundedLabel(value, max = 512) {
  const text = nonEmpty(value)
  return text === undefined ? undefined : text.slice(0, max)
}

export function normalizeOpenAIModelListing(body, { maxModels = DEFAULT_MAX_MODELS_PER_PROVIDER } = {}) {
  const data = body && typeof body === 'object' ? body.data : undefined
  if (!Array.isArray(data)) {
    const error = new Error('provider model listing has no data array')
    error.code = 'LIVE_MODEL_LISTING_INVALID'
    throw error
  }
  const seen = new Set()
  const models = []
  const limit = Math.max(1, Math.floor(Number(maxModels) || DEFAULT_MAX_MODELS_PER_PROVIDER))
  for (const raw of data) {
    if (models.length >= limit) break
    if (!raw || typeof raw !== 'object') continue
    const id = boundedLabel(raw.id)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const name = boundedLabel(raw.name ?? raw.display_name)
    models.push(name === undefined ? { id } : { id, name })
  }
  return models
}

export function liveModelCachePath(dshHome = resolveDshHome()) {
  return path.join(dshHome, 'cache', 'vision-router', 'live-models.json')
}

export function routeFingerprint({ provider, baseURL, api, credentialFingerprint }) {
  return createHash('sha256')
    .update(JSON.stringify({
      provider: String(provider ?? ''),
      baseURL: String(baseURL ?? ''),
      api: String(api ?? ''),
      credentialFingerprint: String(credentialFingerprint ?? ''),
    }))
    .digest('hex')
}

function credentialFingerprint(value) {
  const text = typeof value === 'string' ? value : ''
  if (text === '') return 'none'
  return createHash('sha256').update(text).digest('hex').slice(0, 24)
}

function listingURL(baseURL) {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function cleanCachedProvider(entry) {
  if (!entry || typeof entry !== 'object') return undefined
  const provider = nonEmpty(entry.provider)
  const fingerprint = nonEmpty(entry.fingerprint)
  const discoveredAt = Number(entry.discoveredAt)
  if (provider === undefined || fingerprint === undefined || !Number.isFinite(discoveredAt) || discoveredAt <= 0) {
    return undefined
  }
  const models = Array.isArray(entry.models)
    ? entry.models.flatMap((model) => {
        const id = boundedLabel(model?.id)
        if (id === undefined) return []
        const name = boundedLabel(model?.name)
        return [name === undefined ? { id } : { id, name }]
      }).slice(0, DEFAULT_MAX_MODELS_PER_PROVIDER)
    : []
  return {
    provider,
    fingerprint,
    discoveredAt,
    models,
    ...(typeof entry.lastError === 'string' && entry.lastError !== '' ? { lastError: entry.lastError.slice(0, 300) } : {}),
  }
}

function cacheEnvelope(entries) {
  return {
    version: LIVE_MODEL_CACHE_VERSION,
    providers: entries,
  }
}

async function loadCache(file, fsOps) {
  try {
    const body = JSON.parse(await fsOps.readFile(file, 'utf8'))
    if (!body || body.version !== LIVE_MODEL_CACHE_VERSION || !Array.isArray(body.providers)) return new Map()
    return new Map(
      body.providers
        .map(cleanCachedProvider)
        .filter(Boolean)
        .map((entry) => [entry.provider, entry]),
    )
  } catch (error) {
    if (error && error.code === 'ENOENT') return new Map()
    return new Map()
  }
}

async function saveCache(file, providers, fsOps) {
  const directory = path.dirname(file)
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await fsOps.mkdir(directory, { recursive: true })
  const entries = [...providers.values()]
    .sort((left, right) => left.provider.localeCompare(right.provider))
    .slice(0, 64)
  await fsOps.writeFile(temporary, JSON.stringify(cacheEnvelope(entries)), { encoding: 'utf8', mode: 0o600 })
  await fsOps.rename(temporary, file)
}

function rawPiProfiles(ctx) {
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('llm-pi-ai')
    const providers = value?.providers
    return providers && typeof providers === 'object' && !Array.isArray(providers) ? providers : {}
  } catch {
    return {}
  }
}

function visionProviderPriority(ctx, fallbackConfig = {}) {
  const preferred = new Set()
  const collect = (value) => {
    for (const pair of Array.isArray(value?.providers) ? value.providers : []) {
      if (pair && nonEmpty(pair.provider) !== undefined && pair.provider !== 'vision-http') preferred.add(pair.provider)
    }
  }
  collect(fallbackConfig)
  try {
    const settings = ctx?.get?.('settings')
    collect(settings?.get?.('vision-router'))
  } catch {
    // Composition config still provides the startup priority set.
  }
  return preferred
}

function resolvedPiProfile(ctx, provider) {
  try {
    const registration = ctx?.llm?.registration?.(provider)
    const profiles = registration?.adapter?.config?.profiles
    const map = typeof profiles === 'function' ? profiles.call(registration.adapter.config) : undefined
    return map?.get?.(provider)
  } catch {
    return undefined
  }
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim() !== '')?.trim()
}

function transportForProvider(ctx, provider, rawProfile) {
  const resolved = resolvedPiProfile(ctx, provider)
  const baseURL = normalizeBaseURL(firstString(
    rawProfile?.baseURL,
    resolved?.baseURL,
    resolved?.piProvider?.baseUrl,
  ))
  const api = firstString(rawProfile?.api, resolved?.api)
  const apiKeyEnv = firstString(rawProfile?.apiKeyEnv, resolved?.apiKeyEnv)
  return { baseURL, api, apiKeyEnv }
}

async function resolveCredential(ctx, ref) {
  if (typeof ref !== 'string' || ref === '') return undefined
  try {
    const credentials = ctx?.get?.('credentials')
    const hit = await credentials?.resolve?.(ref)
    if (hit && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
  } catch {
    // Fall through to the launch environment, matching the adapter's behavior.
  }
  const ambient = process.env[ref]
  return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
}

async function providerPlan(ctx, provider, rawProfile) {
  const transport = transportForProvider(ctx, provider, rawProfile)
  if (transport.baseURL === undefined) return { ok: false, reason: 'missing-base-url' }
  if (transport.api !== undefined && !SUPPORTED_DISCOVERY_PROTOCOLS.has(transport.api)) {
    return { ok: false, reason: 'unsupported-protocol' }
  }
  const apiKey = await resolveCredential(ctx, transport.apiKeyEnv)
  return {
    ok: true,
    provider,
    baseURL: transport.baseURL,
    api: transport.api ?? 'openai-completions',
    apiKey,
    fingerprint: routeFingerprint({
      provider,
      baseURL: transport.baseURL,
      api: transport.api ?? 'openai-completions',
      credentialFingerprint: credentialFingerprint(apiKey),
    }),
  }
}

function boundedError(error) {
  const text = error && error.message ? error.message : String(error)
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, 300)
}

export function createLiveModelDiscoveryManager(ctx, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const freshMs = Math.max(1_000, Number(options.freshMs) || DEFAULT_LIVE_MODEL_FRESH_MS)
  const staleMs = Math.max(freshMs, Number(options.staleMs) || DEFAULT_LIVE_MODEL_STALE_MS)
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || DEFAULT_LIVE_MODEL_TIMEOUT_MS)
  const concurrency = Math.max(1, Math.min(8, Math.floor(Number(options.concurrency) || DEFAULT_LIVE_MODEL_CONCURRENCY)))
  const cacheFile = options.cacheFile ?? liveModelCachePath(options.dshHome)
  const fsOps = {
    readFile: options.fsOps?.readFile ?? readFile,
    mkdir: options.fsOps?.mkdir ?? mkdir,
    writeFile: options.fsOps?.writeFile ?? writeFile,
    rename: options.fsOps?.rename ?? rename,
  }
  const logger = options.logger ?? ctx?.logger
  const fallbackConfig = options.config ?? {}
  let providers = new Map()
  let version = 0
  let active = 0
  let disposed = false
  let saveTail = Promise.resolve()
  const inflight = new Map()
  const queued = new Map()
  const backoffUntil = new Map()
  const cacheReady = loadCache(cacheFile, fsOps).then((loaded) => {
    if (!disposed) providers = loaded
  })

  const persist = () => {
    saveTail = saveTail
      .then(() => saveCache(cacheFile, providers, fsOps))
      .catch((error) => logger?.warn?.('vision-router: live model cache write failed: %s', boundedError(error)))
    return saveTail
  }

  const visibleEntry = (entry, at = now()) => {
    if (!entry || at - entry.discoveredAt > staleMs) return undefined
    return {
      provider: entry.provider,
      models: entry.models,
      discoveredAt: entry.discoveredAt,
      stale: at - entry.discoveredAt > freshMs,
      ...(entry.lastError ? { lastError: entry.lastError } : {}),
    }
  }

  const snapshot = async ({ schedule = false } = {}) => {
    await cacheReady
    if (schedule) queueConfigured()
    const at = now()
    return {
      ok: true,
      version,
      refreshing: active > 0 || queued.size > 0,
      providers: [...providers.values()].map((entry) => visibleEntry(entry, at)).filter(Boolean),
    }
  }

  const discover = async (provider) => {
    const raw = rawPiProfiles(ctx)[provider]
    if (!raw || typeof raw !== 'object') return
    const plan = await providerPlan(ctx, provider, raw)
    if (!plan.ok) return
    const previous = providers.get(provider)
    const at = now()
    if (previous?.fingerprint === plan.fingerprint && at - previous.discoveredAt <= freshMs) return
    if ((backoffUntil.get(provider) ?? 0) > at) return

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers = { accept: 'application/json' }
      if (plan.apiKey !== undefined) headers.authorization = `Bearer ${plan.apiKey}`
      const response = await fetchImpl(listingURL(plan.baseURL), {
        method: 'GET',
        headers,
        signal: controller.signal,
      })
      if (!response?.ok) {
        const error = new Error(`provider model listing answered HTTP ${response?.status ?? 'unknown'}`)
        error.status = response?.status
        throw error
      }
      const body = await readResponseJsonBounded(response, MODEL_RESPONSE_MAX_BYTES, {
        label: `${provider} model listing`,
      })
      const models = normalizeOpenAIModelListing(body, { maxModels: options.maxModels })
      providers.set(provider, {
        provider,
        fingerprint: plan.fingerprint,
        discoveredAt: now(),
        models,
      })
      backoffUntil.delete(provider)
      version += 1
      void persist()
    } catch (error) {
      if (disposed) return
      const current = providers.get(provider)
      if (current) providers.set(provider, { ...current, lastError: boundedError(error) })
      backoffUntil.set(provider, now() + 30_000)
      logger?.debug?.('vision-router: live model discovery failed for %s: %s', provider, boundedError(error))
    } finally {
      clearTimeout(timer)
    }
  }

  const pump = () => {
    if (disposed) return
    while (active < concurrency && queued.size > 0) {
      let picked
      for (const candidate of queued.values()) {
        if (!picked || candidate.priority < picked.priority ||
            (candidate.priority === picked.priority && candidate.order < picked.order)) picked = candidate
      }
      if (!picked) return
      queued.delete(picked.provider)
      if (inflight.has(picked.provider)) continue
      active += 1
      const task = discover(picked.provider)
        .catch(() => {})
        .finally(() => {
          active = Math.max(0, active - 1)
          inflight.delete(picked.provider)
          pump()
        })
      inflight.set(picked.provider, task)
    }
  }

  let order = 0
  const queue = (provider, priority = 10) => {
    if (disposed || nonEmpty(provider) === undefined || provider === 'vision-http') return
    if (inflight.has(provider)) return
    const existing = queued.get(provider)
    const next = { provider, priority: Number(priority) || 0, order: order++ }
    if (!existing || next.priority < existing.priority) queued.set(provider, next)
    pump()
  }

  function queueConfigured() {
    const raw = rawPiProfiles(ctx)
    const preferred = visionProviderPriority(ctx, fallbackConfig)
    for (const provider of Object.keys(raw)) queue(provider, preferred.has(provider) ? 0 : 10)
  }

  const hasModel = (provider, model) => {
    const entry = providers.get(provider)
    if (!entry || now() - entry.discoveredAt > staleMs) return false
    return entry.models.some((candidate) => candidate.id === model)
  }

  const invalidate = () => {
    // Fingerprints are recomputed at execution time. Clearing backoff is enough
    // to make a credential/baseURL/settings change observable immediately while
    // keeping the last successful list visible until replacement succeeds.
    backoffUntil.clear()
    queueConfigured()
  }

  return {
    ready: () => cacheReady,
    snapshot,
    queue,
    queueConfigured,
    hasModel,
    invalidate,
    async dispose() {
      disposed = true
      queued.clear()
      await Promise.allSettled([...inflight.values(), cacheReady, saveTail])
    },
  }
}

export function installLiveModelDiscovery(ctx, options = {}) {
  const manager = createLiveModelDiscoveryManager(ctx, options)
  let startupTimer
  const scheduleStartup = () => {
    if (startupTimer !== undefined || typeof setTimeout !== 'function') return
    startupTimer = setTimeout(() => {
      startupTimer = undefined
      manager.queueConfigured()
    }, 750)
    startupTimer.unref?.()
  }
  scheduleStartup()

  const onInvalidate = () => manager.invalidate()
  const disposers = []
  try {
    for (const event of ['settings/document-updated', 'credentials/updated', 'llm/adapters-updated']) {
      const dispose = ctx?.on?.(event, onInvalidate)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch {
    // Event forwarding is an optimization; the request path still refreshes.
  }

  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: LIVE_MODELS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET')
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const url = new URL(req.url ?? LIVE_MODELS_PATH, 'http://localhost')
          const schedule = url.searchParams.get('refresh') !== '0'
          sendJson(res, 200, await manager.snapshot({ schedule }))
        } catch (error) {
          sendJson(res, 500, { ok: false, error: boundedError(error) })
        }
      },
    }), 'vision-router: live provider model discovery')
  })

  try {
    ctx?.effect?.(() => () => {
      if (startupTimer !== undefined) clearTimeout(startupTimer)
      for (const dispose of disposers) {
        try { dispose() } catch { /* best effort */ }
      }
      void manager.dispose()
    }, 'vision-router: live model discovery lifecycle')
  } catch {
    // Host service disposal still tears down the registered route.
  }
  return manager
}
