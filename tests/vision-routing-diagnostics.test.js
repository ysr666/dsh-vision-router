import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capabilityEvidenceFingerprint } from '../lib/vision-capability-identity.js'
import {
  buildVisionRoutingPreview,
  injectVisionRoutingDiagnosticsPrelude,
  VISION_ROUTING_DIAGNOSTICS_PRELUDE,
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
      registration() { return { adapter: { constructor: { name: 'FakeRegisteredAdapter' } } } },
      async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
    },
  }
}

function fakeCore(localProviders = [], httpProviders = []) {
  return {
    DEFAULT_HTTP_PROVIDERS: [],
    adapterAvailable: () => true,
    decideVisionBackendCapability: () => ({ image: true, attemptable: true }),
    localProvidersOf: () => localProviders,
    httpProvidersOf: () => httpProviders,
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
    maxAgeMs: 3_600_000,
    minSamples: 2,
    get(key) { return records[key] },
  }
}

function row(preview, intent) {
  return preview.previews.find((item) => item.intent === intent)
}

function candidate(item, backend) {
  return item.diagnostics.candidates.find((entry) => entry.backend === backend)
}

test('diagnostic v3 explains capability/performance/access separation and reports active Auto execution', async () => {
  const now = Date.now()
  const settings = config({ routingPreference: 'balanced' })
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings), config: settings, core: fakeCore(),
    store: store([
      profile('alpha', 'vision-a', now - DAY, { ocr: 0.80 }, { ocr: 800 }),
      profile('beta', 'vision-b', now - DAY, { ocr: 0.82 }, { ocr: 600 }),
    ]), now,
  })
  assert.equal(preview.diagnosticVersion, 3)
  assert.equal(preview.policy.preference, 'balanced')
  assert.match(preview.policy.formula, /runtime-speed/)
  assert.equal(preview.policy.minAdvantage, 0.08)
  assert.equal(preview.policy.measurementAgePolicy, 'informational-only')
  assert.equal(preview.policy.credentialAffectsCapabilityIdentity, false)
  assert.equal(preview.policy.benchmarkLatencyAffectsRouting, false)
  assert.equal(preview.policy.performanceSource, 'runtime-observation-only')
  assert.deepEqual(preview.policy.evidenceInvalidation, ['endpoint-identity', 'benchmark-suite'])
  assert.equal(preview.diagnosticReadOnly, true)
  assert.equal(preview.autoPreviewOnly, false)
  assert.equal(preview.executionActive, true)
  assert.equal(preview.executionScope, 'router-owned-visual-tools')
  assert.equal(preview.executionFailClosed, true)
  assert.equal(preview.healthIncluded, false)
  const ocr = row(preview, 'ocr')
  assert.equal(ocr.changed, false)
  assert.ok(ocr.diagnostics.candidates.every((entry) => entry.benchmarkLatencyMs !== null))
  assert.ok(ocr.diagnostics.candidates.every((entry) => entry.runtimeLatencyMs === null))
  assert.ok(ocr.diagnostics.candidates.every((entry) => entry.runtimePerformanceObserved === false))
})

test('runtime diagnostics expose warming sample count separately from routing eligibility', async () => {
  const now = Date.now()
  const settings = config({ routingPreference: 'speed' })
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings), config: settings, core: fakeCore(),
    store: store([
      profile('alpha', 'vision-a', now, { ocr: 0.8 }, { ocr: 20 }),
      profile('beta', 'vision-b', now, { ocr: 0.8 }, { ocr: 9000 }),
    ]),
    runtimePerformanceStore: runtimeStore({
      'alpha/vision-a': {
        runtimeLatencyMsByAxis: {}, observedLatencyMsByAxis: { ocr: 700 },
        sampleCountByAxis: { ocr: 1 }, observedAtByAxis: { ocr: now - 1000 }, maxAgeMs: 3_600_000, minSamples: 2,
      },
      'beta/vision-b': {
        runtimeLatencyMsByAxis: {}, observedLatencyMsByAxis: { ocr: 100 },
        sampleCountByAxis: { ocr: 1 }, observedAtByAxis: { ocr: now - 500 }, maxAgeMs: 3_600_000, minSamples: 2,
      },
    }),
    now,
  })
  const ocr = row(preview, 'ocr')
  assert.equal(ocr.changed, false)
  assert.equal(preview.policy.runtimePerformanceMaxAgeMs, 3_600_000)
  assert.equal(preview.policy.runtimePerformanceMinSamples, 2)
  const alpha = candidate(ocr, 'alpha/vision-a')
  assert.equal(alpha.runtimeObservedLatencyMs, 700)
  assert.equal(alpha.runtimeLatencyMs, null)
  assert.equal(alpha.runtimeSampleCount, 1)
  assert.equal(alpha.runtimeMinSamples, 2)
  assert.equal(alpha.runtimePerformanceObserved, true)
  assert.equal(alpha.runtimePerformanceEligible, false)
  assert.ok(alpha.runtimeAgeMs >= 1000)
})

