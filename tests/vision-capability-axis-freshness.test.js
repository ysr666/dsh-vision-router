import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectCapabilityShadowCandidates, buildCapabilityShadowPlan } from '../lib/vision-capability-shadow.js'

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

test('fresh General does not make stale OCR evidence Auto-eligible', async () => {
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
          medianLatencyMs: { ocr: 100, general: 200 },
        })
      }
      return records.get(fingerprint)
    },
  }
  const rows = await collectCapabilityShadowCandidates(ctx(config()), config(), core(), store)
  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => row.measured?.ocr === undefined))
  assert.ok(rows.every((row) => Number.isFinite(row.measured?.general)))
  assert.ok(rows.every((row) => row.medianLatencyMs?.ocr === undefined))

  const ocr = await buildCapabilityShadowPlan({
    ctx: ctx(config()), config: config(), core: core(), store,
    toolName: 'vision_ocr', args: {},
  })
  assert.deepEqual(ocr.currentOrder, ['alpha/vision-a', 'beta/vision-b'])
  assert.deepEqual(ocr.autoPreviewOrder, ocr.currentOrder)
  assert.deepEqual(ocr.measuredBackends.sort(), ['alpha/vision-a', 'beta/vision-b'])
  assert.deepEqual(ocr.incomparableBackends.sort(), ['alpha/vision-a', 'beta/vision-b'])
})

test('fresh axis remains independently usable when another axis is stale', async () => {
  const now = Date.now()
  const store = {
    async get() {
      return {
        measuredAt: now,
        measuredAtByAxis: { ocr: now - 8 * DAY, general: now },
        scores: { ocr: 0.9, general: 0.8 },
        medianLatencyMs: { ocr: 100, general: 200 },
      }
    },
  }
  const rows = await collectCapabilityShadowCandidates(ctx(config()), config(), core(), store)
  assert.ok(rows.every((row) => row.measured?.general === 0.8))
  assert.ok(rows.every((row) => row.measuredAtByAxis?.general === now))
})
