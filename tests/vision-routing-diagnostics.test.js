import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capabilityBenchmarkFingerprint } from '../lib/vision-capability-benchmark.js'
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

function candidate(item, backend) {
  return item.diagnostics.candidates.find((entry) => entry.backend === backend)
}

test('diagnostic payload explains the active product policy and remains preview-only', async () => {
  const now = Date.now()
  const settings = config({ routingPreference: 'balanced' })
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings),
    config: settings,
    core: fakeCore(),
    store: store([
      profile('alpha', 'vision-a', now - DAY, { ocr: 0.80 }, { ocr: 800 }),
      profile('beta', 'vision-b', now - DAY, { ocr: 0.82 }, { ocr: 600 }),
    ]),
    now,
  })

  assert.equal(preview.diagnosticVersion, 1)
  assert.equal(preview.policy.preference, 'balanced')
  assert.equal(preview.policy.formula, '0.80*capability + 0.20*speed')
  assert.equal(preview.policy.minAdvantage, 0.08)
  assert.equal(preview.policy.configuredOrderIsBaseline, true)
  assert.equal(preview.autoPreviewOnly, true)
  assert.equal(preview.executionActive, false)
  assert.equal(preview.healthIncluded, false)
})

test('small measured differences are auditable as below-threshold instead of vague keep-order text', async () => {
  const now = Date.now()
  const settings = config()
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings),
    config: settings,
    core: fakeCore(),
    store: store([
      profile('alpha', 'vision-a', now - DAY, { ocr: 0.84 }, { ocr: 400 }),
      profile('beta', 'vision-b', now - DAY, { ocr: 0.89 }, { ocr: 400 }),
    ]),
    now,
  })

  const ocr = row(preview, 'ocr')
  assert.equal(ocr.changed, false)
  assert.equal(ocr.first, 'alpha/vision-a')
  assert.equal(ocr.diagnostics.configuredPairChecks.length, 1)
  assert.deepEqual(ocr.diagnostics.configuredPairChecks[0], {
    left: 'alpha/vision-a',
    right: 'beta/vision-b',
    outcome: 'below-threshold',
    threshold: 0.08,
    leftScore: 0.84,
    rightScore: 0.89,
    delta: 0.05,
  })
})

test('unmeasured configured routes expose the exact information barrier and candidate evidence state', async () => {
  const now = Date.now()
  const settings = config()
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings),
    config: settings,
    core: fakeCore(),
    store: store([
      profile('beta', 'vision-b', now - DAY, { ocr: 0.99 }, { ocr: 100 }),
    ]),
    now,
  })

  const ocr = row(preview, 'ocr')
  const alpha = candidate(ocr, 'alpha/vision-a')
  const beta = candidate(ocr, 'beta/vision-b')
  assert.equal(alpha.evidenceState, 'unmeasured')
  assert.equal(alpha.autoComparable, false)
  assert.equal(beta.evidenceState, 'fresh-measured')
  assert.equal(beta.measuredAxisScore, 0.99)
  assert.equal(ocr.diagnostics.configuredPairChecks[0].outcome, 'incomparable')
  assert.deepEqual(ocr.diagnostics.configuredPairChecks[0].missing, ['alpha/vision-a'])
})

test('stale retained profiles are visible to humans but remain excluded from Auto comparison', async () => {
  const now = Date.now()
  const settings = config()
  const preview = await buildVisionRoutingPreview({
    ctx: fakeCtx(settings),
    config: settings,
    core: fakeCore(),
    store: store([
      profile('alpha', 'vision-a', now - 8 * DAY, { ocr: 0.40 }, { ocr: 300 }),
      profile('beta', 'vision-b', now - 8 * DAY, { ocr: 0.95 }, { ocr: 200 }),
    ]),
    now,
  })

  const ocr = row(preview, 'ocr')
  assert.deepEqual(preview.freshMeasuredBackends, [])
  assert.equal(candidate(ocr, 'alpha/vision-a').evidenceState, 'stale')
  assert.equal(candidate(ocr, 'beta/vision-b').evidenceState, 'stale')
  assert.equal(candidate(ocr, 'beta/vision-b').measuredAxisScore, 0.95)
  assert.equal(candidate(ocr, 'beta/vision-b').effectiveCapability, null)
  assert.equal(ocr.diagnostics.configuredPairChecks[0].outcome, 'incomparable')
})

test('local preference diagnostics show policy movement without pretending it is measured superiority', async () => {
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
  assert.equal(general.reason, 'local-preference')
  assert.ok(general.diagnostics.candidates.some((entry) => entry.backend === 'vision-http/ollama/qwen-vl' && entry.local === true))
  assert.ok(general.diagnostics.configuredPairChecks.some((entry) => entry.outcome === 'local-policy-promotes-right'))
})

test('diagnostics browser layer is GET-only, copyable, refreshable and benchmark-aware', () => {
  const html = '<!doctype html><html><head></head><body></body></html>'
  const injected = injectVisionRoutingDiagnosticsPrelude(html)
  assert.match(injected, /data-vision-router-routing-diagnostics/)
  assert.equal(injectVisionRoutingDiagnosticsPrelude(injected), injected)
  assert.match(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /Auto验收诊断/)
  assert.match(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /刷新诊断/)
  assert.match(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /复制JSON/)
  assert.match(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /navigator\.clipboard\.writeText/)
  assert.match(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /method:'GET'/)
  assert.doesNotMatch(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /method:'POST'/)
  assert.match(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /data-vr-capability-control/)
  assert.match(VISION_ROUTING_DIAGNOSTICS_PRELUDE, /data-job-id/)
})
