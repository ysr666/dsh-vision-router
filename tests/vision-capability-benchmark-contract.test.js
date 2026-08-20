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

test('fresh partial benchmark exposes coverage and per-axis latency without confidence grading', async () => {
  const candidate = await snapshotFor({
    measuredAt: Date.now() - 2 * DAY,
    scores: { ocr: 0.92, general: 0.81 },
    medianLatencyMs: { ocr: 430, general: 710 },
    latencyMs: 570,
    fixtureCount: 3,
    failureCount: 0,
  })
  assert.ok(candidate?.measured)
  assert.deepEqual(candidate.measured.coverage, ['ocr', 'general'])
  assert.equal(candidate.measured.coverageKind, 'partial')
  assert.equal(candidate.measured.freshness, 'fresh')
  assert.equal(candidate.measured.autoEligible, true)
  assert.deepEqual(candidate.measured.medianLatencyMs, { ocr: 430, general: 710 })
  assert.equal(Object.hasOwn(candidate.measured, 'confidence'), false)
})

test('fresh five-axis benchmark is reported as full coverage', async () => {
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

test('stale benchmark remains visible but is explicitly ineligible for auto selection', async () => {
  const candidate = await snapshotFor({
    measuredAt: Date.now() - 8 * DAY,
    scores: { ocr: 0.9, general: 0.8 },
    medianLatencyMs: { ocr: 500, general: 700 },
    fixtureCount: 3,
    failureCount: 0,
  })
  assert.ok(candidate?.measured)
  assert.equal(candidate.measured.freshness, 'stale')
  assert.equal(candidate.measured.autoEligible, false)
})

test('expired benchmark is not exposed to the browser product contract', async () => {
  const candidate = await snapshotFor({
    measuredAt: Date.now() - 31 * DAY,
    scores: { ocr: 0.99, general: 0.99 },
    medianLatencyMs: { ocr: 100, general: 100 },
    fixtureCount: 3,
    failureCount: 0,
  })
  assert.ok(candidate)
  assert.equal(candidate.measured, undefined)
})