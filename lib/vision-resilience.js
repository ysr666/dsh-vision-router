import { publishVisionCircuitBreaker } from './vision-breaker-observer.js'

// Vision failure resilience: the unified mechanism that stops one broken
// vision backend from turning a normal text conversation into minutes of
// repeated vision tool calls.
//
//   1. classifyVisionFailure  — one structured taxonomy for every backend
//      failure (AUTH / RATE_LIMIT / TIMEOUT / SERVER / INVALID_REQUEST /
//      NETWORK / QUOTA / REGION / TOS / NO_ADAPTER / OTHER), each with a
//      provider-retry verdict.
//   2. createDeadline        — one shared time budget per vision task; every
//      provider, fallback, retry and OCR stage draws from the SAME remaining
//      budget instead of restarting its own timeout.
//   3. createVisionCircuitBreaker — per-backend circuit state: AUTH trips the
//      backend until its credential fingerprint changes (or a TTL passes);
//      RATE_LIMIT and QUOTA have distinct cooldown lifetimes so account/key
//      changes cannot accidentally release an unrelated rate-limit window.
//   4. createVisionTurnMemory — per session+turn failure memory: once every
//      backend is known to have failed this turn, later vision calls answer
//      immediately with VISION_BACKEND_UNAVAILABLE_THIS_TURN without any
//      network attempt.
//   5. buildVisionFailure     — the structured, agent-visible result that
//      tells the model this is NOT a "rephrase the question" problem.

/** Machine-routable vision failure classes. */
export const VISION_FAILURE_KINDS = {
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  TIMEOUT: 'TIMEOUT',
  SERVER: 'SERVER',
  INVALID_REQUEST: 'INVALID_REQUEST',
  NETWORK: 'NETWORK',
  QUOTA: 'QUOTA',
  REGION: 'REGION',
  TOS: 'TOS',
  NO_ADAPTER: 'NO_ADAPTER',
  REPETITION: 'REPETITION',
  OTHER: 'OTHER',
}

/** Result codes handed back to the agent in structured tool results. */
export const VISION_RESULT_CODES = {
  AUTH_FAILED: 'VISION_AUTH_FAILED',
  RATE_LIMITED: 'VISION_RATE_LIMITED',
  TIMEOUT: 'VISION_TIMEOUT',
  BACKEND_UNAVAILABLE: 'VISION_BACKEND_UNAVAILABLE',
  BACKEND_UNAVAILABLE_THIS_TURN: 'VISION_BACKEND_UNAVAILABLE_THIS_TURN',
  UNSUPPORTED_BACKEND: 'VISION_UNSUPPORTED_BACKEND',
}

export const VISION_DO_NOT_RETRY_ADVICE =
  'Vision backends are unavailable for this turn (auth failure, rate limit, timeout or outage). ' +
  'Do NOT call vision_describe / vision_ground / vision_detect / vision_ocr again this turn with a ' +
  'reworded question — rephrasing cannot fix an auth, rate-limit or infrastructure failure. ' +
  'Answer from the information you already have and continue the text task; tell the user vision is temporarily unavailable.'

/** Ensure a user-visible failure sentence ends with exactly one terminal mark. */
export function ensureSentencePunctuation(value) {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  return /[.!?。！？]$/.test(text) ? text : `${text}.`
}

const AUTH_PATTERNS = [/\b401\b/, /\b403\b/, /unauthorized/i, /invalid api[ -]?key/i, /forbidden/i, /authentication/i, /check the api key/i]
const RATE_LIMIT_PATTERNS = [/\b429\b/, /rate.?limit/i, /quota temporarily/i, /too many requests/i]
const TIMEOUT_PATTERNS = [/abort/i, /timeout/i, /etimedout/i, /timed ?out/i, /deadline exceeded/i]
const SERVER_PATTERNS = [/\b500\b/, /\b502\b/, /\b503\b/, /\b504\b/, /bad gateway/i, /service unavailable/i]
const INVALID_REQUEST_PATTERNS = [/\b400\b/, /\b404\b/, /\b422\b/, /invalid request/i, /does not support image/i, /unsupported/i, /invalid model/i, /no such model/i, /model not exist/i]
const NETWORK_PATTERNS = [/econn/i, /enotfound/i, /network/i, /fetch failed/i, /socket/i, /connection reset/i, /dns/i]
const QUOTA_PATTERNS = [/\b402\b/, /insufficient/i, /balance/i, /credits/i]
const REGION_PATTERNS = [/not available in your region/i, /prohibited region/i, /\bregion\b/i]
const TOS_PATTERNS = [/terms of service/i, /\btos\b/i]
const NO_ADAPTER_PATTERNS = [/no adapter registered/i, /is not registered/i, /no adapter for provider/i]
const REPETITION_PATTERNS = [/repetition loop/i]

