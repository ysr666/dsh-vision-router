import { AsyncLocalStorage } from 'node:async_hooks'
import {
  benchmarkAxisForVisionIntent,
  explainVisionRoute,
  inferToolVisionIntent,
  suggestVisionOrder,
} from './vision-capability-router.js'
import { createCapabilityProfileStore } from './vision-capability-probe.js'
import { capabilityEvidenceFingerprint } from './vision-capability-identity.js'
import { providerTransportFor } from './live-model-discovery.js'
import { resolveVisionRoutingProduct } from './vision-routing-product.js'
import { resolveVisionRoutingAuthority } from './vision-routing-authority.js'
import { withVisionRuntimePerformanceScope } from './vision-runtime-performance.js'

const SHADOW_TOOLS = new Set([
  'vision_bootstrap',
  'vision_describe',
  'vision_ground',
  'vision_detect',
  'vision_ocr',
  'vision_long_screenshot_ocr',
])

export const V2_AUTO_EXECUTION_PROBE_PATH = '/_dsh/vision-router/v2-auto-execution-probe'

// Execution-changing Auto never mutates Host settings. Instead, one visual-tool
// call receives a process-local view of the already-authorized fallback order.
// AsyncLocalStorage keeps concurrent sessions/calls isolated and disappears as
// soon as the wrapped tool call completes.
const autoExecutionConfig = new AsyncLocalStorage()
const scopedSettingsCache = new WeakMap()
const scopedSettingsServiceCache = new WeakMap()
const coreVisionSettingsScopeByContext = new WeakMap()

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function bounded(value, max = 2000) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, max)
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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

