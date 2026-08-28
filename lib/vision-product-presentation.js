export const VISION_PRESENTATION_DTO_REVISION = 2

const PRESENTATION_AXES = Object.freeze(['structured', 'ocr', 'document', 'grounding', 'general'])

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

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function routeIdentity(entry) {
  const name = nonEmpty(entry?.name)
  const model = nonEmpty(entry?.model)
  return name && model ? `${name}/${model}` : undefined
}

function normalizedEndpoint(value) {
  return String(value ?? '').trim().replace(/\/+$/, '').toLowerCase()
}

function trustedBuiltinFree(candidate, core) {
  if (!candidate || candidate.provider !== 'vision-http' || candidate.local === true) return false
  const modelIdentity = nonEmpty(candidate.model)
  if (!modelIdentity || !candidate.endpoint) return false
  const builtins = Array.isArray(core?.DEFAULT_HTTP_PROVIDERS) ? core.DEFAULT_HTTP_PROVIDERS : []
  return builtins.some((entry) =>
    routeIdentity(entry) === modelIdentity &&
    normalizedEndpoint(entry?.baseURL) === normalizedEndpoint(candidate.endpoint) &&
    !nonEmpty(entry?.apiKeyEnv))
}

function schedulerEligibilityOf(candidate, background, core) {
  if (!background?.active) return { eligible: false, reason: 'background-measurement-not-active' }
  if (!candidate || candidate.benchmarkable !== true) {
    return { eligible: false, reason: 'benchmark-unavailable' }
  }
  if (candidate.routeRole === 'fallback-only') {
    return { eligible: false, reason: 'fallback-only-route' }
  }
  if (background.mode === 'all') return { eligible: true, reason: null }
  if (background.mode !== 'local-free') {
    return { eligible: false, reason: 'background-measurement-off' }
  }
  return candidate.local === true || trustedBuiltinFree(candidate, core)
    ? { eligible: true, reason: null }
    : { eligible: false, reason: 'local-free-policy-excludes-route' }
}

function coverageOf(measured) {
  if (!measured || typeof measured !== 'object') return []
  if (Array.isArray(measured.measuredAxes)) {
    return PRESENTATION_AXES.filter((axis) => measured.measuredAxes.includes(axis))
  }
  if (Array.isArray(measured.coverage)) {
    return PRESENTATION_AXES.filter((axis) => measured.coverage.includes(axis))
  }
  const scores = measured.scores && typeof measured.scores === 'object' ? measured.scores : {}
  return PRESENTATION_AXES.filter((axis) => Number.isFinite(Number(scores[axis])))
}

function itemForKey(rows, key) {
  return Array.isArray(rows) ? rows.find((item) => item?.key === key) : undefined
}

function frozenRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.freeze({ ...value })
}

export function publicVisionAuthority(authority) {
  return Object.freeze({
    execution: authority?.execution,
    autoSelectionAuthorized: authority?.autoSelectionAuthorized,
    backgroundMeasurement: authority?.backgroundMeasurement,
    backgroundMeasurementAuthorized: authority?.backgroundMeasurementAuthorized,
    backgroundMeasurementActive: authority?.backgroundMeasurementActive,
  })
}

/**
 * Exact public shape historically served by the capability-runtime GET route.
 * Keeping this as a pure Host projection lets benchmark snapshots carry the
 * same state before the browser stops polling the compatibility route.
 */
export function projectVisionBackgroundRuntime(state, authority) {
  const source = state && typeof state === 'object' ? state : {}
  const deferred = Array.isArray(source.deferred)
    ? Object.freeze(source.deferred.map((item) => frozenRecord(item)))
    : Object.freeze([])
  const excluded = Array.isArray(source.excluded)
    ? Object.freeze(source.excluded.map((item) => frozenRecord(item)))
    : Object.freeze([])
  return Object.freeze({
    mode: authority?.backgroundMeasurement,
    active: authority?.backgroundMeasurementActive,
    paused: Number(source.activeForeground) > 0 || Number(source.activeManualBenchmarks) > 0,
    idleRemainingMs: source.idleRemainingMs,
    running: source.running ? frozenRecord(source.running) : null,
    deferred,
    excluded,
  })
}

/**
 * Scheduler-aware candidate state used by the capability UI. This is separate
 * from the compatibility `backgroundEligible` field above: the latter keeps
 * the existing /product-state meaning while this state mirrors real unattended
 * scheduler rules, including fallback-only routes and trusted built-in free
 * endpoints.
 */
export function projectVisionCandidateBackground(candidate, background, core) {
  if (!background || typeof background !== 'object') return undefined
  const key = String(candidate?.key ?? '')
  const running = background.running?.key === key ? background.running : undefined
  if (running) {
    return Object.freeze({
      state: 'running',
      reason: null,
      policyEligible: true,
      needsWork: true,
      workEligible: true,
      running: frozenRecord(running),
    })
  }

  const excluded = itemForKey(background.excluded, key)
  if (excluded?.reason === 'measured-text-only') {
    return Object.freeze({
      state: 'measured-text-only',
      reason: excluded.reason,
      policyEligible: false,
      needsWork: false,
      workEligible: false,
    })
  }

  const deferred = itemForKey(background.deferred, key)
  if (deferred) {
    return Object.freeze({
      state: deferred.retryable === true ? 'deferred' : 'stopped',
      reason: deferred.errorClass ?? 'provider',
      policyEligible: false,
      needsWork: true,
      workEligible: false,
      deferred: frozenRecord(deferred),
    })
  }

  const eligibility = schedulerEligibilityOf(candidate, background, core)
  const needsWork = coverageOf(candidate?.measured).length < PRESENTATION_AXES.length
  const workEligible = eligibility.eligible && !excluded && needsWork

  if (candidate?.measured) {
    return Object.freeze({
      state: workEligible ? 'measured-waiting' : 'measured',
      reason: workEligible ? null : eligibility.reason,
      policyEligible: eligibility.eligible,
      needsWork,
      workEligible,
    })
  }

  if (workEligible) {
    const state = background.paused === true
      ? 'paused'
      : candidate?.imageCapability === 'text-only'
        ? 'awaiting-verification'
        : 'waiting'
    return Object.freeze({
      state,
      reason: null,
      policyEligible: true,
      needsWork: true,
      workEligible: true,
    })
  }

  if (candidate?.imageCapability === 'text-only') {
    return Object.freeze({
      state: 'declared-text-only',
      reason: eligibility.reason,
      policyEligible: eligibility.eligible,
      needsWork,
      workEligible: false,
    })
  }

  if (candidate?.benchmarkable !== true) {
    return Object.freeze({
      state: 'unavailable',
      reason: 'benchmark-unavailable',
      policyEligible: false,
      needsWork,
      workEligible: false,
    })
  }

  if (background.active === true && background.mode === 'local-free') {
    return Object.freeze({
      state: 'policy-excluded',
      reason: eligibility.reason,
      policyEligible: false,
      needsWork,
      workEligible: false,
    })
  }

  return Object.freeze({
    state: 'not-measured',
    reason: eligibility.reason,
    policyEligible: eligibility.eligible,
    needsWork,
    workEligible: false,
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
export function projectVisionProductCandidate(candidate, health, authority, options = {}) {
  const background = backgroundEligibilityOf(candidate, authority)
  const runtimeBackground = options.background
    ? projectVisionCandidateBackground(candidate, options.background, options.core)
    : undefined
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
    ...(runtimeBackground ? { background: runtimeBackground } : {}),
  })
}
