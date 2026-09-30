// User-facing routing semantics for Vision Router 2.0.
//
// Keep product language separate from the scorer's internal `privacy`
// strategy name.
// A user chooses whether routing is automatic or strictly ordered, then chooses
// a plain-language preference. The actual execution-changing auto mode is
// enabled only when the runtime is ready to honor this contract.

export const VISION_ROUTING_MODES = Object.freeze(['ordered', 'auto'] as const)
export const VISION_ROUTING_PREFERENCES = Object.freeze(['balanced', 'quality', 'speed', 'local'] as const)

export type VisionRoutingMode = (typeof VISION_ROUTING_MODES)[number]
export type VisionRoutingPreference = (typeof VISION_ROUTING_PREFERENCES)[number]
export type VisionCapabilityStrategy = 'balanced' | 'quality' | 'speed' | 'privacy'

export interface VisionRoutingProduct {
  mode: VisionRoutingMode
  preference: VisionRoutingPreference
  strategy: VisionCapabilityStrategy
  automatic: boolean
}

const MODE_SET: ReadonlySet<string> = new Set(VISION_ROUTING_MODES)
const PREFERENCE_SET: ReadonlySet<string> = new Set(VISION_ROUTING_PREFERENCES)

export function normalizeVisionRoutingMode(value: unknown, fallback: unknown = 'ordered'): VisionRoutingMode {
  const normalizedFallback = typeof fallback === 'string' && MODE_SET.has(fallback) ? fallback as VisionRoutingMode : 'ordered'
  const candidate = typeof value === 'string' ? value.trim() : ''
  return MODE_SET.has(candidate) ? candidate as VisionRoutingMode : normalizedFallback
}

export function normalizeVisionRoutingPreference(value: unknown): VisionRoutingPreference {
  if (typeof value === 'string') {
    const candidate = value.trim()
    if (PREFERENCE_SET.has(candidate)) return candidate as VisionRoutingPreference
  }

  return 'balanced'
}

export function routingPreferenceToCapabilityStrategy(preference: unknown): VisionCapabilityStrategy {
  const normalized = normalizeVisionRoutingPreference(preference)
  return normalized === 'local' ? 'privacy' : normalized
}

export function resolveVisionRoutingProduct(config: unknown = {}): VisionRoutingProduct {
  const source = config && typeof config === 'object' && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {}
  const mode = normalizeVisionRoutingMode(source.routingMode)
  const preference = normalizeVisionRoutingPreference(source.routingPreference)
  return {
    mode,
    preference,
    strategy: routingPreferenceToCapabilityStrategy(preference),
    automatic: mode === 'auto',
  }
}
