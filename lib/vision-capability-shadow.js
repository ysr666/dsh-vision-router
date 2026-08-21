import {
  explainVisionRoute,
  inferToolVisionIntent,
  suggestVisionOrder,
} from './vision-capability-router.js'
import { createCapabilityProfileStore } from './vision-capability-probe.js'
import { capabilityEvidenceFingerprint } from './vision-capability-identity.js'
import { providerTransportFor } from './live-model-discovery.js'
import { resolveVisionRoutingProduct } from './vision-routing-product.js'

const SHADOW_TOOLS = new Set([
  'vision_bootstrap',
  'vision_describe',
  'vision_ground',
  'vision_detect',
  'vision_ocr',
  'vision_long_screenshot_ocr',
])

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function bounded(value, max = 2000) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, max)
}

function parseJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try { return JSON.parse(value) } catch { return undefined }
}

function bootstrapEvidence(value) {
  const parsed = parseJson(value)
  return parsed && parsed.ok === true && parsed.evidence && typeof parsed.evidence === 'object' ? parsed.evidence : undefined
}

function activeSettings(ctx, fallback) {
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    return value && typeof value === 'object' ? value : fallback
  } catch { return fallback }
}

function addCandidate(out, seen, candidate) {
  const key = nonEmpty(candidate?.key) ?? `${nonEmpty(candidate?.provider) ?? ''}/${nonEmpty(candidate?.model) ?? ''}`
  if (key === '/' || seen.has(key)) return
  seen.add(key)
  out.push({ ...candidate, key })
}

