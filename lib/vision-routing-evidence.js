import { capabilityEvidenceFingerprint } from './vision-capability-identity.js'
import { providerTransportFor } from './live-model-discovery.js'

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function addCandidate(out, seen, candidate) {
  const key = nonEmpty(candidate?.key) ?? `${nonEmpty(candidate?.provider) ?? ''}/${nonEmpty(candidate?.model) ?? ''}`
  if (key === '/' || seen.has(key)) return
  seen.add(key)
  out.push({ ...candidate, key })
}

/** Configured provider/model pairs in exactly the order legacy execution sees them. */
export function configuredVisionPairs(config) {
  const rows = Array.isArray(config?.providers) ? config.providers : []
  const source = rows.length > 0
    ? rows
    : [{ provider: config?.provider, model: config?.model, fallbacks: config?.fallbacks }]
  const out = []
  for (const row of source) {
    const provider = nonEmpty(row?.provider)
    const model = nonEmpty(row?.model)
    if (provider === undefined || model === undefined) continue
    out.push({ provider, model })
    for (const fallback of Array.isArray(row?.fallbacks) ? row.fallbacks : []) {
      const fallbackModel = nonEmpty(fallback)
      if (fallbackModel !== undefined) out.push({ provider, model: fallbackModel })
    }
  }
  return out
}

/** Planner/execution identity for one configured pair. */
export function candidateKeyForConfiguredPair(pair) {
  const provider = nonEmpty(pair?.provider)
  const model = nonEmpty(pair?.model)
  if (!provider || !model) return undefined
  if (provider !== 'vision-http') return `${provider}/${model}`
  if (model.startsWith('local-ollama/') || model.startsWith('local-lmstudio/')) {
    return `vision-http/${model}`
  }
  return `http:${model}`
}

/** Router-generated wrapper/chain routes are execution plumbing, never evidence candidates. */
export function generatedCapabilityRoute(provider, config) {
  const wrapper = nonEmpty(config?.wrapperRoute) ?? 'deepseek-vision'
  const chain = nonEmpty(config?.chainRoute) ?? 'vision-chain'
  return provider === wrapper || provider === chain
}

async function modelInfo(ctx, provider, model) {
  try {
    if (typeof ctx?.llm?.resolveModelInfo === 'function') {
      return await ctx.llm.resolveModelInfo(provider, model)
    }
  } catch {}
  return undefined
}

function localCandidate(provider, routeRole = 'user') {
  const name = nonEmpty(provider?.name)
  const model = nonEmpty(provider?.model)
  if (name === undefined || model === undefined) return undefined
  return {
    key: `vision-http/${name}/${model}`,
    provider: 'vision-http',
    model: `${name}/${model}`,
    local: true,
    privacy: 'local',
    endpoint: nonEmpty(provider.baseURL),
    endpointConfig: { api: 'openai-completions' },
    endpointCredentialRef: nonEmpty(provider.apiKeyEnv),
    evidenceScope: 'endpoint',
    routeRole,
  }
}

function httpCandidate(entry, routeRole = 'user') {
  const name = nonEmpty(entry?.name)
  const model = nonEmpty(entry?.model)
  if (name === undefined || model === undefined) return undefined
  const local = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(String(entry.baseURL ?? ''))
  return {
    key: `http:${name}/${model}`,
    provider: 'vision-http',
    model: `${name}/${model}`,
    local,
    privacy: local ? 'local' : 'cloud',
    endpoint: nonEmpty(entry.baseURL),
    endpointConfig: { api: 'openai-completions' },
    endpointCredentialRef: nonEmpty(entry.apiKeyEnv),
    evidenceScope: 'endpoint',
    routeRole,
    cost: name.toLowerCase().startsWith('ovh') && !nonEmpty(entry.apiKeyEnv) ? 0 : undefined,
  }
}

function routeIdentity(entry) {
  const name = nonEmpty(entry?.name)
  const model = nonEmpty(entry?.model)
  return name && model ? `${name}/${model}` : undefined
}

function exactHttpIdentity(entry) {
  const identity = routeIdentity(entry)
  if (!identity) return undefined
  return [identity, String(entry?.baseURL ?? '').replace(/\/+$/, ''), nonEmpty(entry?.apiKeyEnv) ?? ''].join('\u0000')
}

function localAndHttpSources(config, core) {
  let locals = []
  let http = []
  try { locals = core.localProvidersOf(config) } catch { locals = [] }
  try { http = core.httpProvidersOf(config) } catch { http = [] }
  const localByRoute = new Map(
    (Array.isArray(locals) ? locals : []).map((entry) => [routeIdentity(entry), entry]).filter(([key]) => key),
  )
  const httpByRoute = new Map(
    (Array.isArray(http) ? http : []).map((entry) => [routeIdentity(entry), entry]).filter(([key]) => key),
  )
  return {
    locals: Array.isArray(locals) ? locals : [],
    http: Array.isArray(http) ? http : [],
    localByRoute,
    httpByRoute,
  }
}