test('warmed runtime diagnostics become routing-eligible without using Benchmark latency', async () => {
  const now = Date.now()
  const settings = config({ routingPreference: 'speed' })
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings), config: settings, core: fakeCore(),
    store: store([
      profile('alpha', 'vision-a', now, { ocr: 0.8 }, { ocr: 10 }),
      profile('beta', 'vision-b', now, { ocr: 0.8 }, { ocr: 9999 }),
    ]),
    runtimePerformanceStore: runtimeStore({
      'alpha/vision-a': {
        runtimeLatencyMsByAxis: { ocr: 5000 }, observedLatencyMsByAxis: { ocr: 5000 },
        sampleCountByAxis: { ocr: 2 }, observedAtByAxis: { ocr: now }, maxAgeMs: 3_600_000, minSamples: 2,
      },
      'beta/vision-b': {
        runtimeLatencyMsByAxis: { ocr: 100 }, observedLatencyMsByAxis: { ocr: 100 },
        sampleCountByAxis: { ocr: 2 }, observedAtByAxis: { ocr: now }, maxAgeMs: 3_600_000, minSamples: 2,
      },
    }),
    now,
  })
  const ocr = row(preview, 'ocr')
  assert.equal(ocr.first, 'beta/vision-b')
  const beta = candidate(ocr, 'beta/vision-b')
  assert.equal(beta.runtimeLatencyMs, 100)
  assert.equal(beta.runtimePerformanceEligible, true)
  assert.equal(beta.benchmarkLatencyMs, 9999)
  assert.ok(beta.speedScore > candidate(ocr, 'alpha/vision-a').speedScore)
})

test('small Quality differences remain auditable as below-threshold', async () => {
  const now = Date.now()
  const settings = config()
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings), config: settings, core: fakeCore(),
    store: store([
      profile('alpha', 'vision-a', now - DAY, { ocr: 0.84 }, { ocr: 400 }),
      profile('beta', 'vision-b', now - DAY, { ocr: 0.89 }, { ocr: 400 }),
    ]), now,
  })
  const ocr = row(preview, 'ocr')
  assert.equal(ocr.changed, false)
  assert.deepEqual(ocr.diagnostics.configuredPairChecks[0], {
    left: 'alpha/vision-a', right: 'beta/vision-b', outcome: 'below-threshold', threshold: 0.08,
    leftScore: 0.84, rightScore: 0.89, delta: 0.05,
  })
})

test('unmeasured configured routes expose the exact information barrier', async () => {
  const now = Date.now()
  const settings = config()
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings), config: settings, core: fakeCore(),
    store: store([profile('beta', 'vision-b', now - DAY, { ocr: 0.99 }, { ocr: 100 })]), now,
  })
  const ocr = row(preview, 'ocr')
  const alpha = candidate(ocr, 'alpha/vision-a')
  const beta = candidate(ocr, 'beta/vision-b')
  assert.equal(alpha.evidenceState, 'unmeasured')
  assert.equal(alpha.autoComparable, false)
  assert.equal(beta.evidenceState, 'measured')
  assert.equal(beta.measuredAxisScore, 0.99)
  assert.equal(beta.benchmarkLatencyMs, 100)
  assert.equal(beta.runtimeLatencyMs, null)
  assert.equal(ocr.diagnostics.configuredPairChecks[0].outcome, 'incomparable')
})

