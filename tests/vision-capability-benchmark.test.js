import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPABILITY_BENCHMARK_RENDERER_SCOPE,
  CAPABILITY_BENCHMARK_SUITE_REVISION,
  CORE_BENCHMARK_INTENTS,
  aggregateCapabilityBenchmark,
  capabilityBenchmarkFingerprint,
  capabilityBenchmarkFixture,
  listCapabilityBenchmarkFixtures,
  normalizeGroundingBox,
  scoreCapabilityBenchmarkResult,
} from '../lib/vision-capability-benchmark.js'
import { renderCapabilityBenchmarkFixturePng } from '../lib/vision-capability-benchmark-service.js'

test('core benchmark suite v2 is generated locally and includes bilingual OCR coverage', () => {
  assert.equal(CAPABILITY_BENCHMARK_SUITE_REVISION, 2)
  assert.match(CAPABILITY_BENCHMARK_RENDERER_SCOPE, /^[^/]+\/[^/]+$/)
  assert.deepEqual(CORE_BENCHMARK_INTENTS, ['structured', 'ocr', 'grounding', 'document', 'general'])
  const fixtures = listCapabilityBenchmarkFixtures()
  assert.equal(fixtures.length, 6)
  assert.deepEqual(fixtures.map((fixture) => fixture.id), [
    'structured-dashboard-v2',
    'ocr-latin-ui-v2',
    'ocr-zh-chat-v2',
    'grounding-target-v2',
    'document-table-v2',
    'general-scene-v2',
  ])
  for (const fixture of fixtures) {
    assert.match(fixture.svg, /^<svg/)
    assert.ok(fixture.prompt.length > 20)
    assert.ok(fixture.id.includes('-v2'))
    assert.doesNotMatch(fixture.svg, /<text\b[^>]*\bfill="[^"]+"[^>]*\bfill="[^"]+"/i)
  }
  const zhChat = fixtures.find((fixture) => fixture.id === 'ocr-zh-chat-v2')
  assert.equal(zhChat.intent, 'ocr')
  assert.match(zhChat.svg, /项目讨论/)
  assert.match(zhChat.expected.text, /引用：先别合并/)
  assert.match(zhChat.expected.text, /20:30/)
})

test('every benchmark fixture actually rasterizes through sharp before real-machine testing', async () => {
  for (const fixture of listCapabilityBenchmarkFixtures()) {
    const png = await renderCapabilityBenchmarkFixturePng({}, fixture)
    assert.ok(Buffer.isBuffer(png), fixture.id)
    assert.ok(png.length > 100, fixture.id)
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], fixture.id)
  }
})

test('OCR scorer rewards exact transcription and degrades for errors', () => {
  const fixture = capabilityBenchmarkFixture('ocr')
  const exact = scoreCapabilityBenchmarkResult(fixture, fixture.expected.text, 500)
  const wrong = scoreCapabilityBenchmarkResult(fixture, 'Router Bench 7Q2\nInvoice WRONG', 500)
  assert.equal(exact.score, 1)
  assert.ok(wrong.score < 0.7)
})

test('Chinese chat OCR fixture uses the same exact-order scorer', () => {
  const fixture = listCapabilityBenchmarkFixtures(['ocr']).find((item) => item.id === 'ocr-zh-chat-v2')
  const exact = scoreCapabilityBenchmarkResult(fixture, fixture.expected.text, 620)
  const missingQuote = scoreCapabilityBenchmarkResult(
    fixture,
    fixture.expected.text.replace('引用：先别合并\n', ''),
    620,
  )
  assert.equal(exact.score, 1)
  assert.ok(missingQuote.score < 1)
})

test('document scorer requires valid JSON, row order, pairing, total and order id', () => {
  const fixture = capabilityBenchmarkFixture('document')
  const exact = scoreCapabilityBenchmarkResult(fixture, JSON.stringify({
    title: 'Order Summary',
    rows: [
      { item: 'Camera', amount: '$120' },
      { item: 'Cable', amount: '$15' },
    ],
    total: '$135',
    order_id: 'R-4821',
  }), 400)
  const swapped = scoreCapabilityBenchmarkResult(fixture, JSON.stringify({
    title: 'Order Summary',
    rows: [
      { item: 'Cable', amount: '$15' },
      { item: 'Camera', amount: '$120' },
    ],
    total: '$135',
    order_id: 'R-4821',
  }), 400)
  const tokenSoup = scoreCapabilityBenchmarkResult(
    fixture,
    'Order Summary Camera $120 Cable $15 Total $135 R-4821',
    400,
  )
  assert.equal(exact.score, 1)
  assert.ok(swapped.score < exact.score)
  assert.equal(tokenSoup.score, 0)
  assert.equal(tokenSoup.details.jsonValid, false)
})

test('grounding scorer uses IoU in original fixture pixels', () => {
  const fixture = capabilityBenchmarkFixture('grounding')
  const exact = scoreCapabilityBenchmarkResult(fixture, JSON.stringify(fixture.expected.box), 300)
  const loose = scoreCapabilityBenchmarkResult(fixture, '{"x1":450,"y1":300,"x2":740,"y2":470}', 300)
  assert.equal(exact.score, 1)
  assert.ok(loose.score > 0 && loose.score < 1)
})

