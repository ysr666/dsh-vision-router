import { createHash } from 'node:crypto'

function turnNumberOf(session) {
  try {
    const events = session?.events
    if (!Array.isArray(events)) return 0
    const last = events.findLast((event) => event && event.type === 'turn/start')
    return last && Number.isInteger(last.data?.turn) ? last.data.turn : 0
  } catch {
    return 0
  }
}

function sessionIdOf(session) {
  try {
    return session?.id !== undefined ? String(session.id) : 'anon'
  } catch {
    return 'anon'
  }
}

export function visionBreakerScopeOf(session) {
  return `${sessionIdOf(session)}:${turnNumberOf(session)}`
}

function credentialFingerprintOf(value) {
  if (value === undefined) return 'unresolved'
  const text = String(value ?? '')
  if (text === '') return 'anonymous'
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

async function resolveCredential(ctx, ref) {
  if (typeof ref !== 'string' || ref === '') return undefined
  try {
    const credentials = ctx?.get?.('credentials')
    if (credentials && typeof credentials.resolve === 'function') {
      return (await credentials.resolve(ref))?.value
    }
  } catch {
    // Match v1's fail-closed credential fingerprint behavior.
  }
  return undefined
}

export async function visionBreakerFingerprintForCandidate(ctx, candidate) {
  const ref = candidate?.endpointCredentialRef
  if (typeof ref === 'string' && ref !== '') {
    return credentialFingerprintOf(await resolveCredential(ctx, ref))
  }
  // v1's direct HTTP fallback treats a credential-less endpoint as anonymous.
  // Native/provider and vision-http chain pairs without a resolvable channel
  // credential use the conservative unresolved fingerprint instead.
  return String(candidate?.key ?? '').startsWith('http:') ? 'anonymous' : 'unresolved'
}

function healthFromGate(gate) {
  if (!gate || gate.blocked !== true) return { circuitOpen: false }
  if (gate.reason === 'rate-limit') {
    return {
      circuitOpen: true,
      rateLimited: true,
      reason: gate.reason,
      ...(Number.isFinite(Number(gate.until)) ? { until: Number(gate.until) } : {}),
    }
  }
  return {
    circuitOpen: true,
    reason: gate.reason,
    ...(Number.isFinite(Number(gate.until)) ? { until: Number(gate.until) } : {}),
  }
}

/**
 * Bridge the private v1 breaker instance into the v2 shadow scorer without
 * giving shadow code mutation authority. `capture()` is called only while
 * core.apply() constructs the breaker; `healthForCandidate()` uses peek().
 */
export function createVisionBreakerShadowHealth(ctx) {
  let breaker
  return {
    capture(value) {
      if (value && typeof value.peek === 'function') breaker = value
    },

    async healthForCandidate(candidate, context = {}) {
      if (!breaker || typeof breaker.peek !== 'function') return undefined
      const key = typeof candidate?.key === 'string' ? candidate.key : undefined
      if (!key) return undefined
      const fingerprint = await visionBreakerFingerprintForCandidate(ctx, candidate)
      const scope = visionBreakerScopeOf(context.session)
      return healthFromGate(breaker.peek(key, fingerprint, scope))
    },

    ready() {
      return breaker !== undefined
    },
  }
}
