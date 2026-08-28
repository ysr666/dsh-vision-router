export const VISION_PRESENTATION_DTO_REVISION = 1

function healthClassOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown'
  if (value.circuitOpen === true && value.rateLimited === true) return 'rate-limited'
  if (value.circuitOpen === true) return 'blocked'
  if (value.circuitOpen === false) return 'healthy'
  return 'unknown'
}

function capabilityStateOf(candidate) {
  const measured = candidate?.measured
  if (measured && typeof measured === 'object' && Object.keys(measured).length > 0) return 'measured'
  return candidate?.benchmarkable === true ? 'unmeasured' : 'unavailable'
}

function benchmarkReasonOf(candidate) {
  if (!candidate) return 'candidate-unavailable'
  if (candidate.benchmarkable !== true) return 'stable-benchmark-identity-unavailable'
  return null
}

function localOrFree(candidate) {
  if (candidate?.local === true) return true
  if (candidate?.cost === 0) return true
  return candidate?.cloudCostWarning === false
}

function backgroundEligibilityOf(candidate, authority) {
  if (!authority?.backgroundMeasurementActive) {
    return { eligible: false, reason: 'background-measurement-not-active' }
  }
  if (candidate?.benchmarkable !== true) {
    return { eligible: false, reason: 'benchmark-unavailable' }
  }
  if (authority.backgroundMeasurement === 'all') return { eligible: true, reason: null }
  if (authority.backgroundMeasurement !== 'local-free') {
    return { eligible: false, reason: 'background-measurement-off' }
  }
  return localOrFree(candidate)
    ? { eligible: true, reason: null }
    : { eligible: false, reason: 'local-free-policy-excludes-cloud-cost' }
}

export function publicVisionAuthority(authority) {
  return Object.freeze({
    execution: authority?.execution,
    autoSelectionAuthorized: authority?.autoSelectionAuthorized === true,
    backgroundMeasurement: authority?.backgroundMeasurement,
    backgroundMeasurementAuthorized: authority?.backgroundMeasurementAuthorized === true,
    backgroundMeasurementActive: authority?.backgroundMeasurementActive === true,
  })
}

/**
 * Host-owned product decision projection for presentation surfaces.
 *
 * Inputs may be raw Host evidence candidates or the sanitized benchmark
 * candidate shape. Only stable product decisions are returned; transport,
 * credential, endpoint, fingerprint and breaker internals never cross this
 * boundary.
 */
export function projectVisionProductCandidate(candidate, health, authority) {
  const background = backgroundEligibilityOf(candidate, authority)
  return Object.freeze({
    key: String(candidate?.key ?? ''),
    provider: String(candidate?.provider ?? ''),
    model: String(candidate?.model ?? ''),
    canBenchmark: candidate?.benchmarkable === true,
    benchmarkReason: benchmarkReasonOf(candidate),
    routingMode: authority?.execution,
    currentAuthority: publicVisionAuthority(authority),
    healthClass: healthClassOf(health),
    capabilityState: capabilityStateOf(candidate),
    backgroundEligible: background.eligible,
    backgroundReason: background.reason,
  })
}
