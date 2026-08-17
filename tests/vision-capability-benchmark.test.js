import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CORE_BENCHMARK_INTENTS,
  aggregateCapabilityBenchmark,
  capabilityBenchmarkFingerprint,
  capabilityBenchmarkFixture,
  listCapabilityBenchmarkFixtures,
  scoreCapabilityBenchmarkResult,
} from '../lib/vision-capability-benchmark.js'

test('core benchmark fixtures are generated locally and include bilingual OCR coverage', () => {
  assert.deepEqual(CORE_BENCHMARK_INTENTS, ['structured', 'ocr', 'grounding', 'document', 'general'])
  const fixtures = listCapabilityBenchmarkFixtures()
  assert.equal(fixtures.length, 6)
  assert.deepEqual(fixtures.map((fixture) => fixture.id), [
    'structured-dashboard-v1',
    'ocr-latin-ui-v1',
    'ocr-zh-chat-v1',
    'grounding-target-v1',
    'document-table-v1',
    'general-scene-v1',
  ])
  for (const fixture of fixtures) {
    assert.match(fixture.svg, /^<svg/)
    assert.ok(fixture.prompt.length > 20)
    assert.ok(fixture.id.includes('-v1'))
  }
  const zhChat = fixtures.find((fixture) => fixture.id === 'ocr-zh-chat-v1')
  assert.equal(zhChat.intent, 'ocr')
  assert.match(zhChat.svg, /项目讨论/)
  assert.match(zhChat.expected.text, /引用：先别合并/)
  assert.match(zhChat.expected.text, /20:30/)
})

test('OCR scorer rewards exact transcription and degrades for errors', () => {
  const fixture = capabilityBenchmarkFixture('ocr')
  const exact = scoreCapabilityBenchmarkResult(fixture, fixture.expected.text, 500)
  const wrong = scoreCapabilityBenchmarkResult(fixture, 'Router Bench 7Q2\nInvoice WRONG', 500)
  assert.equal(exact.score, 1)
  assert.ok(wrong.score < 0.7)
})

test('Chinese chat OCR fixture uses the same exact-order scorer', () => {
  const fixture = listCapabilityBenchmarkFixtures(['ocr']).find((item) => item.id === 'ocr-zh-chat-v1')
  const exact = scoreCapabilityBenchmarkResult(fixture, fixture.expected.text, 620)
  const missingQuote = scoreCapabilityBenchmarkResult(
    fixture,
    fixture.expected.text.replace('引用：先别合并\n', ''),
    620,
  )
  assert.equal(exact.score, 1)
  assert.ok(missingQuote.score < 1)
})

test('grounding scorer uses IoU in original fixture pixels', () => {
  const fixture = capabilityBenchmarkFixture('grounding')
  const exact = scoreCapabilityBenchmarkResult(fixture, JSON.stringify(fixture.expected.box), 300)
  const loose = scoreCapabilityBenchmarkResult(fixture, '{"x1":450,"y1":300,"x2":740,"y2":470}', 300)
  assert.equal(exact.score, 1)
  assert.ok(loose.score > 0 && loose.score < 1)
})

test('structured scorer requires both schema coverage and visible evidence', () => {
  const fixture = capabilityBenchmarkFixture('structured')
  const good = scoreCapabilityBenchmarkResult(fixture, JSON.stringify({
    visual_kind: 'ui',
    overview: 'dashboard',
    regions: ['sidebar', 'status'],
    visible_text: ['STATUS', 'READY', 'Queue', '3 jobs', 'Latency', '820 ms'],
    relationships: ['sidebar left of cards'],
    uncertainties: [],
  }), 800)
  const shallow = scoreCapabilityBenchmarkResult(fixture, '{"overview":"dashboard"}', 800)
  assert.equal(good.score, 1)
  assert.ok(shallow.score < 0.3)
})