/** Map an already-branded error code (LlmError-style) to a failure kind. */
const CODE_KIND_MAP = {
  AUTH: VISION_FAILURE_KINDS.AUTH,
  RATE_LIMIT: VISION_FAILURE_KINDS.RATE_LIMIT,
  TIMEOUT: VISION_FAILURE_KINDS.TIMEOUT,
  TRANSPORT: VISION_FAILURE_KINDS.NETWORK,
  SERVER: VISION_FAILURE_KINDS.SERVER,
  EMPTY_RESPONSE: VISION_FAILURE_KINDS.SERVER,
  INVALID_REQUEST: VISION_FAILURE_KINDS.INVALID_REQUEST,
  NO_ADAPTER: VISION_FAILURE_KINDS.NO_ADAPTER,
}

const KIND_BY_PATTERN = [
  [VISION_FAILURE_KINDS.AUTH, AUTH_PATTERNS],
  [VISION_FAILURE_KINDS.RATE_LIMIT, RATE_LIMIT_PATTERNS],
  [VISION_FAILURE_KINDS.TIMEOUT, TIMEOUT_PATTERNS],
  [VISION_FAILURE_KINDS.SERVER, SERVER_PATTERNS],
  [VISION_FAILURE_KINDS.INVALID_REQUEST, INVALID_REQUEST_PATTERNS],
  [VISION_FAILURE_KINDS.NETWORK, NETWORK_PATTERNS],
  [VISION_FAILURE_KINDS.QUOTA, QUOTA_PATTERNS],
  [VISION_FAILURE_KINDS.REGION, REGION_PATTERNS],
  [VISION_FAILURE_KINDS.TOS, TOS_PATTERNS],
  [VISION_FAILURE_KINDS.NO_ADAPTER, NO_ADAPTER_PATTERNS],
  [VISION_FAILURE_KINDS.REPETITION, REPETITION_PATTERNS],
]

/** Status → kind for HTTP-level failures. */
export function kindForHttpStatus(status) {
  if (status === 401 || status === 403) return VISION_FAILURE_KINDS.AUTH
  if (status === 429) return VISION_FAILURE_KINDS.RATE_LIMIT
  if (status === 402) return VISION_FAILURE_KINDS.QUOTA
  if (status === 400 || status === 404 || status === 422) return VISION_FAILURE_KINDS.INVALID_REQUEST
  if (status >= 500 && status <= 599) return VISION_FAILURE_KINDS.SERVER
  return undefined
}

/**
 * Classify a backend failure into the shared taxonomy plus a provider-retry
 * verdict. Deterministic failures (AUTH / INVALID_REQUEST / REGION / TOS)
 * mean the same backend must not be retried as-is; RATE_LIMIT carries a
 * cooldown; TIMEOUT / SERVER / NETWORK allow trying the NEXT backend while
 * the task deadline still has budget.
 */
export function classifyVisionFailure(error) {
  const message = String((error && error.message) ?? error ?? '')
  let kind = CODE_KIND_MAP[(error && error.code) ?? ''] ?? kindForHttpStatus(error && error.status)
  if (kind === undefined) {
    for (const [candidate, patterns] of KIND_BY_PATTERN) {
      if (patterns.some((pattern) => pattern.test(message))) {
        kind = candidate
        break
      }
    }
    if (kind === undefined) kind = VISION_FAILURE_KINDS.OTHER
  }
  const retryAfterMs =
    Number.isFinite(error && error.providerRetryAfterMs) && error.providerRetryAfterMs > 0
      ? error.providerRetryAfterMs
      : undefined
  const retryable = kind === VISION_FAILURE_KINDS.TIMEOUT ||
    kind === VISION_FAILURE_KINDS.SERVER ||
    kind === VISION_FAILURE_KINDS.NETWORK
  return {
    kind,
    // Whether the SAME backend may be retried as-is (not "may the next backend run").
    retryableProvider: retryable,
    retryAfterMs,
    status: Number.isInteger(error && error.status) ? error.status : undefined,
  }
}

/**
 * Shared deadline for one vision task: a single wall-clock budget that every
 * provider attempt, fallback and OCR stage draws from. Returns a signal that
 * aborts when the budget is spent, so chained backends can never multiply the
 * total wait.
 */
