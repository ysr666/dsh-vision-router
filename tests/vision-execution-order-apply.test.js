import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyVisionExecutionOrder,
  sameVisionPairOrder,
} from '../lib/vision-execution-order-apply.js'

const pair = (provider, model, extra = {}) => ({ provider, model, ...extra })

test('no scope preserves the base pair order and first-occurrence dedupe', () => {
  const base = [pair('a', '1'), pair('b', '2'), pair('a', '1', { duplicate: true })]
  assert.deepEqual(applyVisionExecutionOrder(base, undefined), [pair('a', '1'), pair('b', '2')])
})

test('scoped order reorders only routes already present in the base set', () => {
  const base = [pair('a', '1'), pair('local', 'vl'), pair('b', '2'), pair('fallback', '3')]
  const scoped = [
    pair('local', 'vl'),
    pair('not-configured', 'invented'),
    pair('b', '2'),
    pair('a', '1'),
  ]
  assert.deepEqual(applyVisionExecutionOrder(base, scoped), [
    pair('local', 'vl'),
    pair('b', '2'),
    pair('a', '1'),
    pair('fallback', '3'),
  ])
})

test('planner omission never deletes configured/local/discovered fallbacks', () => {
  const base = [
    pair('configured-a', '1'),
    pair('vision-http', 'local-ollama/qwen-vl'),
    pair('configured-b', '2'),
    pair('auto-discovered', 'vision-fallback'),
  ]
  const scoped = [pair('configured-b', '2'), pair('configured-a', '1')]
  assert.deepEqual(applyVisionExecutionOrder(base, scoped), [
    pair('configured-b', '2'),
    pair('configured-a', '1'),
    pair('vision-http', 'local-ollama/qwen-vl'),
    pair('auto-discovered', 'vision-fallback'),
  ])
})

test('disabled local route requested by a stale scope cannot be reintroduced', () => {
  const base = [pair('configured', 'm')]
  const scoped = [pair('vision-http', 'local-ollama/disabled'), pair('configured', 'm')]
  assert.deepEqual(applyVisionExecutionOrder(base, scoped), [pair('configured', 'm')])
})

test('blocked or unavailable base filtering remains caller-owned and cannot be widened by scope', () => {
  const baseAfterCoreAvailability = [pair('healthy', 'm1'), pair('fallback', 'm2')]
  const scoped = [pair('blocked', 'm0'), pair('fallback', 'm2'), pair('healthy', 'm1')]
  assert.deepEqual(applyVisionExecutionOrder(baseAfterCoreAvailability, scoped), [
    pair('fallback', 'm2'),
    pair('healthy', 'm1'),
  ])
})

test('sameVisionPairOrder compares only provider/model identity', () => {
  assert.equal(
    sameVisionPairOrder([pair('a', '1', { score: 1 })], [pair('a', '1', { score: 999 })]),
    true,
  )
  assert.equal(sameVisionPairOrder([pair('a', '1')], [pair('b', '1')]), false)
  assert.equal(sameVisionPairOrder([pair('a', '1')], [pair('a', '1'), pair('b', '2')]), false)
})