async function configuredAndLocalCandidates(ctx, config, core) {
  const out = []
  const seen = new Set()
  const configuredHttpRoutes = new Set()
  const sources = localAndHttpSources(config, core)
  for (const pair of configuredVisionPairs(config)) {
    if (generatedCapabilityRoute(pair.provider, config)) continue
    if (pair.provider === 'vision-http') {
      configuredHttpRoutes.add(pair.model)
      const local = sources.localByRoute.get(pair.model)
      if (local) {
        const candidate = localCandidate(local, 'user')
        if (candidate) addCandidate(out, seen, candidate)
        continue
      }
      const http = sources.httpByRoute.get(pair.model)
      if (http) {
        const candidate = httpCandidate(http, 'user')
        if (candidate) addCandidate(out, seen, candidate)
      }
      continue
    }
    let available = true
    try { available = core.adapterAvailable(ctx.llm, pair.provider) } catch { available = true }
    if (!available) continue
    const info = await modelInfo(ctx, pair.provider, pair.model)
    let decision
    try {
      decision = core.decideVisionBackendCapability(
        info,
        pair.provider,
        pair.model,
        config?.extraVisionModels,
      )
    } catch {
      decision = { attemptable: true }
    }
    if (decision?.attemptable === false) continue
    addCandidate(out, seen, { provider: pair.provider, model: pair.model, routeRole: 'user' })
  }
  for (const provider of sources.locals) {
    const candidate = localCandidate(provider, 'user')
    if (candidate) addCandidate(out, seen, candidate)
  }
  return { out, seen, configuredHttpRoutes, sources }
}

function appendHttpCandidates(config, core, out, seen, configuredHttpRoutes, sources) {
  const explicitHttpRoutes = new Set(
    (Array.isArray(config?.httpProviders) ? config.httpProviders : []).map(routeIdentity).filter(Boolean),
  )
  const builtinIds = new Set(
    (Array.isArray(core?.DEFAULT_HTTP_PROVIDERS) ? core.DEFAULT_HTTP_PROVIDERS : [])
      .map(exactHttpIdentity)
      .filter(Boolean),
  )
  for (const entry of sources.http) {
    const identity = routeIdentity(entry)
    const isUserRoute = configuredHttpRoutes.has(identity) || explicitHttpRoutes.has(identity)
    const isBuiltinFallback = !isUserRoute && builtinIds.has(exactHttpIdentity(entry))
    const candidate = httpCandidate(entry, isBuiltinFallback ? 'fallback-only' : 'user')
    if (candidate) addCandidate(out, seen, candidate)
  }
}

function registeredAdapterRoute(ctx, provider) {
  try {
    const registration = ctx?.llm?.registration?.(provider)
    const adapter = registration?.adapter
    if (!adapter) return undefined
    const adapterKind = nonEmpty(adapter?.constructor?.name) ?? 'registered-adapter'
    return {
      endpoint: `dsh-adapter://registered/${encodeURIComponent(provider)}`,
      endpointConfig: { api: 'dsh-adapter', adapterKind },
      evidenceScope: 'adapter-route',
    }
  } catch {
    return undefined
  }
}

function measuredSlice(record) {
  if (!record || typeof record !== 'object') return undefined
  const scores = {}
  const measuredAtByAxis = {}
  for (const [axis, rawScore] of Object.entries(record.scores ?? {})) {
    const score = Number(rawScore)
    if (!Number.isFinite(score)) continue
    const measuredAt = Number(record?.measuredAtByAxis?.[axis] ?? record?.measuredAt)
    if (!Number.isFinite(measuredAt) || measuredAt <= 0) continue
    scores[axis] = score
    measuredAtByAxis[axis] = measuredAt
  }
  const axes = Object.keys(scores)
  if (axes.length === 0) return undefined
  const timestamps = Object.values(measuredAtByAxis).filter(Number.isFinite)
  return {
    scores,
    measuredAtByAxis,
    measuredAt: timestamps.length > 0 ? Math.max(...timestamps) : undefined,
  }
}

