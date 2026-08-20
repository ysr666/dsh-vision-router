import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capabilityBenchmarkFingerprint } from '../lib/vision-capability-benchmark.js'
import {
  buildVisionRoutingPreview,
  VISION_ROUTING_PREVIEW_INTENTS,
} from '../lib/vision-routing-preview-service.js'

const DAY = 24 * 60 * 60 * 1000

function config(overrides = {}) {
  return {
    routingMode: 'auto',
    routingPreference: 'quality',
    providers: [
      { provider: 'alpha', model: 'vision-a', fallbacks: [] },
      { provider: 'beta', model: 'vision-b', fallbacks: [] },
    ],
    ...overrides,
  }
}

function fakeCtx(settingsValue) {
  return {
    get(name) {
      if (name === 'settings') return { get: () => settingsValue }
      return undefined
    },
    llm: {
      registration() {
        return { adapter: { constructor: { name: 'FakeRegisteredAdapter' } } }
      },
      async resolveModelInfo() {
        return { inputModalities: ['text', 'image'] }
      },
    },
  }
}

function fakeCore(localProviders = []) {
  return {
    DEFAULT_HTTP_PROVIDERS: [],
    adapterAvailable: () => true,
    decideVisionBackendCapability: () => ({ image: true, attemptable: true }),
    localProvidersOf: () => localProviders,
    httpProvidersOf: () => [],
  }
}

function adapterFingerprint(provider, model) {
  return capabilityBenchmarkFingerprint({
    provider,
    model,
    endpoint: `dsh-adapter://registered/${encodeURIComponent(provider)}`,
    config: { api: 'dsh-adapter', adapterKind: 'FakeRegisteredAdapter' },
  })
}

function profile(provider, model, measuredAt, scores, medianLatencyMs = {}) {
  return {
    fingerprint: adapterFingerprint(provider, model),
    provider,
    model,
    measuredAt,
    source: 'self-benchmark',
    scores,
    medianLatencyMs,
    fixtureCount: 6,
    failureCount: 0,
  }
}

function store(records = []) {
  const map = new Map(records.map((record) => [record.fingerprint, record]))
  return { async get(key) { return map.get(key) } }
}

function row(preview, intent) {
  return preview.previews.find((item) => item.intent === intent)
}

test('routing settings preview covers exactly the five directly measured benchmark axes', () => {
  assert.deepEqual(VISION_ROUTING_PREVIEW_INTENTS, [
    'structured',
    'ocr',
    'document',
    'grounding',
    'general',
  ])
})

test('fresh directly comparable measurements may preview a conservative measured reorder', async () => {
  const now = Date.now()
  const settings = config()
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings),
    config: settings,
    core: fakeCore(),
    store: store([
      profile('alpha', 'vision-a', now - DAY, { ocr: 0.70 }, { ocr: 400 }),
      profile('beta', 'vision-b', now - DAY, { ocr: 0.90 }, { ocr: 500 }),
    ]),
    now,
  })

  assert.equal(preview.routingMode, 'auto')
  assert.equal(preview.routingPreference, 'quality')
  assert.equal(preview.autoPreviewOnly, true)
  assert.equal(preview.executionActive, false)
  assert.equal(preview.healthIncluded, false)
  assert.deepEqual(preview.currentOrder, ['alpha/vision-a', 'beta/vision-b'])
  assert.deepEqual(preview.freshMeasuredBackends, ['alpha/vision-a', 'beta/vision-b'])

  const ocr = row(preview, 'ocr')
  assert.equal(ocr.first, 'beta/vision-b')
  assert.equal(ocr.changed, true)
  assert.equal(ocr.reason, 'measured-advantage')
  assert.ok(ocr.decisions.some((decision) => decision.type === 'reorder' && decision.promoted === 'beta/vision-b'))
})

test('one-sided measurement never jumps across an unmeasured configured route', async () => {
  const now = Date.now()
  const settings = config()
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings),
    config: settings,
    core: fakeCore(),
    store: store([
      profile('beta', 'vision-b', now - DAY, { ocr: 1 }, { ocr: 50 }),
    ]),
    now,
  })

  const ocr = row(preview, 'ocr')
  assert.equal(ocr.first, 'alpha/vision-a')
  assert.equal(ocr.changed, false)
  assert.equal(ocr.reason, 'insufficient-comparable-evidence')
  assert.ok(ocr.incomparableBackends.includes('alpha/vision-a'))
})

test('stale benchmark data remains outside Auto preview eligibility', async () => {
  const now = Date.now()
  const settings = config()
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings),
    config: settings,
    core: fakeCore(),
    store: store([
      profile('alpha', 'vision-a', now - 8 * DAY, { ocr: 0.10 }, { ocr: 1000 }),
      profile('beta', 'vision-b', now - 8 * DAY, { ocr: 1 }, { ocr: 50 }),
    ]),
    now,
  })

  assert.deepEqual(preview.freshMeasuredBackends, [])
  const ocr = row(preview, 'ocr')
  assert.equal(ocr.first, 'alpha/vision-a')
  assert.equal(ocr.changed, false)
  assert.equal(ocr.reason, 'insufficient-comparable-evidence')
})

test('local preference may preview local-first as explicit user policy without inventing capability scores', async () => {
  const settings = config({ routingPreference: 'local' })
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings),
    config: settings,
    core: fakeCore([{
      name: 'ollama',
      model: 'qwen-vl',
      baseURL: 'http://127.0.0.1:11434/v1',
      apiKeyEnv: '',
    }]),
    store: store(),
  })

  const general = row(preview, 'general')
  assert.equal(general.first, 'vision-http/ollama/qwen-vl')
  assert.equal(general.changed, true)
  assert.equal(general.reason, 'local-preference')
  assert.deepEqual(preview.freshMeasuredBackends, [])
})
