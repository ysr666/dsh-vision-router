import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createVisionCircuitBreaker,
  VISION_FAILURE_KINDS,
} from '../lib/vision-resilience.js'

test('QUOTA cooldown crosses turns, rotates with credentials, and expires', () => {
  let now = 1_000
  const breaker = createVisionCircuitBreaker({
    now: () => now,
    defaultQuotaCooldownMs: 10_000,
  })

  breaker.record('p/m', 'cred-old', { kind: VISION_FAILURE_KINDS.QUOTA }, 's1:1')
  assert.deepEqual(
    breaker.inspect('p/m', 'cred-old', 's1:1'),
    { blocked: true, reason: 'quota', until: 11_000 },
  )
  assert.deepEqual(
    breaker.inspect('p/m', 'cred-old', 's1:2'),
    { blocked: true, reason: 'quota', until: 11_000 },
    'quota exhaustion must not retry once per new turn',
  )

  assert.deepEqual(
    breaker.inspect('p/m', 'cred-new', 's1:2'),
    { blocked: false },
    'an observable credential rotation must release only the old quota stop',
  )

  breaker.record('p/m', 'cred-new', { kind: VISION_FAILURE_KINDS.QUOTA }, 's1:2')
  now = 11_001
  assert.deepEqual(breaker.inspect('p/m', 'cred-new', 's1:3'), { blocked: false })
})

test('newly resolved credentials release stale AUTH and QUOTA stops immediately', () => {
  const auth = createVisionCircuitBreaker({ authTripTtlMs: 10_000 })
  auth.record('auth/model', 'unresolved', { kind: VISION_FAILURE_KINDS.AUTH }, 's1:1', 1_000)
  assert.equal(auth.inspect('auth/model', 'unresolved', 's1:1', 1_001).reason, 'auth')
  assert.deepEqual(
    auth.inspect('auth/model', 'cred-new', 's1:1', 1_002),
    { blocked: false },
    'unresolved -> resolved must be treated as an observable recovery event',
  )

  const quota = createVisionCircuitBreaker({ defaultQuotaCooldownMs: 10_000 })
  quota.record('quota/model', 'unresolved', { kind: VISION_FAILURE_KINDS.QUOTA }, 's1:1', 1_000)
  assert.equal(quota.inspect('quota/model', 'unresolved', 's1:2', 1_001).reason, 'quota')
  assert.deepEqual(
    quota.inspect('quota/model', 'cred-new', 's1:2', 1_002),
    { blocked: false },
  )
})

test('temporary loss of credential visibility does not release an existing stop', () => {
  const breaker = createVisionCircuitBreaker({ authTripTtlMs: 10_000 })
  breaker.record('p/m', 'cred-a', { kind: VISION_FAILURE_KINDS.AUTH }, 's1:1', 1_000)
  assert.deepEqual(
    breaker.inspect('p/m', 'unresolved', 's1:2', 1_001),
    { blocked: true, reason: 'auth', until: 11_000 },
    'resolved -> unresolved must stay conservative until the credential is observable again',
  )
})

test('RATE_LIMIT remains credential-independent while QUOTA is credential-scoped', () => {
  let now = 0
  const breaker = createVisionCircuitBreaker({
    now: () => now,
    defaultRateCooldownMs: 5_000,
    defaultQuotaCooldownMs: 10_000,
  })

  breaker.record('p/m', 'cred-a', { kind: VISION_FAILURE_KINDS.RATE_LIMIT }, 's1:1')
  assert.deepEqual(
    breaker.inspect('p/m', 'cred-b', 's1:2'),
    { blocked: true, reason: 'rate-limit', until: 5_000 },
    'changing keys must not bypass a provider-wide 429 window',
  )
  now = 5_001
  assert.deepEqual(breaker.inspect('p/m', 'cred-b', 's1:2'), { blocked: false })
})

test('deterministic turn failures stay turn-scoped and unhandled kinds do not create breaker state', () => {
  const breaker = createVisionCircuitBreaker()
  breaker.record('p/m', 'cred', { kind: VISION_FAILURE_KINDS.INVALID_REQUEST }, 's1:1')
  assert.equal(breaker.inspect('p/m', 'cred', 's1:1').reason, 'turn')
  assert.deepEqual(breaker.inspect('p/m', 'cred', 's1:2'), { blocked: false })

  const empty = createVisionCircuitBreaker()
  empty.record('p/m', 'cred', { kind: VISION_FAILURE_KINDS.SERVER }, 's1:1')
  empty.record('p/m', 'cred', { kind: 'FUTURE_KIND' }, 's1:1')
  assert.equal(empty.size(), 0, 'new/unhandled failure kinds must not silently inherit turn-scope semantics')
})