export function createDeadline(totalMs) {
  const total = Math.max(0, Number(totalMs) || 0)
  const started = Date.now()
  return {
    started,
    total,
    remaining() {
      return Math.max(0, total - (Date.now() - started))
    },
    expired() {
      return Date.now() - started >= total
    },
    /** An AbortSignal that fires exactly when the remaining budget is spent. */
    signal() {
      return AbortSignal.timeout(Math.max(0, total - (Date.now() - started)))
    },
  }
}

/** Combine several abort signals (exec signal, deadline, per-request cap). */
export function combineSignals(...signals) {
  const list = signals.filter((signal) => signal !== undefined && signal !== null)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  return AbortSignal.any(list)
}

/**
 * Per-backend circuit breaker.
 *
 * - AUTH / REGION / TOS trips the backend until its credential fingerprint
 *   changes (a fresh key unblocks it) or the auth TTL passes.
 * - RATE_LIMIT applies a credential-independent Retry-After cooldown.
 * - QUOTA applies a longer credential-scoped cooldown: a new key/account can
 *   recover immediately, while an unchanged depleted account stays blocked
 *   across turns instead of paying one doomed request per turn.
 * - INVALID_REQUEST / NO_ADAPTER trips the backend only for the current turn.
 */
export function createVisionCircuitBreaker({
  now = Date.now,
  authTripTtlMs = 10 * 60 * 1000,
  defaultRateCooldownMs = 60 * 1000,
  defaultQuotaCooldownMs = 10 * 60 * 1000,
  maxBackends = 128,
} = {}) {
  const backends = new Map()
  const backendLimit = Math.max(1, Math.floor(Number(maxBackends) || 128))

  const credentialUnknown = (value) =>
    value === undefined || value === null || value === '' || value === 'unresolved'

  // Credential comparison is intentionally asymmetric. If the credential is
  // currently unresolved, keep the old stop conservatively. If it was
  // unresolved before but is now observable, that is a real recovery event and
  // the old AUTH/QUOTA stop must not block the newly resolved credential.
  const sameCredential = (stored, current) =>
    stored === current || credentialUnknown(current)

  const clearRateCooldown = (hit) => {
    delete hit.rateCooldownUntil
  }
  const clearQuotaCooldown = (hit) => {
    delete hit.quotaCooldownUntil
    delete hit.quotaFingerprint
  }

  const touch = (key, hit) => {
    backends.delete(key)
    backends.set(key, hit)
    while (backends.size > backendLimit) {
      const oldest = backends.keys().next().value
      if (oldest === undefined) break
      backends.delete(oldest)
    }
  }
  const entry = (key) => {
    let hit = backends.get(key)
    if (hit === undefined) hit = {}
    touch(key, hit)
    return hit
  }
  const empty = (hit) =>
    hit.authAt === undefined &&
    hit.authFingerprint === undefined &&
    hit.rateCooldownUntil === undefined &&
    hit.quotaCooldownUntil === undefined &&
    hit.quotaFingerprint === undefined &&
    hit.turnScope === undefined
  const blockedState = (hit, fingerprint, scope, at) => {
    if (hit === undefined) return { blocked: false }
    if (hit.rateCooldownUntil !== undefined && hit.rateCooldownUntil > at) {
      return { blocked: true, reason: 'rate-limit', until: hit.rateCooldownUntil }
    }
    if (
      hit.quotaCooldownUntil !== undefined &&
      hit.quotaCooldownUntil > at &&
      sameCredential(hit.quotaFingerprint, fingerprint)
    ) {
      return { blocked: true, reason: 'quota', until: hit.quotaCooldownUntil }
    }
    if (hit.authAt !== undefined) {
      const ttlActive = at - hit.authAt < authTripTtlMs
      if (ttlActive && sameCredential(hit.authFingerprint, fingerprint)) {
        return { blocked: true, reason: 'auth', until: hit.authAt + authTripTtlMs }
      }
    }
    if (hit.turnScope !== undefined && hit.turnScope === scope) {
      return { blocked: true, reason: 'turn' }
    }
    return { blocked: false }
  }

  return publishVisionCircuitBreaker({
    /**
     * Observe breaker health without changing cleanup or LRU state. Shadow
     * routing uses this path so merely measuring a recommendation can never
     * make v1 retry sooner/later or change which breaker entry is evicted.
     */
    peek(key, fingerprint, scope, at = now()) {
      return blockedState(backends.get(key), fingerprint, scope, at)
    },

    inspect(key, fingerprint, scope, at = now()) {
      const hit = backends.get(key)
      if (hit === undefined) return { blocked: false }

      if (hit.rateCooldownUntil !== undefined) {
        if (hit.rateCooldownUntil > at) {
          touch(key, hit)
          return { blocked: true, reason: 'rate-limit', until: hit.rateCooldownUntil }
        }
        clearRateCooldown(hit)
      }
      if (hit.quotaCooldownUntil !== undefined) {
        const sameQuotaCredential = sameCredential(hit.quotaFingerprint, fingerprint)
        if (hit.quotaCooldownUntil > at && sameQuotaCredential) {
          touch(key, hit)
          return { blocked: true, reason: 'quota', until: hit.quotaCooldownUntil }
        }
        // Expired quota windows and observable credential rotations both make
        // the old account-scoped stop stale immediately.
        clearQuotaCooldown(hit)
      }
      if (hit.authAt !== undefined) {
        const ttlActive = at - hit.authAt < authTripTtlMs
        if (ttlActive && sameCredential(hit.authFingerprint, fingerprint)) {
          touch(key, hit)
          return { blocked: true, reason: 'auth', until: hit.authAt + authTripTtlMs }
        }
        delete hit.authAt
        delete hit.authFingerprint
      }
      if (hit.turnScope !== undefined) {
        if (hit.turnScope === scope) {
          touch(key, hit)
          return { blocked: true, reason: 'turn' }
        }
        // A turn-scoped deterministic failure has no meaning once another
        // scope inspects the backend; prune it instead of retaining a tombstone.
        delete hit.turnScope
      }
      if (empty(hit)) backends.delete(key)
      else touch(key, hit)
      return { blocked: false }
    },

    record(key, fingerprint, classification, scope, at = now()) {
      const kind = classification?.kind
      const retryAfterMs = classification?.retryAfterMs
      let hit
      switch (kind) {
        case VISION_FAILURE_KINDS.AUTH:
        case VISION_FAILURE_KINDS.REGION:
        case VISION_FAILURE_KINDS.TOS:
          hit = entry(key)
          hit.authAt = at
          hit.authFingerprint = fingerprint
          break
        case VISION_FAILURE_KINDS.RATE_LIMIT: {
          hit = entry(key)
          const cooldown = retryAfterMs !== undefined ? retryAfterMs : defaultRateCooldownMs
          hit.rateCooldownUntil = Math.max(hit.rateCooldownUntil ?? 0, at + cooldown)
          break
        }
        case VISION_FAILURE_KINDS.QUOTA: {
          hit = entry(key)
          if (!sameCredential(hit.quotaFingerprint, fingerprint)) clearQuotaCooldown(hit)
          const cooldown = retryAfterMs !== undefined ? retryAfterMs : defaultQuotaCooldownMs
          hit.quotaCooldownUntil = Math.max(hit.quotaCooldownUntil ?? 0, at + cooldown)
          hit.quotaFingerprint = fingerprint
          break
        }
        case VISION_FAILURE_KINDS.INVALID_REQUEST:
        case VISION_FAILURE_KINDS.NO_ADAPTER:
          hit = entry(key)
          hit.turnScope = scope
          break
        default:
          return
      }
      touch(key, hit)
    },

    clear(key) {
      backends.delete(key)
    },

    reset() {
      backends.clear()
    },

    size() {
      return backends.size
    },
  })
}

