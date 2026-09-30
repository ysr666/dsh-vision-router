import { normalizeVisionRoutingMode } from './vision-routing-product.js'

export const BACKGROUND_MEASUREMENT_MODES = Object.freeze(['off', 'local-free', 'all'])

const BACKGROUND_MEASUREMENT_SET = new Set(BACKGROUND_MEASUREMENT_MODES)
const MANUAL_MEASUREMENT_GRANT = Symbol('vision-router-manual-measurement-grant')

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeBackgroundMeasurementAuthority(value, fallback = 'off') {
  const normalizedFallback = BACKGROUND_MEASUREMENT_SET.has(fallback) ? fallback : 'off'
  return typeof value === 'string' && BACKGROUND_MEASUREMENT_SET.has(value.trim())
    ? value.trim()
    : normalizedFallback
}

/**
 * Resolve only user-delegated v2 authority. Evidence, preference, credentials,
 * capability gaps, or internal shadow switches must never widen this result.
 */
export function resolveVisionRoutingAuthority(config = {}) {
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
export function grantManualMeasurementFromUserAction(source = 'local-ui') {
  if (source !== 'local-ui') {
    throw new TypeError('manual measurement authority source must be local-ui')
  }
  return Object.freeze({
    kind: 'manual-measurement',
    source,
    [MANUAL_MEASUREMENT_GRANT]: true,
  })
}

export function hasManualMeasurementAuthority(value) {
  return !!value && value[MANUAL_MEASUREMENT_GRANT] === true && value.kind === 'manual-measurement'
}

export function assertManualMeasurementAuthority(value) {
  if (hasManualMeasurementAuthority(value)) return value
  const error = new Error('explicit manual measurement authority is required')
  error.code = 'CAPABILITY_BENCHMARK_AUTHORITY_REQUIRED'
  throw error
}
