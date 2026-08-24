import {
  normalizeVisionRoutingMode,
  normalizeVisionRoutingPreference,
} from './vision-routing-product.js'

export const MAX_RUNTIME_PROVIDER_ROWS = 32
export const MAX_RUNTIME_FALLBACKS_PER_ROW = 32
export const MAX_RUNTIME_MODEL_ID_CHARS = 512
export const RETIRED_RUNTIME_CONFIG_KEYS = Object.freeze([
  'visionGuideStep',
  'instantDescribe',
  'localDescribeStyle',
])

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
 * implementation toggles. Unknown fields from older settings documents are
 * preserved by the Host but do not influence these product controls.
 *
 * The three retired UI-era keys are deliberately stripped here. Their schema
 * tombstones remain temporarily load-tolerant for 1.7.x profiles while the
 * settings migration removes persisted overrides; user values can no longer
 * reach live runtime decisions.
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

  const {
    visionGuideStep: _visionGuideStep,
    instantDescribe: _instantDescribe,
    localDescribeStyle: _localDescribeStyle,
    ...active
  } = source

  return {
    ...active,
    providers,
    fallbacks: normalizeFallbacks(source.fallbacks),
    routingMode: normalizeVisionRoutingMode(source.routingMode),
    routingPreference: normalizeVisionRoutingPreference(source.routingPreference),
  }
}
