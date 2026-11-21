import test from 'node:test'
import assert from 'node:assert/strict'
import { compareCacheAB, formatCacheAB } from '../scripts/issue-865-cache-ab-report.mjs'
const one = (variant, args = {}) => ({
  case: 'sameCase', trial: 1, variant, call: 'main', routeTag: 'accountOne',
  modelTag: 'modelOne', usageSource: 'provider-response',
  inputTokens: 10, cacheReadTokens: 90, outputTokens: 7, totalTokens: 107, ...args,
})
const doc = observations => ({ schema: 'dvr-cache-ab-v1', observations })
test('actual-token-only report never fabricates billed savings', () => {
  const d = compareCacheAB(doc([one('before'), one('after', { inputTokens: 30, cacheReadTokens: 70 })]))
  assert.equal(d.pairedTrials, 1)
  assert.equal(d.before.cacheHitPercent, 90)
  assert.equal(d.after.cacheHitPercent, 70)
  assert.equal(d.deltas.cacheHitPercentagePoints, -20)
  assert.equal(d.deltas.billedCny, null)
  assert.equal(d.prefixComparison.unknownPairs, 1)
})
test('provider bill exports are compared exactly, including vision subcalls', () => {
  const rows = [
    one('before', { billedCny: '0.020123', billingSource: 'provider-billing-export', wirePrefixSha256: 'a'.repeat(64) }),
    one('before', { call: 'vision', billedCny: '0.009877', billingSource: 'provider-billing-export' }),
    one('after', { billedCny: '0.006123', billingSource: 'provider-billing-export', wirePrefixSha256: 'b'.repeat(64) }),
  ]
  const r = compareCacheAB(doc(rows))
  assert.equal(r.before.calls, 2)
  assert.equal(r.after.visionCalls, 0)
  assert.equal(r.before.billedCny, '0.030000')
  assert.equal(r.after.billedCny, '0.006123')
  assert.equal(r.deltas.billedCny, '-0.023877')
  assert.equal(r.prefixComparison.changedPairs, 1)
})
test('vision route can differ from main, if the run truly removed an extra vision call', () => {
  const rows = [one('before'), one('before', { call: 'vision', routeTag: 'visionProvider', modelTag: 'visionModel' }), one('after')]
  const result = compareCacheAB(doc(rows))
  assert.equal(result.pairedTrials, 1)
  assert.equal(result.deltas.requests, -1)
  assert.equal(result.before.visionCalls, 1)
})
test('mixed primary model across scenarios cannot hide in the aggregate', () => {
  const rows = [one('before', { case: 'one' }), one('after', { case: 'one' }),
    one('before', { case: 'two', modelTag: 'otherModel' }), one('after', { case: 'two', modelTag: 'otherModel' })]
  const result = compareCacheAB(doc(rows))
  assert.equal(result.pairedTrials, 1)
  assert.equal(result.excluded.mismatchedRoutes, 1)
})
test('missing and non-reconciled cache counters are unknown, never zero', () => {
  const a = compareCacheAB(doc([one('before', { cacheReadTokens: undefined }), one('after')]))
  assert.equal(a.before.cacheHitPercent, null)
  assert.equal(a.deltas.cacheHitPercentagePoints, null)
  const b = compareCacheAB(doc([one('before', { cacheReadTokens: 80 }), one('after')]))
  assert.equal(b.before.cacheReadTokens, null)
})
test('impossible explicit token accounting cannot produce a billed-cost comparison', () => {
  const bill = { billedCny: '0.020000', billingSource: 'provider-billing-export' }
  assert.throws(() => compareCacheAB(doc([
    one('before', { ...bill, cacheReadTokens: undefined, inputTokens: 30, outputTokens: 90, totalTokens: 107 }),
    one('after', bill),
  ])), /explicit token counters exceed provider total/)
  assert.throws(() => compareCacheAB(doc([
    one('before', { ...bill, cacheReadTokens: 100, totalTokens: 107 }),
    one('after', bill),
  ])), /explicit token counters exceed provider total/)
  assert.throws(() => compareCacheAB(doc([
    one('before', { ...bill, inputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 0, outputTokens: 7, totalTokens: 107 }),
    one('after', bill),
  ])), /complete disjoint token counters do not reconcile/)
  const complete = compareCacheAB(doc([
    one('before', { ...bill, inputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10, outputTokens: 7, totalTokens: 107 }),
    one('after', bill),
  ]))
  assert.equal(complete.before.cacheHitPercent, 80)
  const unknown = compareCacheAB(doc([
    one('before', { ...bill, cacheReadTokens: undefined }),
    one('after', bill),
  ]))
  assert.equal(unknown.before.cacheHitPercent, null)
  assert.equal(unknown.deltas.billedCny, '0.000000')
})

