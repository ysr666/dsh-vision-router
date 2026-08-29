import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectVisionRoutingCandidates } from '../lib/vision-routing-evidence.js'
import { buildVisionRoutingPlan } from '../lib/vision-routing-runtime.js'

const DAY = 24 * 60 * 60 * 1000

function ctx(config) {
  return {
    get(name) {
      if (name === 'settings') return { get: () => config }
      return undefined
    },
    llm: {
      registration() { return { adapter: { constructor: { name: 'FakeAdapter' } } } },
      async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
    },
  }
}

function core() {
  return {
    DEFAULT_HTTP_PROVIDERS: [],
    adapterAvailable: () => true,
    decideVisionBackendCapability: () => ({ image: true, attemptable: true }),
    localProvidersOf: () => [],
    httpProvidersOf: () => [],
  }
}

function config() {
  return {
    routingMode: 'auto',
    routingPreference: 'quality',
    providers: [
      { provider: 'alpha', model: 'vision-a', fallbacks: [] },
      { provider: 'beta', model: 'vision-b', fallbacks: [] },
    ],
  }
}

test('measurement age is metadata: eight-day-old OCR remains usable by Quality', async () => {
  const now = Date.now()
  const records = new Map()
  const store = {
    async get(fingerprint) {
      if (!records.has(fingerprint)) {
        const index = records.size
        records.set(fingerprint, {
          measuredAt: now,
          measuredAtByAxis: { ocr: now - 8 * DAY, general: now },
          scores: { ocr: index === 0 ? 0.2 : 0.99, general: index === 0 ? 0.7 : 0.8 },
          benchmarkMedianLatencyMsByAxis: { ocr: 100, general: 200 },
        })
      }
      return records.get(fingerprint)
    },
  }
  const rows = await collectVisionRoutingCandidates(ctx(config()), config(), core(), store)
  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => Number.isFinite(row.measured?.ocr)))
  assert.ok(rows.every((row) => Number.isFinite(row.measured?.general)))
  assert.ok(rows.every((row) => row.benchmarkMedianLatencyMsByAxis?.ocr === 100))
  assert.ok(rows.every((row) => row.runtimeLatencyMsByAxis === undefined))

  const ocr = await buildVisionRoutingPlan({
    ctx: ctx(config()), config: config(), core: core(), store,
    toolName: 'vision_ocr', args: {},
  })
  assert.deepEqual(ocr.currentOrder, ['alpha/vision-a', 'beta/vision-b'])
  assert.deepEqual(ocr.autoPreviewOrder, ['beta/vision-b', 'alpha/vision-a'])
  assert.deepEqual(ocr.measuredBackends.sort(), ['alpha/vision-a', 'beta/vision-b'])
  assert.deepEqual(ocr.incomparableBackends, [])
})

test('per-axis timestamps remain independent provenance without creating a TTL', async () => {
  const now = Date.now()
  const store = {
    async get() {
      return {
        measuredAt: now,
        measuredAtByAxis: { ocr: now - 8 * DAY, general: now },
        scores: { ocr: 0.9, general: 0.8 },
        benchmarkMedianLatencyMsByAxis: { ocr: 100, general: 200 },
      }
    },
  }
  const rows = await collectVisionRoutingCandidates(ctx(config()), config(), core(), store)
  assert.ok(rows.every((row) => row.measured?.ocr === 0.9))
  assert.ok(rows.every((row) => row.measured?.general === 0.8))
  assert.ok(rows.every((row) => row.measuredAtByAxis?.ocr === now - 8 * DAY))
  assert.ok(rows.every((row) => row.measuredAtByAxis?.general === now))
})
