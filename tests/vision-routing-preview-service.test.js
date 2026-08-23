import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capabilityEvidenceFingerprint } from '../lib/vision-capability-identity.js'
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
  return capabilityEvidenceFingerprint({
    provider,
    model,
    endpoint: `dsh-adapter://registered/${encodeURIComponent(provider)}`,
    config: { api: 'dsh-adapter', adapterKind: 'FakeRegisteredAdapter' },
  })
}

function profile(provider, model, measuredAt, scores, benchmarkMedianLatencyMsByAxis = {}) {
  return {
    fingerprint: adapterFingerprint(provider, model),
    provider,
    model,
    measuredAt,
    source: 'self-benchmark',
    suiteRevision: 3,
    scores,
    benchmarkMedianLatencyMsByAxis,
    fixtureCount: 6,
    failureCount: 0,
  }
}

function store(records = []) {
  const map = new Map(records.map((record) => [record.fingerprint, record]))
  return { async get(key) { return map.get(key) } }
}

function runtimeStore(records = {}) {
  return {
    maxAgeMs: 60 * 60 * 1000,
    minSamples: 2,
    get(key) { return records[key] },
  }
}

function row(preview, intent) {
  return preview.previews.find((item) => item.intent === intent)
}

test('routing settings preview covers exactly the five directly measured benchmark axes', () => {
  assert.deepEqual(VISION_ROUTING_PREVIEW_INTENTS, [
    'structured', 'ocr', 'document', 'grounding', 'general',
  ])
})

test('Quality may preview a conservative capability reorder while benchmark latency remains non-routing observation', async () => {
  const now = Date.now()
  const settings = config()
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings), config: settings, core: fakeCore(),
    store: store([
      profile('alpha', 'vision-a', now - DAY, { ocr: 0.70 }, { ocr: 400 }),
      profile('beta', 'vision-b', now - DAY, { ocr: 0.90 }, { ocr: 500 }),
    ]), now,
  })

  assert.equal(preview.diagnosticVersion, 3)
  assert.equal(preview.policy.measurementAgePolicy, 'informational-only')
  assert.equal(preview.policy.credentialAffectsCapabilityIdentity, false)
  assert.equal(preview.policy.benchmarkLatencyAffectsRouting, false)
  assert.equal(preview.policy.performanceSource, 'runtime-observation-only')
  assert.deepEqual(preview.policy.evidenceInvalidation, ['endpoint-identity', 'benchmark-suite'])
  assert.equal(preview.autoPreviewOnly, true)
  assert.equal(preview.executionActive, false)
  assert.equal(preview.healthIncluded, false)
  assert.deepEqual(preview.currentOrder, ['alpha/vision-a', 'beta/vision-b'])
  assert.deepEqual(preview.measuredBackends, ['alpha/vision-a', 'beta/vision-b'])

  const ocr = row(preview, 'ocr')
  assert.equal(ocr.first, 'beta/vision-b')
  assert.equal(ocr.reason, 'measured-advantage')
  assert.equal(ocr.diagnostics.candidates[0].benchmarkLatencyMs, 500)
  assert.equal(ocr.diagnostics.candidates[0].runtimeLatencyMs, null)
  assert.equal(ocr.diagnostics.candidates[0].runtimePerformanceObserved, false)
})

test('one-sided measurement never jumps across an unmeasured configured route', async () => {
  const now = Date.now()
  const settings = config()
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings), config: settings, core: fakeCore(),
    store: store([profile('beta', 'vision-b', now - DAY, { ocr: 1 }, { ocr: 50 })]), now,
  })
  const ocr = row(preview, 'ocr')
  assert.equal(ocr.first, 'alpha/vision-a')
  assert.equal(ocr.changed, false)
  assert.equal(ocr.reason, 'insufficient-comparable-evidence')
  assert.ok(ocr.incomparableBackends.includes('alpha/vision-a'))
})

test('measurement age does not remove otherwise valid capability evidence', async () => {
  const now = Date.now()
  const settings = config()
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings), config: settings, core: fakeCore(),
    store: store([
      profile('alpha', 'vision-a', now - 80 * DAY, { ocr: 0.10 }, { ocr: 1000 }),
      profile('beta', 'vision-b', now - 80 * DAY, { ocr: 1 }, { ocr: 50 }),
    ]), now,
  })
  const ocr = row(preview, 'ocr')
  assert.equal(ocr.first, 'beta/vision-b')
  assert.ok(ocr.diagnostics.candidates.every((item) => item.evidenceState === 'measured'))
  assert.ok(ocr.diagnostics.candidates.every((item) => item.ageMs >= 79 * DAY))
})