test('grounding scorer normalizes common 0-1, percentage and 0-1000 coordinate spaces before IoU', () => {
  const fixture = capabilityBenchmarkFixture('grounding')
  const box = fixture.expected.box
  const ratio = {
    x1: box.x1 / 768,
    y1: box.y1 / 512,
    x2: box.x2 / 768,
    y2: box.y2 / 512,
  }
  const percent = {
    x1: box.x1 / 768 * 100,
    y1: box.y1 / 512 * 100,
    x2: box.x2 / 768 * 100,
    y2: box.y2 / 512 * 100,
  }
  const thousand = {
    x1: box.x1 / 768 * 1000,
    y1: box.y1 / 512 * 1000,
    x2: box.x2 / 768 * 1000,
    y2: box.y2 / 512 * 1000,
  }
  for (const [space, value] of [['normalized-1', ratio], ['percent-100', percent], ['normalized-1000', thousand]]) {
    const normalized = normalizeGroundingBox(value)
    assert.equal(normalized.coordinateSpace, space)
    const scored = scoreCapabilityBenchmarkResult(fixture, JSON.stringify(value), 300)
    assert.ok(scored.score > 0.99)
    assert.equal(scored.details.coordinateSpace, space)
    assert.equal(scored.details.formatValid, true)
  }
})

test('grounding scorer accepts GLM-style prose and bracket coordinates in 0-1000 space', () => {
  const fixture = capabilityBenchmarkFixture('grounding')
  const output = 'The position of the SAVE button is [672,672,901,813].'
  const scored = scoreCapabilityBenchmarkResult(fixture, output, 300)
  assert.ok(scored.score > 0.99)
  assert.equal(scored.details.parseSource, 'flat-four-tuple')
  assert.equal(scored.details.coordinateSpace, 'normalized-1000')
  assert.equal(scored.details.responseShape, 'array')
  assert.equal(scored.details.formatValid, true)
})

test('grounding scorer accepts nested arrays, point-pair tokens and min/max keys', () => {
  const fixture = capabilityBenchmarkFixture('grounding')
  const outputs = [
    '[[672,672,901,813]]',
    '<|box_start|>(672,672),(901,813)<|box_end|>',
    '{"xmin":672,"ymin":672,"xmax":901,"ymax":813}',
    '{"coordinates":[[672,672],[901,813]]}',
  ]
  for (const output of outputs) {
    const scored = scoreCapabilityBenchmarkResult(fixture, output, 300)
    assert.ok(scored.score > 0.99, output)
    assert.equal(scored.details.coordinateSpace, 'normalized-1000')
    assert.equal(scored.details.formatValid, true)
  }
})

test('grounding scorer accepts native GLM box markers and tuple wrappers', () => {
  const fixture = capabilityBenchmarkFixture('grounding')
  const outputs = [
    '<|begin_of_box|><672,672,901,813><|end_of_box|>',
    '(672,672,901,813)',
    '<672,672,901,813>',
    '672,672,901,813',
  ]
  for (const output of outputs) {
    const scored = scoreCapabilityBenchmarkResult(fixture, output, 300)
    assert.ok(scored.score > 0.99, output)
    assert.equal(scored.details.coordinateSpace, 'normalized-1000')
    assert.equal(scored.details.formatValid, true)
  }
})

test('grounding normalizer accepts nested bbox arrays and xywh response shapes', () => {
  const bbox = normalizeGroundingBox({ bbox: [516, 344, 692, 416] })
  assert.deepEqual(bbox.box, { x1: 516, y1: 344, x2: 692, y2: 416 })
  assert.equal(bbox.shape, 'array')
  const xywh = normalizeGroundingBox({ x: 516, y: 344, width: 176, height: 72 })
  assert.deepEqual(xywh.box, { x1: 516, y1: 344, x2: 692, y2: 416 })
  assert.equal(xywh.shape, 'xywh')
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

test('endpoint fingerprint stays secret-safe but binds suite, renderer and credential identity', () => {
  const common = {
    provider: ' p ',
    model: ' m ',
    endpoint: 'HTTPS://A.TEST/v1/?b=2&a=1&token=SECRET-1',
    config: {
      temperature: 0,
      apiKey: 'SECRET-1',
      transport: { timeoutMs: 5000, authorization: 'Bearer SECRET-1' },
      gateway: { baseUrl: 'https://relay.test/v1/?z=9&key=SECRET-1' },
    },
  }
  const a = capabilityBenchmarkFingerprint({ ...common, credentialFingerprint: 'cred_aaa' })
  const sameSanitized = capabilityBenchmarkFingerprint({
    provider: 'p',
    model: 'm',
    endpoint: 'https://a.test/v1?a=1&b=2&token=SECRET-2',
    config: {
      gateway: { baseUrl: 'https://relay.test/v1?key=SECRET-2&z=9' },
      transport: { authorization: 'Bearer SECRET-2', timeoutMs: 5000 },
      apiKey: 'SECRET-2',
      temperature: 0,
    },
    credentialFingerprint: 'cred_aaa',
  })
  const changedCredential = capabilityBenchmarkFingerprint({ ...common, credentialFingerprint: 'cred_bbb' })
  const changedPath = capabilityBenchmarkFingerprint({ ...common, endpoint: 'https://a.test/v2?a=1&b=2', credentialFingerprint: 'cred_aaa' })
  const changedNestedConfig = capabilityBenchmarkFingerprint({ ...common, config: { temperature: 0, transport: { timeoutMs: 9000 } }, credentialFingerprint: 'cred_aaa' })
  const changedModel = capabilityBenchmarkFingerprint({ ...common, model: 'm2', credentialFingerprint: 'cred_aaa' })
  assert.equal(a, sameSanitized)
  assert.notEqual(a, changedCredential)
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
})
