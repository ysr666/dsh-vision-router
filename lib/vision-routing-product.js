// User-facing routing semantics for Vision Router 2.0.
//
// Keep product language separate from implementation details such as
// capabilityRoutingShadow or the scorer's historical `privacy` strategy name.
// A user chooses whether routing is automatic or strictly ordered, then chooses
// a plain-language preference. The actual execution-changing auto mode is
// enabled only when the runtime is ready to honor this contract.

export const VISION_ROUTING_MODES = Object.freeze(['ordered', 'auto'])
export const VISION_ROUTING_PREFERENCES = Object.freeze(['balanced', 'quality', 'speed', 'local'])

const MODE_SET = new Set(VISION_ROUTING_MODES)
const PREFERENCE_SET = new Set(VISION_ROUTING_PREFERENCES)
const LEGACY_STRATEGY_SET = new Set(['balanced', 'quality', 'speed', 'privacy'])

export function normalizeVisionRoutingMode(value, fallback = 'ordered') {
  const normalizedFallback = MODE_SET.has(fallback) ? fallback : 'ordered'
  return typeof value === 'string' && MODE_SET.has(value.trim()) ? value.trim() : normalizedFallback
}

export function normalizeVisionRoutingPreference(value, legacyStrategy) {
  if (typeof value === 'string') {
    const candidate = value.trim()
    if (PREFERENCE_SET.has(candidate)) return candidate
  }

  // Compatibility for unreleased/prototype configs written before the product
  // model was renamed. `privacy` meant "prefer local/private execution" in the
  // scorer, which is presented to users more concretely as "local first".
  if (typeof legacyStrategy === 'string') {
    const candidate = legacyStrategy.trim()
    if (LEGACY_STRATEGY_SET.has(candidate)) return candidate === 'privacy' ? 'local' : candidate
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
  const preference = normalizeVisionRoutingPreference(
    source.routingPreference,
    source.capabilityRoutingStrategy,
  )
  return {
    mode,
    preference,
    strategy: routingPreferenceToCapabilityStrategy(preference),
    automatic: mode === 'auto',
  }
}