// Auto execution authority is intentionally stricter than diagnostics/shadow:
// if the live Host settings service cannot prove the current user grant, there
// is no execution-changing authority. Never fall back to boot/composition data.
function liveSettings(ctx) {
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    return plainObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

function cloneConfig(value) {
  if (!plainObject(value)) return value
  try { return structuredClone(value) } catch { return { ...value } }
}

function configSnapshot(value) {
  if (!plainObject(value)) return undefined
  try { return JSON.stringify(value) } catch { return undefined }
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

function candidateKeyForConfiguredPair(pair) {
  const provider = nonEmpty(pair?.provider)
  const model = nonEmpty(pair?.model)
  if (!provider || !model) return undefined
  if (provider !== 'vision-http') return `${provider}/${model}`
  if (model.startsWith('local-ollama/') || model.startsWith('local-lmstudio/')) {
    return `vision-http/${model}`
  }
  return `http:${model}`
}

function pairForExecutionKey(key, configuredByKey) {
  const configured = configuredByKey.get(key)
  if (configured) return configured
  // Enabled local backends already participate in v1's tool chain. Auto may
  // move them earlier, but this does not introduce a backend that v1 could not
  // already call. Arbitrary discovered adapters and unconfigured direct HTTP
  // endpoints are deliberately not synthesized here.
  if (typeof key === 'string' && key.startsWith('vision-http/local-')) {
    const model = key.slice('vision-http/'.length)
    return model ? { provider: 'vision-http', model } : undefined
  }
  return undefined
}

export function autoExecutionConfigFor(config, suggestedOrder = []) {
  if (!plainObject(config) || !Array.isArray(suggestedOrder)) return undefined
  const original = configuredPairs(config)
  const configuredByKey = new Map()
  for (const pair of original) {
    const key = candidateKeyForConfiguredPair(pair)
    if (key && !configuredByKey.has(key)) configuredByKey.set(key, pair)
  }

  const next = []
  const seen = new Set()
  const addPair = (pair) => {
    if (!pair) return
    const id = `${pair.provider}\u0000${pair.model}`
    if (seen.has(id)) return
    seen.add(id)
    next.push({ provider: pair.provider, model: pair.model })
  }
  for (const key of suggestedOrder) addPair(pairForExecutionKey(key, configuredByKey))
  // A configured route omitted from the evidence pool (for example because an
  // adapter is temporarily unavailable) is never deleted. It remains behind
  // the planned routes and v1 keeps its existing availability/fallback rules.
  for (const pair of original) addPair(pair)
  if (next.length === 0) return undefined

  const originalIds = original.map((pair) => `${pair.provider}\u0000${pair.model}`)
  const nextIds = next.map((pair) => `${pair.provider}\u0000${pair.model}`)
  if (originalIds.length === nextIds.length && originalIds.every((id, index) => id === nextIds[index])) {
    return undefined
  }

  const first = next[0]
  return {
    ...config,
    provider: first.provider,
    model: first.model,
    fallbacks: [],
    providers: next.map((pair) => ({ ...pair, fallbacks: [] })),
  }
}

function settingsScopeWithAutoExecution(scope) {
  if (!scope || (typeof scope !== 'object' && typeof scope !== 'function')) return scope
  const cached = scopedSettingsCache.get(scope)
  if (cached) return cached
  const wrapped = new Proxy(scope, {
    get(target, property) {
      if (property === 'get') {
        const get = Reflect.get(target, property, target)
        if (typeof get !== 'function') return get
        return (...args) => {
          const scoped = autoExecutionConfig.getStore()?.config
          return scoped ?? get.call(target, ...args)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  scopedSettingsCache.set(scope, wrapped)
  return wrapped
}

function settingsServiceWithAutoExecution(settings, ownerContext) {
  if (!settings || (typeof settings !== 'object' && typeof settings !== 'function')) return settings
  let byOwner = scopedSettingsServiceCache.get(settings)
  if (!byOwner) {
    byOwner = new WeakMap()
    scopedSettingsServiceCache.set(settings, byOwner)
  }
  const cached = ownerContext && byOwner.get(ownerContext)
  if (cached) return cached
  const wrapped = new Proxy(settings, {
    get(target, property) {
      if (property === 'register') {
        const register = Reflect.get(target, property, target)
        if (typeof register !== 'function') return register
        return (namespace, ...args) => {
          const scope = register.call(target, namespace, ...args)
          if (namespace !== 'vision-router') return scope
          const scoped = settingsScopeWithAutoExecution(scope)
          if (ownerContext && scoped && typeof scoped.get === 'function') {
            coreVisionSettingsScopeByContext.set(ownerContext, scoped)
          }
          return scoped
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  if (ownerContext) byOwner.set(ownerContext, wrapped)
  return wrapped
}

function injectedContextWithAutoExecution(ctx, ownerContext) {
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return ctx
  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'settings') {
        return settingsServiceWithAutoExecution(Reflect.get(target, property, target), ownerContext)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function injectWithAutoExecution(target) {
  const inject = Reflect.get(target, 'inject', target)
  if (typeof inject !== 'function') return inject
  return (dependencies, callback, ...rest) => {
    if (typeof callback !== 'function' || !Array.isArray(dependencies) || !dependencies.includes('settings')) {
      return inject.call(target, dependencies, callback, ...rest)
    }
    return inject.call(target, dependencies, (child, ...args) =>
      callback(injectedContextWithAutoExecution(child, target), ...args), ...rest)
  }
}

function safeScopeProbe(target) {
  const scope = coreVisionSettingsScopeByContext.get(target)
  if (!scope || typeof scope.get !== 'function') {
    return {
      ok: false,
      scopeHooked: false,
      transientOverrideWorks: false,
      restored: false,
      providerRequestsMade: 0,
    }
  }
  let before
  try { before = scope.get() } catch {
    return {
      ok: false,
      scopeHooked: true,
      transientOverrideWorks: false,
      restored: false,
      providerRequestsMade: 0,
    }
  }
  const marker = `v2-probe-${Date.now().toString(36)}`
  const probeConfig = {
    ...(plainObject(before) ? before : {}),
    provider: marker,
    model: 'probe-primary',
    fallbacks: [],
    providers: [
      { provider: marker, model: 'probe-primary', fallbacks: [] },
      { provider: marker, model: 'probe-fallback', fallbacks: [] },
    ],
  }
  let inside
  try {
    inside = autoExecutionConfig.run({ config: probeConfig }, () => scope.get())
  } catch {
    inside = undefined
  }
  let after
  try { after = scope.get() } catch { after = undefined }
  const transientOverrideWorks = inside?.providers?.[0]?.provider === marker
    && inside?.providers?.[0]?.model === 'probe-primary'
    && inside?.providers?.[1]?.model === 'probe-fallback'
  const restored = configSnapshot(after) === configSnapshot(before)
  return {
    ok: transientOverrideWorks && restored,
    scopeHooked: true,
    transientOverrideWorks,
    restored,
    providerRequestsMade: 0,
  }
}

function sendProbeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function installAutoExecutionScopeProbe(ctx, ownerContext) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    if (!webCtx?.webServer || typeof webCtx.webServer.register !== 'function' || typeof webCtx.effect !== 'function') return
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: V2_AUTO_EXECUTION_PROBE_PATH,
        handler(req, res) {
          if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET')
            sendProbeJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          sendProbeJson(res, 200, {
            ...safeScopeProbe(ownerContext),
            executionCapable: true,
            executionScope: 'router-owned-visual-tools',
            executionFailClosed: true,
          })
        },
      }),
      'vision-router: read-only v2 Auto execution scope probe',
    )
  })
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
  return { scores, measuredAtByAxis, measuredAt: timestamps.length > 0 ? Math.max(...timestamps) : undefined }
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
  const fingerprint = capabilityEvidenceFingerprint({ provider: candidate.provider, model: candidate.model, endpoint, config: endpointConfig })
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
    ...(measured ? { measured: measured.scores, measuredAt: measured.measuredAt, measuredAtByAxis: measured.measuredAtByAxis } : {}),
    ...(Number.isFinite(Number(rawRecord?.benchmarkLatencyMs)) ? { benchmarkLatencyMs: Number(rawRecord.benchmarkLatencyMs) } : {}),
    ...(rawRecord?.benchmarkMedianLatencyMsByAxis ? { benchmarkMedianLatencyMsByAxis: rawRecord.benchmarkMedianLatencyMsByAxis } : {}),
    ...(runtime?.runtimeLatencyMsByAxis ? { runtimeLatencyMsByAxis: runtime.runtimeLatencyMsByAxis } : {}),
    ...(runtime?.observedLatencyMsByAxis ? { runtimeObservedLatencyMsByAxis: runtime.observedLatencyMsByAxis } : {}),
    ...(runtime?.sampleCountByAxis ? { runtimeSampleCountByAxis: runtime.sampleCountByAxis } : {}),
    ...(runtime?.observedAtByAxis ? { runtimeObservedAtByAxis: runtime.observedAtByAxis } : {}),
    ...(Number.isFinite(Number(runtime?.maxAgeMs)) ? { runtimePerformanceMaxAgeMs: Number(runtime.maxAgeMs) } : {}),
    ...(Number.isFinite(Number(runtime?.minSamples)) ? { runtimePerformanceMinSamples: Number(runtime.minSamples) } : {}),
  }
}

export async function collectCapabilityShadowCandidates(ctx, config, core, store, runtimePerformanceStore) {
  const { out, seen, configuredHttpRoutes, sources } = await configuredAndLocalCandidates(ctx, config, core)
  appendHttpCandidates(config, core, out, seen, configuredHttpRoutes, sources)
  const enriched = []
  for (const candidate of out) enriched.push(await attachEndpointEvidence(ctx, candidate, store, runtimePerformanceStore))
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

export async function buildCapabilityShadowPlan({ ctx, config, core, store, runtimePerformanceStore, toolName, args, bootstrap, healthForCandidate, healthContext } = {}) {
  const routing = resolveVisionRoutingProduct(config)
  const candidates = await collectCapabilityShadowCandidates(ctx, config, core, store, runtimePerformanceStore)
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

function wrapTools(tools, ctx, fallbackConfig, core, store, runtimePerformanceStore, bootstrapBySession, logger, healthForCandidate, acceptanceObserver) {
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
            return withVisionRuntimePerformanceScope(def.name, args, async () => {
              const liveAtPlan = liveSettings(ctx)
              const authorityAtPlan = resolveVisionRoutingAuthority(liveAtPlan ?? {})
              const shadowConfig = activeSettings(ctx, fallbackConfig)
              const shadowEnabled = shadowConfig?.capabilityRoutingShadow === true
              const shouldPlan = shadowEnabled || authorityAtPlan.autoSelectionAuthorized
              const session = exec?.agent?.session
              let plan
              let planSnapshot

              if (shouldPlan) {
                try {
                  // An Auto plan is based only on a cloned live settings value.
                  // Shadow-only diagnostics may still use the boot fallback.
                  const planningConfig = authorityAtPlan.autoSelectionAuthorized
                    ? cloneConfig(liveAtPlan)
                    : shadowConfig
                  planSnapshot = authorityAtPlan.autoSelectionAuthorized
                    ? configSnapshot(planningConfig)
                    : undefined
                  plan = await buildCapabilityShadowPlan({
                    ctx, config: planningConfig, core, store, runtimePerformanceStore, toolName: def.name, args,
                    bootstrap: session ? bootstrapBySession.get(session) : undefined,
                    healthForCandidate,
                    healthContext: { session, exec, toolName: def.name, args },
                  })
                  if (shadowEnabled) {
                    logger?.info?.(
                      'vision-router: v2 shadow mode=%s preference=%s intent=%s strategy=%s current=[%s] suggested=[%s] measured=[%s] blocked=[%s]',
                      plan.routingMode, plan.routingPreference, plan.intent, plan.strategy,
                      bounded(plan.currentOrder.join(' -> '), 1200), bounded(plan.autoPreviewOrder.join(' -> '), 1200),
                      bounded(plan.measuredBackends.join(', '), 600), bounded(plan.blockedBackends.join(', '), 600),
                    )
                  }
                } catch (error) {
                  // Planner/evidence failures are never execution failures.
                  // v1 configured order remains the fail-closed baseline.
                  logger?.warn?.('vision-router: v2 auto/shadow planning failed: %s', bounded(error?.message ?? error, 400))
                  plan = undefined
                }
              }

              const executeOriginal = () => def.execute(args, exec)
              let result
              if (plan && authorityAtPlan.autoSelectionAuthorized && planSnapshot !== undefined) {
                try {
                  const configuredOrder = configuredPairs(liveAtPlan)
                    .map(candidateKeyForConfiguredPair)
                    .filter(Boolean)
                  const plannedOrder = Array.isArray(plan.autoPreviewOrder) ? plan.autoPreviewOrder : []
                  await acceptanceObserver?.beforeLiveCheck?.({
                    kind: 'auto-plan',
                    intent: plan.intent,
                    axis: benchmarkAxisForVisionIntent(plan.intent),
                    routingMode: plan.routingMode,
                    routingPreference: plan.routingPreference,
                    configuredOrder,
                    plannedOrder,
                    changed: configuredOrder.join('\u0000') !== plannedOrder.slice(0, configuredOrder.length).join('\u0000'),
                    decision: plan.decisions?.find?.((entry) => entry?.type === 'reorder'),
                  })
                } catch {
                  // Acceptance observation is inert outside an explicitly
                  // scoped maintainer run and can never change execution.
                }
                // Re-read the live user grant immediately before changing the
                // fallback order. If anything in settings changed while the
                // asynchronous planner was gathering evidence, discard the
                // stale plan rather than trying to be clever.
                const liveBeforeExecute = liveSettings(ctx)
                const authorityBeforeExecute = resolveVisionRoutingAuthority(liveBeforeExecute ?? {})
                const settingsUnchanged = configSnapshot(liveBeforeExecute) === planSnapshot
                if (authorityBeforeExecute.autoSelectionAuthorized && settingsUnchanged) {
                  const executionConfig = autoExecutionConfigFor(liveBeforeExecute, plan.autoPreviewOrder)
                  if (executionConfig) {
                    const selectedOrder = configuredPairs(executionConfig)
                      .map(candidateKeyForConfiguredPair)
                      .filter(Boolean)
                    try {
                      acceptanceObserver?.record?.({
                        kind: 'auto-scope',
                        intent: plan.intent,
                        axis: benchmarkAxisForVisionIntent(plan.intent),
                        configuredOrder: configuredPairs(liveBeforeExecute)
                          .map(candidateKeyForConfiguredPair)
                          .filter(Boolean),
                        selectedOrder,
                        changed: true,
                      })
                    } catch {}
                    logger?.info?.(
                      'vision-router: v2 auto execute preference=%s intent=%s configured=[%s] selected=[%s]',
                      plan.routingPreference,
                      plan.intent,
                      bounded(configuredPairs(liveBeforeExecute).map(candidateKeyForConfiguredPair).filter(Boolean).join(' -> '), 1200),
                      bounded(selectedOrder.join(' -> '), 1200),
                    )
                    result = await autoExecutionConfig.run({ config: executionConfig }, executeOriginal)
                  } else {
                    result = await executeOriginal()
                  }
                } else {
                  const reason = authorityBeforeExecute.autoSelectionAuthorized ? 'settings-changed' : 'authority-revoked'
                  try {
                    acceptanceObserver?.record?.({
                      kind: 'auto-skipped',
                      intent: plan.intent,
                      axis: benchmarkAxisForVisionIntent(plan.intent),
                      reason,
                    })
                  } catch {}
                  logger?.info?.(
                    'vision-router: v2 auto skipped before execution reason=%s',
                    reason,
                  )
                  result = await executeOriginal()
                }
              } else {
                result = await executeOriginal()
              }

              if (session && def.name === 'vision_bootstrap') {
                const evidence = bootstrapEvidence(result)
                if (evidence !== undefined) bootstrapBySession.set(session, evidence)
              }
              return result
            })
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
  const runtimePerformanceStore = options.runtimePerformanceStore
  const healthForCandidate = options.healthForCandidate
  const acceptanceObserver = options.acceptanceObserver
  const bootstrapBySession = new WeakMap()
  installAutoExecutionScopeProbe(ctx, ctx)
  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') return wrapTools(target.tools, target, config, core, store, runtimePerformanceStore, bootstrapBySession, logger, healthForCandidate, acceptanceObserver)
      if (property === 'inject') return injectWithAutoExecution(target)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
