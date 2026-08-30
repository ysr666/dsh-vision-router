import { createHash } from 'node:crypto'
import {
  hasTrustedVisionHint,
  trustedVisionHintEntries,
} from './trusted-vision-hints.js'

/**
 * Vision Router's settings picker has four independent model-id sources:
 *
 * 1. DSH's adapter catalog (`llm.models`) — authoritative when present.
 * 2. The provider's live `/models` listing — endpoint evidence, kept private to
 *    Vision Router by the client prelude.
 * 3. Endpoint-scoped trusted visual hints — a very small compatibility list
 *    for official APIs that demonstrably accept visual models omitted from
 *    their OpenAI-compatible `/models` listing.
 * 4. A model already saved in Vision Router settings — compatibility evidence
 *    only. A saved id remains visible/editable but never authorizes a direct
 *    UNKNOWN_MODEL bridge by itself.
 */
export const VISION_MODEL_REGISTRY_REVISION = 2

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function configFromSettings(ctx) {
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

function excludedProvider(provider, config = {}) {
  if (provider === 'vision-http') return true
  const wrapperRoute = nonEmpty(config.wrapperRoute) ?? 'deepseek-vision'
  const chainRoute = nonEmpty(config.chainRoute) ?? 'vision-chain'
  if (provider === wrapperRoute || provider === chainRoute) return true
  return provider.endsWith('-vision')
}

function addPair(target, seen, providerValue, modelValue, config) {
  const provider = nonEmpty(providerValue)
  const model = nonEmpty(modelValue)
  if (provider === undefined || model === undefined || excludedProvider(provider, config)) return
  const key = `${provider}\u0000${model}`
  if (seen.has(key)) return
  seen.add(key)
  target.push({ provider, model })
}

export function configuredVisionPairs(ctx, fallbackConfig = {}) {
  const current = configFromSettings(ctx) ?? fallbackConfig
  const pairs = []
  const seen = new Set()
  const rows = Array.isArray(current?.providers) ? current.providers : []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    addPair(pairs, seen, row.provider, row.model, current)
    for (const fallback of Array.isArray(row.fallbacks) ? row.fallbacks : []) {
      addPair(pairs, seen, row.provider, fallback, current)
    }
  }

  if (pairs.length === 0) {
    addPair(pairs, seen, current?.provider, current?.model, current)
    for (const fallback of Array.isArray(current?.fallbacks) ? current.fallbacks : []) {
      addPair(pairs, seen, current?.provider, fallback, current)
    }
  }
  return pairs
}

export function isProviderActive(ctx, provider) {
  if (nonEmpty(provider) === undefined) return false
  try {
    ctx?.llm?.registration?.(provider)
    return typeof ctx?.llm?.registration === 'function'
  } catch {
    return false
  }
}

function modelId(model) {
  return nonEmpty(model?.id)
}

function sourceName(model, source) {
  const id = modelId(model)
  if (id === undefined) return undefined
  const base = nonEmpty(model?.name) ?? id
  return `${base} [${source}]`
}

function normalizedLiveEntry(entry) {
  const provider = nonEmpty(entry?.provider)
  if (provider === undefined) return undefined
  const stale = entry?.stale === true
  const source = stale ? 'cached' : 'live'
  const seen = new Set()
  const models = []
  for (const model of Array.isArray(entry?.models) ? entry.models : []) {
    const id = modelId(model)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    models.push({
      ...model,
      id,
      name: sourceName(model, source),
      visionRouterSource: source,
    })
  }
  return {
    ...entry,
    provider,
    models,
    stale,
    visionRouterSource: source,
  }
}

function registryFingerprint(baseVersion, configured, activeConfigured, hinted) {
  return createHash('sha256')
    .update(JSON.stringify({
      revision: VISION_MODEL_REGISTRY_REVISION,
      baseVersion: baseVersion ?? 0,
      configured,
      activeConfigured,
      hinted,
    }))
    .digest('hex')
    .slice(0, 12)
}

function ensureProviderEntry(ordered, byProvider, provider, seed = {}) {
  let entry = byProvider.get(provider)
  if (entry) return entry
  entry = {
    provider,
    models: [],
    discoveredAt: 0,
    stale: true,
    ...seed,
  }
  byProvider.set(provider, entry)
  ordered.push(entry)
  return entry
}

