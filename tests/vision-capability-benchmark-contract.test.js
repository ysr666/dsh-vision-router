import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCapabilityBenchmarkManager } from '../lib/vision-capability-benchmark-service.js'

const DAY = 24 * 60 * 60 * 1000
const config = {
  providers: [{ provider: 'vision-http', model: 'local/test-model', fallbacks: [] }],
  httpProviders: [],
  freeFallback: false,
}

function fakeCore() {
  return {
    DEFAULT_HTTP_PROVIDERS: [],
    localProvidersOf: () => [{
      name: 'local',
      baseURL: 'http://127.0.0.1:1234/v1',
      model: 'test-model',
      apiKeyEnv: '',
    }],
    httpProvidersOf: () => [],
    adapterAvailable: () => true,
    decideVisionBackendCapability: () => ({ image: true, attemptable: true }),
  }
}

function fakeCtx() {
  return {
    get(name) {
      if (name === 'settings') return { get: () => config }
      return undefined
    },
    llm: {},
    logger: { info() {}, warn() {} },
  }
}

async function snapshotFor(record) {
  const store = {
    async get() { return record },
    async put(value) { return value },
  }
  const manager = createCapabilityBenchmarkManager(fakeCtx(), config, fakeCore(), { store })
  const snapshot = await manager.snapshot()
  return snapshot.candidates.find((candidate) => candidate.key === 'vision-http/local/test-model')
}

test('partial benchmark exposes coverage, per-axis time and latency without confidence grading', async () => {
  const measuredAt = Date.now() - 2 * DAY
  const candidate = await snapshotFor({
    measuredAt,
    scores: { ocr: 0.92, general: 0.81 },
    medianLatencyMs: { ocr: 430, general: 710 },
    latencyMs: 570,
    fixtureCount: 3,
    failureCount: 0,
  })
  assert.ok(candidate?.measured)
  assert.deepEqual(candidate.measured.coverage, ['ocr', 'general'])
  assert.equal(candidate.measured.coverageKind, 'partial')
  assert.equal(candidate.measured.autoEligible, true)
  assert.deepEqual(candidate.measured.autoEligibleAxes, ['ocr', 'general'])
  assert.deepEqual(candidate.measured.measuredAtByAxis, { ocr: measuredAt, general: measuredAt })
  assert.deepEqual(candidate.measured.medianLatencyMs, { ocr: 430, general: 710 })
  assert.equal(Object.hasOwn(candidate.measured, 'confidence'), false)
})

test('five-axis benchmark is reported as full coverage', async () => {
  const candidate = await snapshotFor({
    measuredAt: Date.now() - DAY,
    scores: { structured: 0.9, ocr: 0.91, document: 0.88, grounding: 0.86, general: 0.93 },
    medianLatencyMs: { structured: 600, ocr: 500, document: 650, grounding: 700, general: 450 },
    fixtureCount: 6,
    failureCount: 0,
  })
  assert.equal(candidate.measured.coverageKind, 'full')
  assert.deepEqual(candidate.measured.coverage, ['structured', 'ocr', 'document', 'grounding', 'general'])
  assert.equal(candidate.measured.autoEligible, true)
})

test('mixed-age benchmark keeps independent timestamps while every measured axis stays eligible', async () => {
  const now = Date.now()
  const candidate = await snapshotFor({
    measuredAt: now - DAY,
    measuredAtByAxis: { ocr: now - 80 * DAY, general: now - DAY },
    scores: { ocr: 0.9, general: 0.8 },
    medianLatencyMs: { ocr: 500, general: 700 },
    fixtureCount: 3,
    fixtureCountByAxis: { ocr: 2, general: 1 },
    failureCount: 0,
  })
  assert.ok(candidate?.measured)
  assert.equal(candidate.measured.autoEligible, true)
  assert.deepEqual(candidate.measured.autoEligibleAxes, ['ocr', 'general'])
  assert.equal(candidate.measured.measuredAtByAxis.ocr, now - 80 * DAY)
  assert.equal(candidate.measured.measuredAtByAxis.general, now - DAY)
})

test('old benchmark remains visible and Auto-eligible when identity and suite are unchanged', async () => {
  const measuredAt = Date.now() - 365 * DAY
  const candidate = await snapshotFor({
    measuredAt,
    scores: { ocr: 0.9, general: 0.8 },
    medianLatencyMs: { ocr: 500, general: 700 },
    fixtureCount: 3,
    failureCount: 0,
  })
  assert.ok(candidate?.measured)
  assert.equal(candidate.measured.autoEligible, true)
  assert.deepEqual(candidate.measured.autoEligibleAxes, ['ocr', 'general'])
  assert.deepEqual(candidate.measured.measuredAtByAxis, { ocr: measuredAt, general: measuredAt })
})