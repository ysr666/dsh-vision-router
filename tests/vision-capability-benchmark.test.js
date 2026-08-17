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

test('core benchmark fixtures are generated locally and cover discovery intents', () => {
  assert.deepEqual(CORE_BENCHMARK_INTENTS, ['structured', 'ocr', 'grounding', 'document', 'general'])
  const fixtures = listCapabilityBenchmarkFixtures()
  assert.equal(fixtures.length, 5)
  for (const fixture of fixtures) {
    assert.match(fixture.svg, /^<svg/)
    assert.ok(fixture.prompt.length > 20)
    assert.ok(fixture.id.includes('-v1'))
  }
})

test('OCR scorer rewards exact transcription and degrades for errors', () => {
  const fixture = capabilityBenchmarkFixture('ocr')
  const exact = scoreCapabilityBenchmarkResult(fixture, fixture.expected.text, 500)
  const wrong = scoreCapabilityBenchmarkResult(fixture, 'Router Bench 7Q2\nInvoice WRONG', 500)
  assert.equal(exact.score, 1)
  assert.ok(wrong.score < 0.7)
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

test('fingerprint ignores secret-looking config fields but changes with endpoint/model', () => {
  const a = capabilityBenchmarkFingerprint({ provider: 'p', model: 'm', endpoint: 'https://a.test', config: { temperature: 0, apiKey: 'SECRET-1' } })
  const b = capabilityBenchmarkFingerprint({ provider: 'p', model: 'm', endpoint: 'https://a.test', config: { temperature: 0, apiKey: 'SECRET-2' } })
  const c = capabilityBenchmarkFingerprint({ provider: 'p', model: 'm2', endpoint: 'https://a.test', config: { temperature: 0 } })
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.equal(a.length, 24)
})

test('aggregate produces measured score map and median latency per intent', () => {
  const aggregate = aggregateCapabilityBenchmark([
    { intent: 'ocr', score: 0.8, latencyMs: 1000 },
    { intent: 'ocr', score: 1, latencyMs: 500 },
    { intent: 'grounding', score: 0.6, latencyMs: 800 },
  ])
  assert.equal(aggregate.scores.ocr, 0.9)
  assert.equal(aggregate.medianLatencyMs.ocr, 750)
  assert.equal(aggregate.scores.grounding, 0.6)
  assert.equal(aggregate.fixtureCount, 3)
})