function configuredPairs(config) {
  const rows = Array.isArray(config?.providers) ? config.providers : []
  const source = rows.length > 0 ? rows : [{ provider: config?.provider, model: config?.model, fallbacks: config?.fallbacks }]
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

async function modelInfo(ctx, provider, model) {
  try { if (typeof ctx?.llm?.resolveModelInfo === 'function') return await ctx.llm.resolveModelInfo(provider, model) } catch {}
  return undefined
}

export function generatedCapabilityRoute(provider, config) {
  const wrapper = nonEmpty(config?.wrapperRoute) ?? 'deepseek-vision'
  const chain = nonEmpty(config?.chainRoute) ?? 'vision-chain'
  return provider === wrapper || provider === chain
}

function localCandidate(provider, routeRole = 'user') {
  const name = nonEmpty(provider?.name)
  const model = nonEmpty(provider?.model)
  if (name === undefined || model === undefined) return undefined
  return {
    key: `vision-http/${name}/${model}`,
    provider: 'vision-http', model: `${name}/${model}`, local: true, privacy: 'local',
    endpoint: nonEmpty(provider.baseURL), endpointConfig: { api: 'openai-completions' },
    endpointCredentialRef: nonEmpty(provider.apiKeyEnv), evidenceScope: 'endpoint', routeRole,
  }
}

function httpCandidate(entry, routeRole = 'user') {
  const name = nonEmpty(entry?.name)
  const model = nonEmpty(entry?.model)
  if (name === undefined || model === undefined) return undefined
  const local = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(String(entry.baseURL ?? ''))
  return {
    key: `http:${name}/${model}`,
    provider: 'vision-http', model: `${name}/${model}`, local, privacy: local ? 'local' : 'cloud',
    endpoint: nonEmpty(entry.baseURL), endpointConfig: { api: 'openai-completions' },
    endpointCredentialRef: nonEmpty(entry.apiKeyEnv), evidenceScope: 'endpoint', routeRole,
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
  const localByRoute = new Map((Array.isArray(locals) ? locals : []).map((entry) => [routeIdentity(entry), entry]).filter(([key]) => key))
  const httpByRoute = new Map((Array.isArray(http) ? http : []).map((entry) => [routeIdentity(entry), entry]).filter(([key]) => key))
  return { locals: Array.isArray(locals) ? locals : [], http: Array.isArray(http) ? http : [], localByRoute, httpByRoute }
}

async function configuredAndLocalCandidates(ctx, config, core) {
  const out = []
  const seen = new Set()
  const configuredHttpRoutes = new Set()
  const sources = localAndHttpSources(config, core)
  for (const pair of configuredPairs(config)) {
    if (generatedCapabilityRoute(pair.provider, config)) continue
    if (pair.provider === 'vision-http') {
      configuredHttpRoutes.add(pair.model)
      const local = sources.localByRoute.get(pair.model)
      if (local) { const candidate = localCandidate(local, 'user'); if (candidate) addCandidate(out, seen, candidate); continue }
      const http = sources.httpByRoute.get(pair.model)
      if (http) { const candidate = httpCandidate(http, 'user'); if (candidate) addCandidate(out, seen, candidate) }
      continue
    }
    let available = true
    try { available = core.adapterAvailable(ctx.llm, pair.provider) } catch { available = true }
    if (!available) continue
    const info = await modelInfo(ctx, pair.provider, pair.model)
    let decision
    try { decision = core.decideVisionBackendCapability(info, pair.provider, pair.model, config?.extraVisionModels) } catch { decision = { attemptable: true } }
    if (decision?.attemptable === false) continue
    addCandidate(out, seen, { provider: pair.provider, model: pair.model, routeRole: 'user' })
  }
  for (const provider of sources.locals) { const candidate = localCandidate(provider, 'user'); if (candidate) addCandidate(out, seen, candidate) }
  return { out, seen, configuredHttpRoutes, sources }
}

function appendHttpCandidates(config, core, out, seen, configuredHttpRoutes, sources) {
  const explicitHttpRoutes = new Set((Array.isArray(config?.httpProviders) ? config.httpProviders : []).map(routeIdentity).filter(Boolean))
  const builtinIds = new Set((Array.isArray(core?.DEFAULT_HTTP_PROVIDERS) ? core.DEFAULT_HTTP_PROVIDERS : []).map(exactHttpIdentity).filter(Boolean))
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
    return { endpoint: `dsh-adapter://registered/${encodeURIComponent(provider)}`, endpointConfig: { api: 'dsh-adapter', adapterKind }, evidenceScope: 'adapter-route' }
  } catch { return undefined }
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

async function attachEndpointEvidence(ctx, candidate, store) {
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
  return {
    ...candidate,
    endpoint,
    endpointConfig,
    ...(endpointCredentialRef ? { endpointCredentialRef } : {}),
    evidenceScope: evidenceScope ?? 'endpoint',
    benchmarkable: true,
    endpointFingerprint: fingerprint,
    ...(measured ? {
      measured: measured.scores,
      measuredAt: measured.measuredAt,
      measuredAtByAxis: measured.measuredAtByAxis,
    } : {}),
    ...(Number.isFinite(Number(rawRecord?.benchmarkLatencyMs)) ? { benchmarkLatencyMs: Number(rawRecord.benchmarkLatencyMs) } : {}),
    ...(rawRecord?.benchmarkMedianLatencyMsByAxis ? { benchmarkMedianLatencyMsByAxis: rawRecord.benchmarkMedianLatencyMsByAxis } : {}),
  }
}

export async function collectCapabilityShadowCandidates(ctx, config, core, store) {
  const { out, seen, configuredHttpRoutes, sources } = await configuredAndLocalCandidates(ctx, config, core)
  appendHttpCandidates(config, core, out, seen, configuredHttpRoutes, sources)
  const enriched = []
  for (const candidate of out) enriched.push(await attachEndpointEvidence(ctx, candidate, store))
  return enriched
}

async function collectCapabilityShadowHealth(candidates, healthForCandidate, context) {
  const health = {}
  if (typeof healthForCandidate !== 'function') return health
  for (const candidate of candidates) {
    try {
      const value = await healthForCandidate(candidate, context)
      if (value && typeof value === 'object' && !Array.isArray(value)) health[candidate.key] = value
    } catch {}
  }
  return health
}

export async function buildCapabilityShadowPlan({ ctx, config, core, store, toolName, args, bootstrap, healthForCandidate, healthContext } = {}) {
  const routing = resolveVisionRoutingProduct(config)
  const candidates = await collectCapabilityShadowCandidates(ctx, config, core, store)
  const intent = inferToolVisionIntent(toolName, args, { bootstrap })
  const measured = Object.fromEntries(candidates.filter((candidate) => candidate.measured).map((candidate) => [candidate.key, {
    scores: candidate.measured,
    measuredAt: candidate.measuredAt,
    measuredAtByAxis: candidate.measuredAtByAxis,
  }]))
  const health = await collectCapabilityShadowHealth(candidates, healthForCandidate, healthContext)
  const suggestion = suggestVisionOrder({ intent, strategy: routing.strategy, candidates, measured, health })
  const ranked = suggestion.ranked
  const healthBackends = Object.keys(health)
  const autoPreviewOrder = ranked.map((candidate) => candidate.key)
  return {
    intent,
    routingMode: routing.mode,
    routingPreference: routing.preference,
    strategy: routing.strategy,
    currentOrder: candidates.map((candidate) => candidate.key),
    autoPreviewOrder,
    suggestedOrder: autoPreviewOrder,
    decisions: suggestion.decisions,
    incomparableBackends: suggestion.incomparableBackends,
    explanation: explainVisionRoute(ranked),
    measuredBackends: candidates.filter((candidate) => candidate.measured).map((candidate) => candidate.key),
    unmeasuredBackends: candidates.filter((candidate) => !candidate.measured).map((candidate) => candidate.key),
    healthBackends,
    blockedBackends: suggestion.blockedBackends,
  }
}

function wrapTools(tools, ctx, fallbackConfig, core, store, bootstrapBySession, logger, healthForCandidate) {
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
        if (!def || !SHADOW_TOOLS.has(def.name) || typeof def.execute !== 'function') return register.call(target, def)
        const wrapped = {
          ...def,
          async execute(args, exec) {
            const config = activeSettings(ctx, fallbackConfig)
            const enabled = config?.capabilityRoutingShadow === true
            const session = exec?.agent?.session
            if (enabled) {
              try {
                const plan = await buildCapabilityShadowPlan({ ctx, config, core, store, toolName: def.name, args, bootstrap: session ? bootstrapBySession.get(session) : undefined, healthForCandidate, healthContext: { session, exec, toolName: def.name, args } })
                logger?.info?.(
                  'vision-router: v2 shadow mode=%s preference=%s intent=%s strategy=%s current=[%s] suggested=[%s] measured=[%s] blocked=[%s]',
                  plan.routingMode, plan.routingPreference, plan.intent, plan.strategy,
                  bounded(plan.currentOrder.join(' -> '), 1200), bounded(plan.autoPreviewOrder.join(' -> '), 1200),
                  bounded(plan.measuredBackends.join(', '), 600), bounded(plan.blockedBackends.join(', '), 600),
                )
              } catch (error) { logger?.warn?.('vision-router: v2 shadow planning failed: %s', bounded(error?.message ?? error, 400)) }
            }
            const result = await def.execute(args, exec)
            if (session && def.name === 'vision_bootstrap') {
              const evidence = bootstrapEvidence(result)
              if (evidence !== undefined) bootstrapBySession.set(session, evidence)
            }
            return result
          },
        }
        return register.call(target, wrapped)
      }
    },
  })
}

export function installCapabilityShadowRuntime(ctx, config, core, options = {}) {
  if (!ctx || typeof ctx !== 'object') return ctx
  const logger = options.logger ?? ctx.logger
  const store = options.store ?? createCapabilityProfileStore({ logger })
  const healthForCandidate = options.healthForCandidate
  const bootstrapBySession = new WeakMap()
  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') return wrapTools(target.tools, target, config, core, store, bootstrapBySession, logger, healthForCandidate)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
