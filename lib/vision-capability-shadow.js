import {
  explainVisionRoute,
  inferToolVisionIntent,
  rankVisionCandidates,
  VISION_STRATEGIES,
} from './vision-capability-router.js'
import { capabilityBenchmarkFingerprint } from './vision-capability-benchmark.js'
import { createCapabilityProfileStore } from './vision-capability-probe.js'
import { providerTransportFor } from './live-model-discovery.js'

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
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function bootstrapEvidence(value) {
  const parsed = parseJson(value)
  return parsed && parsed.ok === true && parsed.evidence && typeof parsed.evidence === 'object'
    ? parsed.evidence
    : undefined
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

function strategyOf(config) {
  return VISION_STRATEGIES.includes(config?.capabilityRoutingStrategy)
    ? config.capabilityRoutingStrategy
    : 'balanced'
}

function addCandidate(out, seen, candidate) {
  const key = nonEmpty(candidate?.key) ?? `${nonEmpty(candidate?.provider) ?? ''}/${nonEmpty(candidate?.model) ?? ''}`
  if (key === '/' || seen.has(key)) return
  seen.add(key)
  out.push({ ...candidate, key })
}

function configuredPairs(config) {
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

async function modelInfo(ctx, provider, model) {
  try {
    if (typeof ctx?.llm?.resolveModelInfo === 'function') return await ctx.llm.resolveModelInfo(provider, model)
  } catch {
    // Metadata is advisory only; explicit configured rows remain attemptable.
  }
  return undefined
}

export function generatedCapabilityRoute(provider, config) {
  const wrapper = nonEmpty(config?.wrapperRoute) ?? 'deepseek-vision'
  const chain = nonEmpty(config?.chainRoute) ?? 'vision-chain'
  return provider === wrapper || provider === chain
}

async function configuredAndLocalCandidates(ctx, config, core) {
  const out = []
  const seen = new Set()
  for (const pair of configuredPairs(config)) {
    if (pair.provider === 'vision-http' || generatedCapabilityRoute(pair.provider, config)) continue
    let available = true
    try { available = core.adapterAvailable(ctx.llm, pair.provider) } catch { available = true }
    if (!available) continue
    const info = await modelInfo(ctx, pair.provider, pair.model)
    let decision
    try {
      decision = core.decideVisionBackendCapability(info, pair.provider, pair.model, config?.extraVisionModels)
    } catch {
      decision = { attemptable: true }
    }
    if (decision?.attemptable === false) continue
    addCandidate(out, seen, { provider: pair.provider, model: pair.model })
  }

  let locals = []
  try { locals = core.localProvidersOf(config) } catch { locals = [] }
  for (const provider of Array.isArray(locals) ? locals : []) {
    const name = nonEmpty(provider?.name)
    const model = nonEmpty(provider?.model)
    if (name === undefined || model === undefined) continue
    addCandidate(out, seen, {
      key: `vision-http/${name}/${model}`,
      provider: 'vision-http',
      model: `${name}/${model}`,
      local: true,
      privacy: 'local',
      endpoint: nonEmpty(provider.baseURL),
      endpointConfig: { api: 'openai-completions' },
      evidenceScope: 'endpoint',
    })
  }
  return { out, seen }
}

async function appendDiscoveredCandidates(ctx, config, core, out, seen) {
  if (typeof ctx?.llm?.listProviders !== 'function') return
  let providers
  try { providers = ctx.llm.listProviders() } catch { return }
  for (const row of Array.isArray(providers) ? providers : []) {
    const provider = nonEmpty(row?.id)
    if (provider === undefined || provider === 'vision-http' || generatedCapabilityRoute(provider, config)) continue
    let listed
    try {
      const registration = ctx.llm.registration(provider)
      if (!registration?.adapter || typeof registration.adapter.listModels !== 'function') continue
      listed = await registration.adapter.listModels(provider)
    } catch {
      continue
    }
    for (const modelInfo0 of Array.isArray(listed) ? listed : []) {
      const model = nonEmpty(modelInfo0?.id)
      if (model === undefined) continue
      let decision
      try {
        decision = core.decideVisionBackendCapability(modelInfo0, provider, model, config?.extraVisionModels)
      } catch {
        continue
      }
      if (!decision?.image || decision?.attemptable === false) continue
      addCandidate(out, seen, { provider, model })
    }
  }
}

function appendHttpCandidates(config, core, out, seen) {
  let providers = []
  try { providers = core.httpProvidersOf(config) } catch { providers = [] }
  for (const entry of Array.isArray(providers) ? providers : []) {
    const name = nonEmpty(entry?.name)
    const model = nonEmpty(entry?.model)
    if (name === undefined || model === undefined) continue
    const local = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(String(entry.baseURL ?? ''))
    addCandidate(out, seen, {
      key: `http:${name}/${model}`,
      provider: 'vision-http',
      model: `${name}/${model}`,
      local,
      privacy: local ? 'local' : 'cloud',
      endpoint: nonEmpty(entry.baseURL),
      endpointConfig: { api: 'openai-completions' },
      evidenceScope: 'endpoint',
      cost: name.toLowerCase().startsWith('ovh') && !nonEmpty(entry.apiKeyEnv) ? 0 : undefined,
    })
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
      endpointConfig: {
        api: 'dsh-adapter',
        adapterKind,
      },
      evidenceScope: 'adapter-route',
    }
  } catch {
    return undefined
  }
}

async function attachEndpointEvidence(ctx, candidate, store) {
  let endpoint = candidate.endpoint
  let endpointConfig = candidate.endpointConfig
  let evidenceScope = candidate.evidenceScope
  if (endpoint === undefined && candidate.provider !== 'vision-http') {
    const transport = providerTransportFor(ctx, candidate.provider)
    if (transport !== undefined) {
      endpoint = transport.baseURL
      endpointConfig = { api: transport.api }
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
  const fingerprint = capabilityBenchmarkFingerprint({
    provider: candidate.provider,
    model: candidate.model,
    endpoint,
    config: endpointConfig,
  })
  const measured = await store.get(fingerprint)
  const latencyValues = measured ? Object.values(measured.medianLatencyMs ?? {}).map(Number).filter(Number.isFinite) : []
  const latencyMs = measured?.latencyMs ?? (latencyValues.length > 0
    ? latencyValues.reduce((a, b) => a + b, 0) / latencyValues.length
    : candidate.latencyMs)
  return {
    ...candidate,
    endpoint,
    endpointConfig,
    evidenceScope: evidenceScope ?? 'endpoint',
    benchmarkable: true,
    endpointFingerprint: fingerprint,
    ...(measured ? { measured: measured.scores, measuredAt: measured.measuredAt } : {}),
    latencyMs,
  }
}

export async function collectCapabilityShadowCandidates(ctx, config, core, store) {
  const { out, seen } = await configuredAndLocalCandidates(ctx, config, core)
  await appendDiscoveredCandidates(ctx, config, core, out, seen)
  appendHttpCandidates(config, core, out, seen)
  const enriched = []
  for (const candidate of out) enriched.push(await attachEndpointEvidence(ctx, candidate, store))
  return enriched
}

export async function buildCapabilityShadowPlan({ ctx, config, core, store, toolName, args, bootstrap } = {}) {
  const strategy = strategyOf(config)
  const candidates = await collectCapabilityShadowCandidates(ctx, config, core, store)
  const intent = inferToolVisionIntent(toolName, args, { bootstrap })
  const measured = Object.fromEntries(
    candidates.filter((candidate) => candidate.measured).map((candidate) => [candidate.key, candidate.measured]),
  )
  const ranked = rankVisionCandidates({ intent, strategy, candidates, measured })
  return {
    intent,
    strategy,
    currentOrder: candidates.map((candidate) => candidate.key),
    suggestedOrder: ranked.map((candidate) => candidate.key),
    explanation: explainVisionRoute(ranked),
    measuredBackends: candidates.filter((candidate) => candidate.measured).map((candidate) => candidate.key),
  }
}

function wrapTools(tools, ctx, fallbackConfig, core, store, bootstrapBySession, logger) {
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
                const plan = await buildCapabilityShadowPlan({
                  ctx,
                  config,
                  core,
                  store,
                  toolName: def.name,
                  args,
                  bootstrap: session ? bootstrapBySession.get(session) : undefined,
                })
                logger?.info?.(
                  'vision-router: v2 shadow intent=%s strategy=%s current=[%s] suggested=[%s] measured=[%s]',
                  plan.intent,
                  plan.strategy,
                  bounded(plan.currentOrder.join(' -> '), 1200),
                  bounded(plan.suggestedOrder.join(' -> '), 1200),
                  bounded(plan.measuredBackends.join(', '), 600),
                )
              } catch (error) {
                logger?.warn?.('vision-router: v2 shadow planning failed: %s', bounded(error?.message ?? error, 400))
              }
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

/**
 * Read-only runtime shadow layer. It observes visual tool calls, builds a v2
 * ranking from the current candidate pool and logs the recommendation. It does
 * not reorder, skip, retry or replace any backend and therefore cannot change
 * the v1 fallback walk.
 */
export function installCapabilityShadowRuntime(ctx, config, core, options = {}) {
  if (!ctx || typeof ctx !== 'object') return ctx
  const logger = options.logger ?? ctx.logger
  const store = options.store ?? createCapabilityProfileStore({ logger })
  const bootstrapBySession = new WeakMap()
  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') {
        return wrapTools(target.tools, target, config, core, store, bootstrapBySession, logger)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
