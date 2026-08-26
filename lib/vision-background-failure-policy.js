export const BACKGROUND_AUTH_STOP_TTL_MS = 10 * 60 * 1000
export const BACKGROUND_ENDPOINT_STOP_TTL_MS = 6 * 60 * 60 * 1000
export const BACKGROUND_TRANSIENT_RETRY_MS = 30 * 60 * 1000

const DEFAULT_POLICY = Object.freeze({
  retryable: true,
  persist: false,
  retryAfterMs: undefined,
  ttlMs: undefined,
  credentialScoped: false,
})

const POLICIES = Object.freeze({
  auth: Object.freeze({
    retryable: false,
    persist: true,
    ttlMs: BACKGROUND_AUTH_STOP_TTL_MS,
    credentialScoped: true,
  }),
  protocol: Object.freeze({
    retryable: false,
    persist: true,
    ttlMs: BACKGROUND_ENDPOINT_STOP_TTL_MS,
    credentialScoped: false,
  }),
  unavailable: Object.freeze({
    retryable: false,
    persist: true,
    ttlMs: BACKGROUND_ENDPOINT_STOP_TTL_MS,
    credentialScoped: false,
  }),
  'unsupported-image': Object.freeze({
    retryable: false,
    persist: false,
    credentialScoped: false,
  }),
  'visual-proof': Object.freeze({
    retryable: true,
    persist: false,
    retryAfterMs: BACKGROUND_TRANSIENT_RETRY_MS,
    credentialScoped: false,
  }),
  infrastructure: Object.freeze({
    retryable: true,
    persist: false,
    retryAfterMs: BACKGROUND_TRANSIENT_RETRY_MS,
    credentialScoped: false,
  }),
})

/** Failure lifetime is separate from failure classification. */
export function backgroundFailurePolicy(errorClass) {
  return POLICIES[String(errorClass ?? '')] ?? DEFAULT_POLICY
}

function unresolvedFingerprint(value) {
  return typeof value !== 'string' || value === '' || value === 'unresolved'
}

/**
 * Credential transitions are intentionally asymmetric. Losing visibility of a
 * previously resolved credential is not proof that the account changed, so the
 * old stop remains conservative. Gaining a concrete fingerprint after an
 * unresolved state is observable recovery and must release the stale stop.
 */
export function credentialFingerprintChanged(stored, current) {
  if (unresolvedFingerprint(current)) return false
  if (unresolvedFingerprint(stored)) return true
  return stored !== current
}