async function attachEndpointEvidence(ctx, candidate, store, runtimePerformanceStore) {
  let endpoint = candidate.endpoint
  let endpointConfig = candidate.endpointConfig
  let endpointCredentialRef = candidate.endpointCredentialRef
  let evidenceScope = candidate.evidenceScope
  if (endpoint === undefined && candidate.provider !== 'vision-http') {
    const transport = providerTransportFor(ctx, candidate.provider)
    if (transport !== undefined) {
      endpoint = transport.baseURL
      endpointConfig = { api: transport.api }
      endpointCredentialRef = nonEmpty(transport.apiKeyEnv)
      evidenceScope = 'endpoint'
    } else {
      const adapterRoute = registeredAdapterRoute(ctx, candidate.provider)
      if (adapterRoute !== undefined) {
        endpoint = adapterRoute.endpoint
        endpointConfig = adapterRoute.endpointConfig
        evidenceScope = adapterRoute.evidenceScope
      }
    }
  }
  if (endpoint === undefined) return { ...candidate, benchmarkable: false }

  const fingerprint = capabilityEvidenceFingerprint({
    provider: candidate.provider,
    model: candidate.model,
    endpoint,
    config: endpointConfig,
  })
  const rawRecord = await store.get(fingerprint)
  const measured = measuredSlice(rawRecord)
  const runtime = runtimePerformanceStore?.get?.(candidate.key)
  return {
    ...candidate,
    endpoint,
    endpointConfig,
    ...(endpointCredentialRef ? { endpointCredentialRef } : {}),
    evidenceScope: evidenceScope ?? 'endpoint',
    benchmarkable: true,
    endpointFingerprint: fingerprint,
    ...(measured
      ? {
          measured: measured.scores,
          measuredAt: measured.measuredAt,
          measuredAtByAxis: measured.measuredAtByAxis,
        }
      : {}),
    ...(Number.isFinite(Number(rawRecord?.benchmarkLatencyMs))
      ? { benchmarkLatencyMs: Number(rawRecord.benchmarkLatencyMs) }
      : {}),
    ...(rawRecord?.benchmarkMedianLatencyMsByAxis
      ? { benchmarkMedianLatencyMsByAxis: rawRecord.benchmarkMedianLatencyMsByAxis }
      : {}),
    ...(runtime?.runtimeLatencyMsByAxis ? { runtimeLatencyMsByAxis: runtime.runtimeLatencyMsByAxis } : {}),
    ...(runtime?.observedLatencyMsByAxis
      ? { runtimeObservedLatencyMsByAxis: runtime.observedLatencyMsByAxis }
      : {}),
    ...(runtime?.sampleCountByAxis ? { runtimeSampleCountByAxis: runtime.sampleCountByAxis } : {}),
    ...(runtime?.observedAtByAxis ? { runtimeObservedAtByAxis: runtime.observedAtByAxis } : {}),
    ...(Number.isFinite(Number(runtime?.maxAgeMs))
      ? { runtimePerformanceMaxAgeMs: Number(runtime.maxAgeMs) }
      : {}),
    ...(Number.isFinite(Number(runtime?.minSamples))
      ? { runtimePerformanceMinSamples: Number(runtime.minSamples) }
      : {}),
  }
}

/** Candidate discovery + endpoint identity + measured/runtime evidence, with no planner or authority work. */
export async function collectVisionRoutingCandidates(
  ctx,
  config,
  core,
  store,
  runtimePerformanceStore,
) {
  const { out, seen, configuredHttpRoutes, sources } = await configuredAndLocalCandidates(ctx, config, core)
  appendHttpCandidates(config, core, out, seen, configuredHttpRoutes, sources)
  const enriched = []
  for (const candidate of out) {
    enriched.push(await attachEndpointEvidence(ctx, candidate, store, runtimePerformanceStore))
  }
  return enriched
}

/** Health is evidence; failures remain uncertainty rather than planner/runtime failure. */
export async function collectVisionRoutingHealth(candidates, healthForCandidate, context) {
  const health = {}
  if (typeof healthForCandidate !== 'function') return health
  for (const candidate of candidates) {
    try {
      const value = await healthForCandidate(candidate, context)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        health[candidate.key] = value
      }
    } catch {}
  }
  return health
}

/**
 * P1-A evidence boundary. It returns facts only: candidates, measured evidence,
 * and health. It performs no planning, authority check, settings mutation, or execution.
 */
export async function collectVisionRoutingEvidence({
  ctx,
  config,
  core,
  store,
  runtimePerformanceStore,
  healthForCandidate,
  healthContext,
} = {}) {
  const candidates = await collectVisionRoutingCandidates(
    ctx,
    config,
    core,
    store,
    runtimePerformanceStore,
  )
  const measured = Object.fromEntries(
    candidates
      .filter((candidate) => candidate.measured)
      .map((candidate) => [candidate.key, {
        scores: candidate.measured,
        measuredAt: candidate.measuredAt,
        measuredAtByAxis: candidate.measuredAtByAxis,
      }]),
  )
  const health = await collectVisionRoutingHealth(candidates, healthForCandidate, healthContext)
  return { candidates, measured, health }
}
