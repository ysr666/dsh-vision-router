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

test('partial benchmark exposes measured coverage, per-axis provenance and benchmark observations', async () => {
  const measuredAt = Date.now() - 2 * DAY
  const candidate = await snapshotFor({
    measuredAt,
    scores: { ocr: 0.92, general: 0.81 },
    benchmarkMedianLatencyMsByAxis: { ocr: 430, general: 710 },
    benchmarkLatencyMs: 570,
    fixtureCount: 3,
    failureCount: 0,
  })
  assert.ok(candidate?.measured)
  assert.deepEqual(candidate.measured.measuredAxes, ['ocr', 'general'])
  assert.deepEqual(candidate.measured.coverage, ['ocr', 'general'])
  assert.equal(candidate.measured.coverageKind, 'partial')
  assert.deepEqual(candidate.measured.measuredAtByAxis, { ocr: measuredAt, general: measuredAt })
  assert.deepEqual(candidate.measured.benchmarkMedianLatencyMs, { ocr: 430, general: 710 })
  assert.equal(candidate.measured.benchmarkLatencyMs, 570)
  for (const field of ['freshness', 'freshnessByAxis', 'autoEligible', 'autoEligibleAxes', 'staleAxes', 'confidence']) {
    assert.equal(Object.hasOwn(candidate.measured, field), false)
  }
})

test('five-axis benchmark is reported as full measured coverage', async () => {
  const candidate = await snapshotFor({
    measuredAt: Date.now() - DAY,
    scores: { structured: 0.9, ocr: 0.91, document: 0.88, grounding: 0.86, general: 0.93 },
    benchmarkMedianLatencyMsByAxis: { structured: 600, ocr: 500, document: 650, grounding: 700, general: 450 },
    fixtureCount: 6,
    failureCount: 0,
  })
  assert.equal(candidate.measured.coverageKind, 'full')
  assert.deepEqual(candidate.measured.measuredAxes, ['structured', 'ocr', 'document', 'grounding', 'general'])
})

test('mixed-age benchmark keeps independent timestamps without age grades', async () => {
  const now = Date.now()
  const candidate = await snapshotFor({
    measuredAt: now - DAY,
    measuredAtByAxis: { ocr: now - 80 * DAY, general: now - DAY },
    scores: { ocr: 0.9, general: 0.8 },
    benchmarkMedianLatencyMsByAxis: { ocr: 500, general: 700 },
    fixtureCount: 3,
    fixtureCountByAxis: { ocr: 2, general: 1 },
    failureCount: 0,
  })
  assert.ok(candidate?.measured)
  assert.equal(candidate.measured.measuredAtByAxis.ocr, now - 80 * DAY)
  assert.equal(candidate.measured.measuredAtByAxis.general, now - DAY)
  assert.equal(Object.hasOwn(candidate.measured, 'freshnessByAxis'), false)
})

test('old benchmark remains visible when identity and suite are unchanged', async () => {
  const measuredAt = Date.now() - 365 * DAY
  const candidate = await snapshotFor({
    measuredAt,
    scores: { ocr: 0.9, general: 0.8 },
    benchmarkMedianLatencyMsByAxis: { ocr: 500, general: 700 },
    fixtureCount: 3,
    failureCount: 0,
  })
  assert.ok(candidate?.measured)
  assert.deepEqual(candidate.measured.measuredAxes, ['ocr', 'general'])
  assert.deepEqual(candidate.measured.measuredAtByAxis, { ocr: measuredAt, general: measuredAt })
})