test('Balanced preserves configured order when only Benchmark latency exists', async () => {
  const now = Date.now()
  const settings = config({ routingPreference: 'balanced' })
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings), config: settings, core: fakeCore(),
    store: store([
      profile('alpha', 'vision-a', now, { ocr: 0.20 }, { ocr: 50 }),
      profile('beta', 'vision-b', now, { ocr: 1.00 }, { ocr: 9999 }),
    ]), now,
  })
  const ocr = row(preview, 'ocr')
  assert.deepEqual(ocr.order, ['alpha/vision-a', 'beta/vision-b'])
  assert.equal(ocr.reason, 'insufficient-comparable-evidence')
  assert.ok(ocr.diagnostics.candidates.every((item) => item.runtimePerformanceObserved === false))
})

test('one runtime sample is visible as warming evidence but still cannot drive Balanced', async () => {
  const now = Date.now()
  const settings = config({ routingPreference: 'balanced' })
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings), config: settings, core: fakeCore(),
    store: store([
      profile('alpha', 'vision-a', now, { ocr: 0.8 }),
      profile('beta', 'vision-b', now, { ocr: 0.8 }),
    ]),
    runtimePerformanceStore: runtimeStore({
      'alpha/vision-a': {
        runtimeLatencyMsByAxis: {}, observedLatencyMsByAxis: { ocr: 5000 },
        sampleCountByAxis: { ocr: 1 }, observedAtByAxis: { ocr: now }, maxAgeMs: 3600000, minSamples: 2,
      },
      'beta/vision-b': {
        runtimeLatencyMsByAxis: {}, observedLatencyMsByAxis: { ocr: 100 },
        sampleCountByAxis: { ocr: 1 }, observedAtByAxis: { ocr: now }, maxAgeMs: 3600000, minSamples: 2,
      },
    }),
    now,
  })
  const ocr = row(preview, 'ocr')
  assert.deepEqual(ocr.order, ['alpha/vision-a', 'beta/vision-b'])
  assert.ok(ocr.diagnostics.candidates.every((item) => item.runtimePerformanceObserved === true))
  assert.ok(ocr.diagnostics.candidates.every((item) => item.runtimePerformanceEligible === false))
  assert.ok(ocr.diagnostics.candidates.every((item) => item.runtimeSampleCount === 1))
})

test('two warmed same-axis runtime samples can make Balanced compare and reorder', async () => {
  const now = Date.now()
  const settings = config({ routingPreference: 'balanced' })
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings), config: settings, core: fakeCore(),
    store: store([
      profile('alpha', 'vision-a', now, { ocr: 0.8 }, { ocr: 10 }),
      profile('beta', 'vision-b', now, { ocr: 0.8 }, { ocr: 9999 }),
    ]),
    runtimePerformanceStore: runtimeStore({
      'alpha/vision-a': {
        runtimeLatencyMsByAxis: { ocr: 5000 }, observedLatencyMsByAxis: { ocr: 5000 },
        sampleCountByAxis: { ocr: 2 }, observedAtByAxis: { ocr: now }, maxAgeMs: 3600000, minSamples: 2,
      },
      'beta/vision-b': {
        runtimeLatencyMsByAxis: { ocr: 100 }, observedLatencyMsByAxis: { ocr: 100 },
        sampleCountByAxis: { ocr: 2 }, observedAtByAxis: { ocr: now }, maxAgeMs: 3600000, minSamples: 2,
      },
    }),
    now,
  })
  const ocr = row(preview, 'ocr')
  assert.deepEqual(ocr.order, ['beta/vision-b', 'alpha/vision-a'])
  assert.equal(ocr.reason, 'measured-advantage')
  assert.equal(preview.policy.runtimePerformanceMaxAgeMs, 3600000)
  assert.equal(preview.policy.runtimePerformanceMinSamples, 2)
  const beta = ocr.diagnostics.candidates.find((item) => item.backend === 'beta/vision-b')
  assert.equal(beta.runtimeLatencyMs, 100)
  assert.equal(beta.runtimeSampleCount, 2)
  assert.equal(beta.runtimePerformanceEligible, true)
  assert.equal(beta.benchmarkLatencyMs, 9999)
})

test('local preference may preview local-first as explicit user policy without inventing capability scores', async () => {
  const settings = config({ routingPreference: 'local' })
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings), config: settings,
    core: fakeCore([{ name: 'ollama', model: 'qwen-vl', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: '' }]),
    store: store(),
  })
  const general = row(preview, 'general')
  assert.equal(general.first, 'vision-http/ollama/qwen-vl')
  assert.equal(general.reason, 'local-preference')
  assert.deepEqual(preview.measuredBackends, [])
})