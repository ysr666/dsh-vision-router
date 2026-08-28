import { collectVisionRoutingEvidence } from '../vision-routing-evidence.js'
import { resolveVisionRoutingAuthority } from '../vision-routing-authority.js'

function activeSettings(ctx, fallback) {
  try {
    const settings = ctx?.get?.('settings')
    const current = settings?.get?.('vision-router')
    return current && typeof current === 'object' && !Array.isArray(current) ? current : fallback
  } catch {
    return fallback
  }
}

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
  const localOrFree = candidate?.local === true || candidate?.cost === 0
  return localOrFree
    ? { eligible: true, reason: null }
    : { eligible: false, reason: 'local-free-policy-excludes-cloud-cost' }
}

function publicAuthority(authority) {
  return Object.freeze({
    execution: authority.execution,
    autoSelectionAuthorized: authority.autoSelectionAuthorized,
    backgroundMeasurement: authority.backgroundMeasurement,
    backgroundMeasurementAuthorized: authority.backgroundMeasurementAuthorized,
    backgroundMeasurementActive: authority.backgroundMeasurementActive,
  })
}

export function projectVisionProductCandidate(candidate, health, authority) {
  const background = backgroundEligibilityOf(candidate, authority)
  return Object.freeze({
    key: String(candidate?.key ?? ''),
    provider: String(candidate?.provider ?? ''),
    model: String(candidate?.model ?? ''),
    canBenchmark: candidate?.benchmarkable === true,
    benchmarkReason: benchmarkReasonOf(candidate),
    routingMode: authority.execution,
    currentAuthority: publicAuthority(authority),
    healthClass: healthClassOf(health),
    capabilityState: capabilityStateOf(candidate),
    backgroundEligible: background.eligible,
    backgroundReason: background.reason,
  })
}

/**
 * P3-C Host-owned product projection.
 *
 * The browser receives decisions, not credentials/endpoints/breaker internals.
 * Runtime authority is resolved from the live Host settings namespace and
 * evidence remains read-only. No field in this projection grants authority.
 */
export async function createVisionProductStateSnapshot({
  ctx,
  config,
  core,
  store,
  runtimePerformanceStore,
  healthForCandidate,
} = {}) {
  const current = activeSettings(ctx, config)
  const authority = resolveVisionRoutingAuthority(current)
  const evidence = await collectVisionRoutingEvidence({
    ctx,
    config: current,
    core,
    store,
    runtimePerformanceStore,
    healthForCandidate,
  })
  const candidates = evidence.candidates.map((candidate) =>
    projectVisionProductCandidate(candidate, evidence.health?.[candidate.key], authority))

  return Object.freeze({
    ok: true,
    routingMode: authority.execution,
    currentAuthority: publicAuthority(authority),
    candidates: Object.freeze(candidates),
  })
}