test('endpoint fingerprint is secret-safe, canonical, recursive, and endpoint-specific', () => {
  const a = capabilityBenchmarkFingerprint({
    provider: ' p ',
    model: ' m ',
    endpoint: 'HTTPS://A.TEST/v1/?b=2&a=1&token=SECRET-1',
    config: {
      temperature: 0,
      apiKey: 'SECRET-1',
      transport: { timeoutMs: 5000, authorization: 'Bearer SECRET-1' },
      gateway: { baseUrl: 'https://relay.test/v1/?z=9&key=SECRET-1' },
    },
  })
  const b = capabilityBenchmarkFingerprint({
    provider: 'p',
    model: 'm',
    endpoint: 'https://a.test/v1?a=1&b=2&token=SECRET-2',
    config: {
      gateway: { baseUrl: 'https://relay.test/v1?key=SECRET-2&z=9' },
      transport: { authorization: 'Bearer SECRET-2', timeoutMs: 5000 },
      apiKey: 'SECRET-2',
      temperature: 0,
    },
  })
  const changedPath = capabilityBenchmarkFingerprint({ provider: 'p', model: 'm', endpoint: 'https://a.test/v2?a=1&b=2', config: { temperature: 0, transport: { timeoutMs: 5000 }, gateway: { baseUrl: 'https://relay.test/v1?z=9' } } })
  const changedNestedConfig = capabilityBenchmarkFingerprint({ provider: 'p', model: 'm', endpoint: 'https://a.test/v1?a=1&b=2', config: { temperature: 0, transport: { timeoutMs: 9000 }, gateway: { baseUrl: 'https://relay.test/v1?z=9' } } })
  const changedModel = capabilityBenchmarkFingerprint({ provider: 'p', model: 'm2', endpoint: 'https://a.test/v1?a=1&b=2', config: { temperature: 0, transport: { timeoutMs: 5000 }, gateway: { baseUrl: 'https://relay.test/v1?z=9' } } })
  assert.equal(a, b)
  assert.notEqual(a, changedPath)
  assert.notEqual(a, changedNestedConfig)
  assert.notEqual(a, changedModel)
  assert.match(a, /^ep2_[0-9a-f]{32}$/)
})

test('aggregate averages multiple fixtures for the same intent', () => {
  const aggregate = aggregateCapabilityBenchmark([
    { intent: 'ocr', score: 0.8, latencyMs: 1000 },
    { intent: 'ocr', score: 1, latencyMs: 500 },
    { intent: 'grounding', score: 0.6, latencyMs: 800 },
  ])
  assert.equal(aggregate.scores.ocr, 0.9)
  assert.equal(aggregate.medianLatencyMs.ocr, 750)
  assert.equal(aggregate.scores.grounding, 0.6)
  assert.equal(aggregate.fixtureCount, 3)
  assert.equal(aggregate.attemptedCount, 3)
})


test('grounding scorer accepts Qwen bbox_2d on a 0..1000 coordinate scale', () => {
  const fixture = capabilityBenchmarkFixture('grounding')
  const output = JSON.stringify([{ bbox_2d: [672, 672, 901, 813], label: 'SAVE' }])
  const scored = scoreCapabilityBenchmarkResult(fixture, output, 300)
  assert.ok(scored.score > 0.85)
})

test('general scorer treats trivial number words as semantic aliases', () => {
  const fixture = capabilityBenchmarkFixture('general')
  const scored = scoreCapabilityBenchmarkResult(fixture, 'There are three large shapes: circle, square, triangle.', 300)
  assert.equal(scored.score, 1)
})

test('aggregate excludes infrastructure failures from capability scores', () => {
  const aggregate = aggregateCapabilityBenchmark([
    { intent: 'ocr', score: 0.9, ok: true, latencyMs: 400 },
    { intent: 'ocr', score: 0, ok: false, failure: 'RATE_LIMIT', latencyMs: 20 },
  ])
  assert.equal(aggregate.scores.ocr, 0.9)
  assert.equal(aggregate.fixtureCount, 1)
  assert.equal(aggregate.failedCount, 1)
})
