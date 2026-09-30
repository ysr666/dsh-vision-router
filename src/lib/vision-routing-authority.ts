import {
  normalizeVisionRoutingMode,
  type VisionRoutingMode,
} from './vision-routing-product.js'

export const BACKGROUND_MEASUREMENT_MODES = Object.freeze(['off', 'local-free', 'all'] as const)

export type BackgroundMeasurementMode = (typeof BACKGROUND_MEASUREMENT_MODES)[number]

export interface VisionRoutingAuthority {
  execution: VisionRoutingMode
  autoSelectionAuthorized: boolean
  backgroundMeasurement: BackgroundMeasurementMode
  backgroundMeasurementAuthorized: boolean
  backgroundMeasurementActive: boolean
  ephemeralRuntimeObservation: boolean
  persistentLearning: false
}

const BACKGROUND_MEASUREMENT_SET: ReadonlySet<string> = new Set(BACKGROUND_MEASUREMENT_MODES)
const MANUAL_MEASUREMENT_GRANT = Symbol('vision-router-manual-measurement-grant')

export interface ManualMeasurementGrant {
  readonly kind: 'manual-measurement'
  readonly source: 'local-ui'
  readonly [MANUAL_MEASUREMENT_GRANT]: true
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeBackgroundMeasurementAuthority(
  value: unknown,
  fallback: unknown = 'off',
): BackgroundMeasurementMode {
  const normalizedFallback = typeof fallback === 'string' && BACKGROUND_MEASUREMENT_SET.has(fallback)
    ? fallback as BackgroundMeasurementMode
    : 'off'
  const candidate = typeof value === 'string' ? value.trim() : ''
  return BACKGROUND_MEASUREMENT_SET.has(candidate)
    ? candidate as BackgroundMeasurementMode
    : normalizedFallback
}

/**
 * Resolve only user-delegated v2 authority. Evidence, preference, credentials,
 * capability gaps, or internal shadow switches must never widen this result.
 */
export function resolveVisionRoutingAuthority(config: unknown = {}): Readonly<VisionRoutingAuthority> {
  const source = plainObject(config) ? config : {}
  const execution = normalizeVisionRoutingMode(source.routingMode)
  const backgroundMeasurement = normalizeBackgroundMeasurementAuthority(source.backgroundBenchmarking)
  const autoSelectionAuthorized = execution === 'auto'
  const backgroundMeasurementAuthorized = backgroundMeasurement !== 'off'

  return Object.freeze({
    execution,
    autoSelectionAuthorized,
    backgroundMeasurement,
    backgroundMeasurementAuthorized,
    // Current background profiler is useful only for Auto preparation, but the
    // standing measurement grant remains independent from execution authority.
    backgroundMeasurementActive: autoSelectionAuthorized && backgroundMeasurementAuthorized,
    ephemeralRuntimeObservation: autoSelectionAuthorized,
    // No v2 setting currently grants durable user-specific behavioral learning.
    persistentLearning: false,
  })
}

/**
 * A manual measurement grant is intentionally opaque and process-local. The
 * local HTTP action creates one only after an explicit user POST. Requiring the
 * token at the manager API prevents future internal callers from silently
 * inheriting "manual" semantics by convention.
 */
export function grantManualMeasurementFromUserAction(source: unknown = 'local-ui'): Readonly<ManualMeasurementGrant> {
  if (source !== 'local-ui') {
    throw new TypeError('manual measurement authority source must be local-ui')
  }
  return Object.freeze({
    kind: 'manual-measurement',
    source,
    [MANUAL_MEASUREMENT_GRANT]: true,
  })
}

export function hasManualMeasurementAuthority(value: unknown): value is ManualMeasurementGrant {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ManualMeasurementGrant>
  return candidate[MANUAL_MEASUREMENT_GRANT] === true && candidate.kind === 'manual-measurement'
}

export function assertManualMeasurementAuthority(value: unknown): ManualMeasurementGrant {
  if (hasManualMeasurementAuthority(value)) return value
  const error = new Error('explicit manual measurement authority is required') as Error & { code: string }
  error.code = 'CAPABILITY_BENCHMARK_AUTHORITY_REQUIRED'
  throw error
}