/**
 * Turn-level failure memory. Scope = `${sessionId}:${turn}`; once a scope is
 * marked allFailed, later vision tasks on the same turn answer instantly
 * without touching the network.
 */
export function createVisionTurnMemory({
  maxScopes = 64,
  maxSessions = maxScopes,
  maxAttemptsPerScope = 64,
} = {}) {
  const scopes = new Map() // scope -> { failedKinds:Set, attempted: [], allFailed:false }
  const lastScopeBySession = new Map() // bounded LRU sessionId -> scope
  const scopeLimit = Math.max(1, Math.floor(Number(maxScopes) || 64))
  const sessionLimit = Math.max(1, Math.floor(Number(maxSessions) || scopeLimit))
  const attemptLimit = Math.max(1, Math.floor(Number(maxAttemptsPerScope) || 64))

  const dropScope = (scope) => {
    scopes.delete(scope)
    for (const [sessionId, tracked] of lastScopeBySession) {
      if (tracked === scope) lastScopeBySession.delete(sessionId)
    }
  }
  const pruneScopes = () => {
    while (scopes.size > scopeLimit) {
      const oldest = scopes.keys().next().value
      if (oldest === undefined) break
      dropScope(oldest)
    }
  }
  const touchSession = (sessionId, scope) => {
    lastScopeBySession.delete(sessionId)
    lastScopeBySession.set(sessionId, scope)
    while (lastScopeBySession.size > sessionLimit) {
      const oldest = lastScopeBySession.keys().next().value
      if (oldest === undefined) break
      const tracked = lastScopeBySession.get(oldest)
      lastScopeBySession.delete(oldest)
      if (tracked !== undefined) scopes.delete(tracked)
    }
  }
  const entry = (scope) => {
    let hit = scopes.get(scope)
    if (hit === undefined) {
      hit = { failedKinds: new Set(), attempted: [], allFailed: false }
      scopes.set(scope, hit)
      pruneScopes()
    } else {
      scopes.delete(scope)
      scopes.set(scope, hit)
    }
    return hit
  }

  return {
    bindSession(sessionId, scope) {
      const previous = lastScopeBySession.get(sessionId)
      if (previous !== undefined && previous !== scope) dropScope(previous)
      touchSession(sessionId, scope)
    },

    allFailed(scope) {
      const hit = scopes.get(scope)
      return hit !== undefined && hit.allFailed
    },

    record(scope, backendId, kind) {
      const hit = entry(scope)
      hit.failedKinds.add(kind)
      if (hit.attempted.length >= attemptLimit) hit.attempted.shift()
      hit.attempted.push({ backend: backendId, kind })
    },

    markAllFailed(scope) {
      entry(scope).allFailed = true
    },

    failedKinds(scope) {
      const hit = scopes.get(scope)
      return hit === undefined ? [] : [...hit.failedKinds]
    },

    attempted(scope) {
      const hit = scopes.get(scope)
      return hit === undefined ? [] : [...hit.attempted]
    },

    stats() {
      return { scopes: scopes.size, sessions: lastScopeBySession.size }
    },

    reset() {
      scopes.clear()
      lastScopeBySession.clear()
    },
  }
}

