export const BACKGROUND_AUTH_STOP_TTL_MS = 10 * 60 * 1000
export const BACKGROUND_ENDPOINT_STOP_TTL_MS = 6 * 60 * 60 * 1000
export const BACKGROUND_TRANSIENT_RETRY_MS = 30 * 60 * 1000

export interface BackgroundFailurePolicy {
  readonly retryable: boolean
  readonly persist: boolean
  readonly retryAfterMs?: number | undefined
  readonly ttlMs?: number | undefined
}

const DEFAULT_POLICY: Readonly<BackgroundFailurePolicy> = Object.freeze({
  retryable: true,
  persist: false,
  retryAfterMs: undefined,
  ttlMs: undefined,
})

const POLICIES = Object.freeze({
  auth: Object.freeze({
    retryable: false,
    persist: false,
    ttlMs: BACKGROUND_AUTH_STOP_TTL_MS,
  }),
  protocol: Object.freeze({
    retryable: false,
    persist: true,
    ttlMs: BACKGROUND_ENDPOINT_STOP_TTL_MS,
  }),
  unavailable: Object.freeze({
    retryable: false,
    persist: true,
    ttlMs: BACKGROUND_ENDPOINT_STOP_TTL_MS,
  }),
  'unsupported-image': Object.freeze({
    retryable: false,
    persist: false,
  }),
  'visual-proof': Object.freeze({
    retryable: true,
    persist: false,
    retryAfterMs: BACKGROUND_TRANSIENT_RETRY_MS,
  }),
  infrastructure: Object.freeze({
    retryable: true,
    persist: false,
    retryAfterMs: BACKGROUND_TRANSIENT_RETRY_MS,
  }),
} satisfies Readonly<Record<string, Readonly<BackgroundFailurePolicy>>>)

export type BackgroundFailureClass = keyof typeof POLICIES

/** Failure lifetime is separate from failure classification. */
export function backgroundFailurePolicy(
  errorClass: unknown,
): Readonly<BackgroundFailurePolicy> {
  const key = String(errorClass ?? '')
  return Object.prototype.hasOwnProperty.call(POLICIES, key)
    ? POLICIES[key as BackgroundFailureClass]
    : DEFAULT_POLICY
}
