import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectVisionRoutingCandidates,
  collectVisionRoutingEvidence,
  generatedCapabilityRoute,
} from '../lib/vision-routing-evidence.js'

const OVH = {
  name: 'ovh-free',
  baseURL: 'https://example.test/v1',
  model: 'qwen3-vl',
  apiKeyEnv: '',
}

const PAID = {
  name: 'paid-cloud',
  baseURL: 'https://paid.example.test/v1',
  model: 'vision-pro',
  apiKeyEnv: 'PAID_KEY',
}

function coreFixture() {
  return {
    DEFAULT_HTTP_PROVIDERS: [OVH],
    adapterAvailable: () => true,
    decideVisionBackendCapability: () => ({ image: true, attemptable: true }),
    localProvidersOf: () => [{
      name: 'local-ollama',
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5vl',
      apiKeyEnv: '',
    }],
    httpProvidersOf: () => [OVH, PAID],
  }
}

function ctxFixture() {
  return {
    get() { return undefined },
    llm: {
      registration(provider) {
        return { adapter: { constructor: { name: `Adapter_${provider}` } } }
      },
      async resolveModelInfo() {
        return { inputModalities: ['text', 'image'] }
      },
    },
  }
}

function storeFixture() {
  return {
    async get() {
      return {
        scores: { general: 0.75, ocr: 0.9 },
        measuredAt: 1_700_000_000_000,
        measuredAtByAxis: { general: 1_700_000_000_001, ocr: 1_700_000_000_002 },
        benchmarkLatencyMs: 321,
        benchmarkMedianLatencyMsByAxis: { general: 300, ocr: 340 },
      }
    },
  }
}

function runtimeFixture() {
  return {
    get(key) {
      return {
        runtimeLatencyMsByAxis: { general: key.includes('local') ? 40 : 80 },
        observedLatencyMsByAxis: { general: 75 },
        sampleCountByAxis: { general: 4 },
        observedAtByAxis: { general: 1_700_000_100_000 },
        maxAgeMs: 60_000,
        minSamples: 3,
      }
    },
  }
}

const config = {
  wrapperRoute: 'deepseek-vision',
  chainRoute: 'vision-chain',
  providers: [
    { provider: 'custom', model: 'chosen', fallbacks: ['fallback'] },
    { provider: 'vision-http', model: 'local-ollama/qwen2.5vl', fallbacks: [] },
  ],
  httpProviders: [PAID],
}

test('P1 evidence collector preserves the frozen candidate order, roles and endpoint identity contract', async () => {
  const rows = await collectVisionRoutingCandidates(
    ctxFixture(),
    config,
    coreFixture(),
    storeFixture(),
    runtimeFixture(),
  )

  assert.deepEqual(rows.map((candidate) => candidate.key), [
    'custom/chosen',
    'custom/fallback',
    'vision-http/local-ollama/qwen2.5vl',
    'http:ovh-free/qwen3-vl',
    'http:paid-cloud/vision-pro',
  ])
  assert.deepEqual(rows.map((candidate) => candidate.routeRole), [
    'user',
    'user',
    'user',
    'fallback-only',
    'user',
  ])
  assert.ok(rows.every((candidate) => candidate.benchmarkable === true))
  assert.ok(rows.every((candidate) => /^ep2_[0-9a-f]{32}$/.test(candidate.endpointFingerprint)))
})

test('P1 evidence boundary returns facts only and contains health failures as uncertainty', async () => {
  const seen = []
  const evidence = await collectVisionRoutingEvidence({
    ctx: ctxFixture(),
    config,
    core: coreFixture(),
    store: storeFixture(),
    runtimePerformanceStore: runtimeFixture(),
    healthForCandidate(candidate) {
      seen.push(candidate.key)
      if (candidate.key === 'custom/fallback') throw new Error('health unavailable')
      return { state: candidate.local ? 'local' : 'ready' }
    },
    healthContext: { source: 'parity-test' },
  })

  assert.ok(evidence.candidates.length > 0)
  assert.deepEqual(Object.keys(evidence.measured), evidence.candidates.map((candidate) => candidate.key))
  assert.deepEqual(seen, evidence.candidates.map((candidate) => candidate.key))
  assert.equal(Object.hasOwn(evidence.health, 'custom/fallback'), false)
  assert.equal(evidence.health['custom/chosen'].state, 'ready')
  assert.equal(evidence.health['vision-http/local-ollama/qwen2.5vl'].state, 'local')
  assert.deepEqual(Object.keys(evidence).sort(), ['candidates', 'health', 'measured'])
})

test('generated Router routes keep the frozen filtering contract', () => {
  for (const [provider, cfg, expected] of [
    ['deepseek-vision', {}, true],
    ['vision-chain', {}, true],
    ['custom-vision', {}, false],
    ['my-wrapper', { wrapperRoute: 'my-wrapper', chainRoute: 'my-chain' }, true],
    ['my-chain', { wrapperRoute: 'my-wrapper', chainRoute: 'my-chain' }, true],
  ]) {
    assert.equal(generatedCapabilityRoute(provider, cfg), expected)
  }
})
