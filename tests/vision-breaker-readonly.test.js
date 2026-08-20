import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createVisionCircuitBreaker,
  VISION_FAILURE_KINDS,
} from '../lib/vision-resilience.js'

test('breaker peek does not clear auth state when a different credential would unblock execution', () => {
  const breaker = createVisionCircuitBreaker({ authTripTtlMs: 1000 })
  breaker.record('provider/model', 'old-key', { kind: VISION_FAILURE_KINDS.AUTH }, 'scope-a', 0)

  assert.deepEqual(breaker.peek('provider/model', 'new-key', 'scope-a', 100), { blocked: false })
  assert.deepEqual(breaker.inspect('provider/model', 'old-key', 'scope-a', 100), {
    blocked: true,
    reason: 'auth',
    until: 1000,
  })
})

test('breaker peek reports expired cooldown as healthy without pruning stored state', () => {
  const breaker = createVisionCircuitBreaker({ defaultRateCooldownMs: 100 })
  breaker.record('provider/model', 'anonymous', { kind: VISION_FAILURE_KINDS.RATE_LIMIT }, 'scope-a', 0)

  assert.equal(breaker.size(), 1)
  assert.deepEqual(breaker.peek('provider/model', 'anonymous', 'scope-a', 101), { blocked: false })
  assert.equal(breaker.size(), 1)

  assert.deepEqual(breaker.inspect('provider/model', 'anonymous', 'scope-a', 101), { blocked: false })
  assert.equal(breaker.size(), 0)
})

test('breaker peek does not refresh LRU order', () => {
  const breaker = createVisionCircuitBreaker({ authTripTtlMs: 1000, maxBackends: 2 })
  breaker.record('a/model', 'key-a', { kind: VISION_FAILURE_KINDS.AUTH }, 'scope-a', 0)
  breaker.record('b/model', 'key-b', { kind: VISION_FAILURE_KINDS.AUTH }, 'scope-b', 0)

  assert.equal(breaker.peek('a/model', 'key-a', 'scope-a', 100).blocked, true)
  breaker.record('c/model', 'key-c', { kind: VISION_FAILURE_KINDS.AUTH }, 'scope-c', 100)

  assert.deepEqual(breaker.inspect('a/model', 'key-a', 'scope-a', 100), { blocked: false })
  assert.equal(breaker.inspect('b/model', 'key-b', 'scope-b', 100).blocked, true)
  assert.equal(breaker.inspect('c/model', 'key-c', 'scope-c', 100).blocked, true)
})
