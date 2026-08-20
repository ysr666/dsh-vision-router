import {
  normalizeVisionRoutingMode,
  normalizeVisionRoutingPreference,
} from './vision-routing-product.js'

export const MAX_RUNTIME_PROVIDER_ROWS = 32
export const MAX_RUNTIME_FALLBACKS_PER_ROW = 32
export const MAX_RUNTIME_MODEL_ID_CHARS = 512

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_RUNTIME_MODEL_ID_CHARS
}

function normalizeFallbacks(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const fallback of value) {
    if (!validIdentifier(fallback)) continue
    out.push(fallback)
    if (out.length >= MAX_RUNTIME_FALLBACKS_PER_ROW) break
  }
  return out
}

/**
 * Normalize only bounded runtime-facing fields. Settings normally validates
 * these through Schemastery, but direct apply() callers, migrations, corrupted
 * profile data, or a future settings bridge can still hand runtime code a
 * structurally invalid object.
 *
 * routingMode/routingPreference are product semantics rather than executor
 * implementation toggles. The unreleased capabilityRoutingStrategy field is
 * accepted only as a compatibility source for the new preference vocabulary.
 */
export function normalizeRuntimeVisionConfig(value) {
  const source = plainObject(value) ? value : {}
  const providers = []
  if (Array.isArray(source.providers)) {
    for (const entry of source.providers) {
      if (!plainObject(entry) || !validIdentifier(entry.provider) || !validIdentifier(entry.model)) continue
      providers.push({
        ...entry,
        provider: entry.provider,
        model: entry.model,
        fallbacks: normalizeFallbacks(entry.fallbacks),
      })
      if (providers.length >= MAX_RUNTIME_PROVIDER_ROWS) break
    }
  }

  return {
    ...source,
    providers,
    fallbacks: normalizeFallbacks(source.fallbacks),
    routingMode: normalizeVisionRoutingMode(source.routingMode),
    routingPreference: normalizeVisionRoutingPreference(
      source.routingPreference,
      source.capabilityRoutingStrategy,
    ),
  }
}