/**
 * Build the structured, agent-visible failure result. `retryable: false` is
 * the signal the model must respect: no amount of prompt rewriting fixes an
 * auth / rate-limit / backend outage.
 */
export function buildVisionFailure({
  code,
  retryable = false,
  reason,
  attempted = [],
  advice = VISION_DO_NOT_RETRY_ADVICE,
}) {
  return {
    ok: false,
    code,
    retryable,
    reason: reason ?? VISION_DO_NOT_RETRY_ADVICE,
    attemptedProviders: attempted,
    advice,
  }
}

/** Pick the result code that best explains a set of per-backend failure kinds. */
export function resultCodeForKinds(kinds) {
  const set = new Set(kinds)
  if (set.size === 1) {
    const only = [...set][0]
    if (only === VISION_FAILURE_KINDS.AUTH) return VISION_RESULT_CODES.AUTH_FAILED
    if (only === VISION_FAILURE_KINDS.RATE_LIMIT) return VISION_RESULT_CODES.RATE_LIMITED
    if (only === VISION_FAILURE_KINDS.TIMEOUT) return VISION_RESULT_CODES.TIMEOUT
  }
  return VISION_RESULT_CODES.BACKEND_UNAVAILABLE
}

/**
 * Qwen Token Plan diagnosis aid (no provider hardcode): Token Plan keys are
 * `sk-sp-…` and only work against the dedicated Token Plan endpoint; a
 * standard `sk-…` key only works against the standard endpoint. Mixing them
 * is the #1 cause of "Invalid API-key provided" 401s. When the plugin itself
 * holds the key, append a targeted hint so the user can fix it without
 * guessing.
 */
export function qwenKeyEndpointHint(baseURL, apiKey) {
  const key = String(apiKey ?? '').trim()
  const host = (() => {
    try {
      return new URL(String(baseURL ?? '')).hostname.toLowerCase()
    } catch {
      return ''
    }
  })()
  if (key.startsWith('sk-sp-') && !host.includes('token-plan')) {
    return (
      ' (hint: this key starts with sk-sp-, a Qwen Token Plan key — Token Plan keys only work ' +
      'against the dedicated Token Plan base URL, not the standard DashScope endpoint; ' +
      'pair the key with its matching endpoint)'
    )
  }
  if (key.startsWith('sk-') && !key.startsWith('sk-sp-') && host.includes('token-plan')) {
    return (
      ' (hint: this endpoint is the Qwen Token Plan endpoint but the key is a standard sk- key — ' +
      'standard keys and Token Plan keys/endpoints must not be mixed)'
    )
  }
  return ''
}