test('old capability measurements remain auditable and comparable under Quality', async () => {
  const now = Date.now()
  const settings = config()
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings), config: settings, core: fakeCore(),
    store: store([
      profile('alpha', 'vision-a', now - 365 * DAY, { ocr: 0.40 }, { ocr: 300 }),
      profile('beta', 'vision-b', now - 365 * DAY, { ocr: 0.95 }, { ocr: 200 }),
    ]), now,
  })
  const ocr = row(preview, 'ocr')
  assert.equal(candidate(ocr, 'alpha/vision-a').evidenceState, 'measured')
  assert.equal(candidate(ocr, 'beta/vision-b').effectiveCapability, 0.95)
  assert.ok(candidate(ocr, 'beta/vision-b').ageMs >= 364 * DAY)
  assert.equal(ocr.diagnostics.configuredPairChecks[0].outcome, 'measured-promotable')
  assert.equal(ocr.first, 'beta/vision-b')
})

test('local preference diagnostics show policy movement without pretending it is measured superiority', async () => {
  const settings = config({ routingPreference: 'local' })
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings), config: settings,
    core: fakeCore([{ name: 'ollama', model: 'qwen-vl', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: '' }]),
    store: store(),
  })
  const general = row(preview, 'general')
  assert.equal(general.first, 'vision-http/ollama/qwen-vl')
  assert.equal(general.reason, 'local-preference')
  assert.ok(general.diagnostics.configuredPairChecks.some((entry) => entry.outcome === 'local-policy-promotes-right'))
})

test('HTTP diagnostics use credential-independent capability identity without exposing endpoint or credential material', async () => {
  const now = Date.now()
  const httpBackend = {
    name: 'private-cloud', model: 'model-x', baseURL: 'https://private.example.invalid/v1', apiKeyEnv: 'VERY_SECRET_KEY_ENV',
  }
  const settings = config({
    providers: [{ provider: 'vision-http', model: 'private-cloud/model-x', fallbacks: [] }],
    httpProviders: [httpBackend],
  })
  const fingerprint = capabilityEvidenceFingerprint({
    provider: 'vision-http', model: 'private-cloud/model-x', endpoint: httpBackend.baseURL,
    config: { api: 'openai-completions' },
  })
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings), config: settings, core: fakeCore([], [httpBackend]),
    store: store([{
      fingerprint, provider: 'vision-http', model: 'private-cloud/model-x', measuredAt: now - DAY,
      source: 'self-benchmark', suiteRevision: 3, scores: { general: 0.75 },
      benchmarkMedianLatencyMsByAxis: { general: 700 }, fixtureCount: 1, failureCount: 0,
    }]), now,
  })
  const serialized = JSON.stringify(preview)
  assert.doesNotMatch(serialized, /private\.example\.invalid/)
  assert.doesNotMatch(serialized, /VERY_SECRET_KEY_ENV/)
  assert.doesNotMatch(serialized, /baseURL|apiKeyEnv|endpointConfig|credentialFingerprint/i)
  const entry = candidate(row(preview, 'general'), 'http:private-cloud/model-x')
  assert.equal(entry.measuredAxisScore, 0.75)
  assert.match(entry.endpointFingerprint, /^ep2_[0-9a-f]{32}$/)
})

test('diagnostics browser layer is GET-only, v3, copyable and explicit about benchmark/runtime separation', () => {
  const html = '<!doctype html><html><head></head><body></body></html>'
  const injected = injectVisionRoutingDiagnosticsPrelude(html)
  assert.match(injected, /data-vision-router-routing-diagnostics/)
  assert.equal(injectVisionRoutingDiagnosticsPrelude(injected), injected)
  assert.match(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /Auto验收诊断/)
  assert.match(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /复制JSON/)
  assert.match(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /navigator\.clipboard\.writeText/)
  assert.match(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /method:'GET'/)
  assert.doesNotMatch(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /method:'POST'/)
  assert.match(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /body\.diagnosticVersion!==3/)
  assert.match(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /Benchmark耗时不当作当前速度/)
  assert.match(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /凭据不定义能力身份/)
  assert.match(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /测评耗时/)
  assert.match(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /运行速度/)
  assert.match(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /预热/)
  assert.doesNotMatch(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /已陈旧|已过期|Stale|Expired|新鲜窗口/)
})