// User-facing routing semantics for Vision Router 2.0.
//
// Keep product language separate from the scorer's internal `privacy`
// strategy name.
// A user chooses whether routing is automatic or strictly ordered, then chooses
// a plain-language preference. The actual execution-changing auto mode is
// enabled only when the runtime is ready to honor this contract.

export const VISION_ROUTING_MODES = Object.freeze(['ordered', 'auto'])
export const VISION_ROUTING_PREFERENCES = Object.freeze(['balanced', 'quality', 'speed', 'local'])

const MODE_SET = new Set(VISION_ROUTING_MODES)
const PREFERENCE_SET = new Set(VISION_ROUTING_PREFERENCES)

export function normalizeVisionRoutingMode(value, fallback = 'ordered') {
  const normalizedFallback = MODE_SET.has(fallback) ? fallback : 'ordered'
  return typeof value === 'string' && MODE_SET.has(value.trim()) ? value.trim() : normalizedFallback
}

export function normalizeVisionRoutingPreference(value) {
  if (typeof value === 'string') {
    const candidate = value.trim()
    if (PREFERENCE_SET.has(candidate)) return candidate
  }

  return 'balanced'
}

export function routingPreferenceToCapabilityStrategy(preference) {
  const normalized = normalizeVisionRoutingPreference(preference)
  return normalized === 'local' ? 'privacy' : normalized
}

export function resolveVisionRoutingProduct(config = {}) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const mode = normalizeVisionRoutingMode(source.routingMode)
  const preference = normalizeVisionRoutingPreference(source.routingPreference)
  return {
    mode,
    preference,
    strategy: routingPreferenceToCapabilityStrategy(preference),
    automatic: mode === 'auto',
  }
}