test('strictly excludes route/model mismatches and unmatched variants', () => {
  const r = compareCacheAB(doc([
    one('before', { case: 'one', modelTag: 'A' }), one('after', { case: 'one', modelTag: 'B' }),
    one('before', { case: 'two' }),
    one('before', { case: 'three' }), one('after', { case: 'three' }),
  ]))
  assert.equal(r.pairedTrials, 1)
  assert.deepEqual(r.excluded, { incompletePairs: 1, mismatchedRoutes: 1 })
})
test('rejects prompt or identity fields to prevent accidental sensitive output', () => {
  assert.throws(() => compareCacheAB(doc([one('before', { prompt: 'SECRET PROMPT' })])), /unknown field/)
  assert.throws(() => compareCacheAB(doc([one('before', { billedCny: '1.000000' })])), /billed cost/)
  assert.throws(() => compareCacheAB(doc([one('before', { cacheReadTokens: -5 })])), /cache counter/)
  assert.throws(() => compareCacheAB(doc([one('before', { trial: 0 })])), /trial/)
  assert.throws(() => compareCacheAB(doc([one('before', { wirePrefixSha256: 'SECRET' })])), /SHA256/)
  const r = compareCacheAB(doc([one('before'), one('after')]))
  assert.doesNotMatch(JSON.stringify(r) + formatCacheAB(r), /sameCase|accountOne|modelOne|SECRET/)
})

test('native DeepSeek Messages final cumulative usage is mapped without double counting', () => {
  const native = variant => {
    const { inputTokens, cacheReadTokens, outputTokens, totalTokens, ...meta } = one(variant, { usageSource: 'deepseek-messages-final' })
    return { ...meta, usage: { input_tokens: 10, cache_read_input_tokens: 90,
      cache_creation_input_tokens: 0, output_tokens: 7 } }
  }
  const result = compareCacheAB(doc([native('before'), native('after')]))
  assert.equal(result.before.uncachedInputTokens, 10)
  assert.equal(result.before.cacheReadTokens, 90)
  assert.equal(result.before.cacheHitPercent, 90)
  assert.equal(result.before.calls, 1)
  assert.equal(result.deltas.billedCny, null)
})
test('native DeepSeek Chat final usage rejects mismatched prompt and total', () => {
  const chat = variant => {
    const { inputTokens, cacheReadTokens, outputTokens, totalTokens, ...meta } = one(variant, { usageSource: 'deepseek-chat-final' })
    return { ...meta, usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 90,
      prompt_cache_miss_tokens: 10, completion_tokens: 7, total_tokens: 107 } }
  }
  const r = compareCacheAB(doc([chat('before'), chat('after')]))
  assert.equal(r.after.cacheHitPercent, 90)
  assert.throws(() => compareCacheAB(doc([chat('before'), {
    ...chat('after'), usage: { ...chat('after').usage, prompt_tokens: 999 },
  }])), /does not reconcile/)
  assert.throws(() => compareCacheAB(doc([{
    ...chat('before'), inputTokens: 1,
  }, chat('after')])), /must not be mixed/)
  assert.throws(() => compareCacheAB(doc([{
    ...chat('before'), usage: { ...chat('before').usage, request_id: 'SECRET' },
  }, chat('after')])), /requires exactly/)
})