export function decorateVisionModelSnapshot(snapshot, {
  ctx,
  config = {},
} = {}) {
  if (!snapshot || snapshot.ok !== true) return snapshot

  const ordered = []
  const byProvider = new Map()
  for (const raw of Array.isArray(snapshot.providers) ? snapshot.providers : []) {
    const entry = normalizedLiveEntry(raw)
    if (!entry || byProvider.has(entry.provider)) continue
    byProvider.set(entry.provider, entry)
    ordered.push(entry)
  }

  const hinted = []
  for (const hintEntry of trustedVisionHintEntries(ctx)) {
    if (!isProviderActive(ctx, hintEntry.provider)) continue
    const entry = ensureProviderEntry(ordered, byProvider, hintEntry.provider, {
      hintedOnly: true,
      visionRouterSource: 'known',
    })
    for (const model of hintEntry.models) {
      const id = modelId(model)
      if (id === undefined) continue
      hinted.push({ provider: hintEntry.provider, model: id })
      if (entry.models.some((candidate) => modelId(candidate) === id)) continue
      entry.models.push({
        ...model,
        id,
        name: sourceName(model, 'known'),
        visionRouterSource: 'known',
        visionRouterTrustedHint: true,
      })
    }
  }

  const configured = configuredVisionPairs(ctx, config)
  const activeConfigured = []
  for (const pair of configured) {
    if (!isProviderActive(ctx, pair.provider)) continue
    activeConfigured.push(pair)
    const entry = ensureProviderEntry(ordered, byProvider, pair.provider, {
      configuredOnly: true,
      visionRouterSource: 'configured',
    })
    if (entry.models.some((model) => modelId(model) === pair.model)) continue
    entry.models.push({
      id: pair.model,
      name: `${pair.model} [saved]`,
      visionRouterSource: 'configured',
    })
  }

  const fingerprint = registryFingerprint(snapshot.version, configured, activeConfigured, hinted)
  return {
    ...snapshot,
    version: `${String(snapshot.version ?? 0)}:vr${VISION_MODEL_REGISTRY_REVISION}:${fingerprint}`,
    providers: ordered,
    registry: {
      revision: VISION_MODEL_REGISTRY_REVISION,
      configuredCount: configured.length,
      activeConfiguredCount: activeConfigured.length,
      trustedHintCount: hinted.length,
      sources: ['dsh-catalog', 'provider-live', 'trusted-vision-hints', 'saved-compat'],
    },
  }
}

export function installVisionModelRegistry(ctx, liveDiscovery, options = {}) {
  if (!liveDiscovery || typeof liveDiscovery.snapshot !== 'function') return liveDiscovery
  if (liveDiscovery.snapshot.__visionRouterRegistry === true) return liveDiscovery

  const originalSnapshot = liveDiscovery.snapshot.bind(liveDiscovery)
  const originalHasModel = typeof liveDiscovery.hasModel === 'function'
    ? liveDiscovery.hasModel.bind(liveDiscovery)
    : () => false
  const originalEvidenceSource = typeof liveDiscovery.evidenceSource === 'function'
    ? liveDiscovery.evidenceSource.bind(liveDiscovery)
    : undefined

  const wrappedSnapshot = async (request) => decorateVisionModelSnapshot(
    await originalSnapshot(request),
    { ctx, config: options.config ?? {} },
  )
  // Diagnostics-only provenance. This must never become the admission oracle:
  // `hasModel()` keeps the exact pre-existing authority boundary (current live
  // endpoint evidence OR exact endpoint-scoped trusted hint).
  const wrappedEvidenceSource = (provider, model) => {
    if (isProviderActive(ctx, provider) && hasTrustedVisionHint(ctx, provider, model)) return 'known'
    if (originalHasModel(provider, model)) return 'live'
    try {
      return originalEvidenceSource?.(provider, model)
    } catch {
      return undefined
    }
  }
  const wrappedHasModel = (provider, model) => (
    originalHasModel(provider, model) ||
    (isProviderActive(ctx, provider) && hasTrustedVisionHint(ctx, provider, model))
  )

  Object.defineProperty(wrappedSnapshot, '__visionRouterRegistry', { value: true })
  Object.defineProperty(wrappedHasModel, '__visionRouterRegistry', { value: true })
  Object.defineProperty(wrappedEvidenceSource, '__visionRouterRegistry', { value: true })
  liveDiscovery.snapshot = wrappedSnapshot
  liveDiscovery.hasModel = wrappedHasModel
  liveDiscovery.evidenceSource = wrappedEvidenceSource

  try {
    ctx?.effect?.(() => () => {
      if (liveDiscovery.snapshot === wrappedSnapshot) liveDiscovery.snapshot = originalSnapshot
      if (liveDiscovery.hasModel === wrappedHasModel) liveDiscovery.hasModel = originalHasModel
      if (liveDiscovery.evidenceSource === wrappedEvidenceSource) {
        if (originalEvidenceSource === undefined) delete liveDiscovery.evidenceSource
        else liveDiscovery.evidenceSource = originalEvidenceSource
      }
    }, 'vision-router: private model registry sources')
  } catch {
    // The manager itself is disposed with the plugin; restoration is hygiene.
  }
  return liveDiscovery
}
