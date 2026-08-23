import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runV2ProviderAcceptance,
  runV2SafeAcceptance,
} from '../lib/v2-acceptance-service.js'
import {
  inspectProviderEvidence,
  inspectPublicSurfacePayload,
  parseAcceptanceArgs,
} from '../lib/v2-acceptance-cli.js'
import {
  contextWithVisionRuntimePerformance,
  createVisionRuntimePerformanceStore,
} from '../lib/vision-runtime-performance.js'
import { resolveVisionRoutingAuthority } from '../lib/vision-routing-authority.js'

function createSettings(user = {}) {
  const base = {
    routingMode: 'ordered',
    routingPreference: 'balanced',
    backgroundBenchmarking: 'off',
  }
  let revision = 1
  const userLayer = structuredClone(user)
  const value = () => ({ ...base, ...userLayer })
  return {
    writable: true,
    get(ns) { return ns === 'vision-router' ? value() : undefined },
    describe() {
      return [{
        ns: 'vision-router',
        value: value(),
        base: structuredClone(base),
        user: structuredClone(userLayer),
        revision,
        applies: true,
      }]
    },
    async mutate(ns, ops, expectedRevision) {
      assert.equal(ns, 'vision-router')
      assert.equal(expectedRevision, revision)
      for (const op of ops) {
        const field = op.path?.[0]
        if (op.op === 'unset') delete userLayer[field]
        else userLayer[field] = structuredClone(op.value)
      }
      revision += 1
    },
    user() { return structuredClone(userLayer) },
  }
}

function createLlm() {
  const adapters = new Map()
  return {
    registerAdapter(providers, adapter) {
      // Mirror the released DSH adapter registration contract closely enough
      // that J0a cannot go green with a duck-typed adapter the real Host rejects.
      assert.equal(typeof adapter?.providerInfo, 'function')
      assert.equal(typeof adapter?.providerRetryPolicy, 'function')
      assert.equal(typeof adapter?.listModels, 'function')
      assert.equal(typeof adapter?.resolveModel, 'function')
      assert.equal(typeof adapter?.stream, 'function')
      for (const provider of providers) {
        const info = adapter.providerInfo(provider)
        assert.equal(info?.id, provider)
        adapters.set(provider, adapter)
      }
      return () => {
        for (const provider of providers) if (adapters.get(provider) === adapter) adapters.delete(provider)
      }
    },
    registration(provider) {
      const adapter = adapters.get(provider)
      return adapter ? { adapter } : undefined
    },
    listProviders() { return [] },
    async resolveModelInfo(provider, model) {
      const adapter = adapters.get(provider)
      return adapter?.resolveModel ? adapter.resolveModel(provider, model) : undefined
    },
    stream(options) {
      const adapter = adapters.get(options.provider)
      if (!adapter) throw new Error(`missing fake adapter ${options.provider}`)
      return adapter.stream(options)
    },
  }
}

function createRuntime(user = {}) {
  const settings = createSettings(user)
  const base = {
    get(name) { if (name === 'settings') return settings; return undefined },
    llm: createLlm(),
  }
  const store = createVisionRuntimePerformanceStore({ minSamples: 2 })
  const observed = contextWithVisionRuntimePerformance(base, store, {
    observationAllowed: () => resolveVisionRoutingAuthority(settings.get('vision-router')).ephemeralRuntimeObservation,
  })
  const profiler = {
    tickCalls: 0,
    snapshot() {
      return {
        stopped: false,
        activeForeground: 0,
        activeManualBenchmarks: 0,
        running: undefined,
        backoffSize: 0,
      }
    },
    async tick() { this.tickCalls += 1 },
  }
  const benchmarkManager = {
    async run(_key, _intents, _signal, authority) {
      if (!authority) {
        const error = new Error('explicit manual measurement authority is required')
        error.code = 'CAPABILITY_BENCHMARK_AUTHORITY_REQUIRED'
        throw error
      }
      throw new Error('unexpected authorized run')
    },
  }
  return { settings, runtimeCtx: observed, store, profiler, benchmarkManager }
}

test('safe J0a acceptance runs inside the live wrappers and restores exact user-layer authority state', async () => {
  const runtime = createRuntime({ routingMode: 'auto' })
  const before = runtime.settings.user()
  const report = await runV2SafeAcceptance({
    runtimeCtx: runtime.runtimeCtx,
    runtimePerformanceStore: runtime.store,
    backgroundProfiler: runtime.profiler,
    benchmarkManager: runtime.benchmarkManager,
    acceptedSafeMutations: true,
  })
  assert.equal(report.ok, true)
  assert.equal(report.providerRequestsMade, 0)
  assert.equal(report.providerRequestsAuthorized, false)
  assert.deepEqual(runtime.settings.user(), before)
  assert.equal(runtime.profiler.tickCalls, 1)
  const byId = new Map(report.cases.map((entry) => [entry.id, entry]))
  for (const id of ['A01', 'A02', 'A02-runtime', 'A06', 'A07-1', 'A07-2', 'A08', 'A09', 'L00', 'R00']) {
    assert.equal(byId.get(id)?.status, 'pass', `${id} should pass`)
  }
  assert.equal(runtime.store.size(), 0, 'ephemeral acceptance adapter evidence is cleaned up')
})

test('safe J0a acceptance refuses to mutate settings without explicit consent', async () => {
  const runtime = createRuntime()
  await assert.rejects(
    runV2SafeAcceptance({
      runtimeCtx: runtime.runtimeCtx,
      runtimePerformanceStore: runtime.store,
      backgroundProfiler: runtime.profiler,
      benchmarkManager: runtime.benchmarkManager,
      acceptedSafeMutations: false,
    }),
    (error) => error?.code === 'V2_ACCEPTANCE_CONSENT_REQUIRED',
  )
  assert.deepEqual(runtime.settings.user(), {})
})

test('provider J0b acceptance requires a second explicit grant for chargeable cloud candidates', async () => {
  const candidate = {
    key: 'http:cloud/model',
    provider: 'vision-http',
    model: 'cloud/model',
    local: false,
    cloudCostWarning: true,
    benchmarkable: true,
  }
  const manager = {
    jobs: [],
    async snapshot() { return { candidates: [candidate], jobs: this.jobs } },
    async enqueue(key, mode, force, authority) {
      assert.ok(authority)
      const job = { id: 'j1', key, mode, state: 'running' }
      this.jobs = [job]
      return { ok: true, queued: true, job }
    },
    async waitForIdle() { this.jobs = this.jobs.map((job) => ({ ...job, state: 'completed' })) },
  }
  await assert.rejects(
    runV2ProviderAcceptance({
      benchmarkManager: manager,
      runtimePerformanceStore: { get: () => undefined },
      key: candidate.key,
      acceptedProviderRequests: true,
      acceptedChargeableCloud: false,
    }),
    (error) => error?.code === 'V2_ACCEPTANCE_CHARGEABLE_CONSENT_REQUIRED',
  )
  assert.equal(manager.jobs.length, 0)

  const report = await runV2ProviderAcceptance({
    benchmarkManager: manager,
    runtimePerformanceStore: { get: () => undefined },
    key: candidate.key,
    acceptedProviderRequests: true,
    acceptedChargeableCloud: true,
  })
  assert.equal(report.ok, true)
  assert.equal(report.chargeableCloudAuthorized, true)
})

test('acceptance CLI keeps J0a mutation authority independent from J0b provider authority', () => {
  assert.equal(parseAcceptanceArgs(['--accept-safe-mutations']).acceptedSafeMutations, true)
  assert.throws(() => parseAcceptanceArgs(['--provider', 'x/y']), /allow-provider-requests/)

  const providerOnly = parseAcceptanceArgs([
    '--provider', 'http:cloud/model',
    '--allow-provider-requests',
    '--allow-chargeable-cloud',
    '--mode', 'full',
  ])
  assert.equal(providerOnly.acceptedSafeMutations, false)
  assert.equal(providerOnly.provider, 'http:cloud/model')
  assert.equal(providerOnly.acceptedProviderRequests, true)
  assert.equal(providerOnly.acceptedChargeableCloud, true)
  assert.equal(providerOnly.mode, 'full')

  const list = parseAcceptanceArgs(['--list-candidates'])
  assert.equal(list.listCandidates, true)
  assert.equal(list.acceptedSafeMutations, false)
  assert.throws(() => parseAcceptanceArgs(['--list-candidates', '--accept-safe-mutations']), /read-only/)
})

test('J0b evidence inspection proves exact identity, fresh requested axes, and preserves unrelated axes', () => {
  const key = 'vision-http/local/model'
  const fingerprint = 'ep2_0123456789abcdef0123456789abcdef'
  const beforeSnapshot = {
    suiteRevision: 3,
    candidates: [{
      key,
      provider: 'vision-http',
      model: 'local/model',
      fingerprint,
      measured: {
        suiteRevision: 3,
        scores: { document: 0.75 },
        measuredAtByAxis: { document: 1000 },
        benchmarkMedianLatencyMs: { document: 55 },
        fixtureCountByAxis: { document: 1 },
        measuredAxes: ['document'],
      },
    }],
  }
  const afterSnapshot = {
    suiteRevision: 3,
    candidates: [{
      key,
      provider: 'vision-http',
      model: 'local/model',
      fingerprint,
      measured: {
        suiteRevision: 3,
        scores: { document: 0.75, ocr: 0.9, general: 0.8 },
        measuredAtByAxis: { document: 1000, ocr: 10050, general: 10060 },
        benchmarkMedianLatencyMs: { document: 55, ocr: 100, general: 120 },
        fixtureCountByAxis: { document: 1, ocr: 2, general: 1 },
        measuredAxes: ['ocr', 'document', 'general'],
      },
    }],
  }
  const providerReport = {
    ok: true,
    candidate: { key, provider: 'vision-http', model: 'local/model' },
  }
  const result = inspectProviderEvidence({
    beforeSnapshot,
    afterSnapshot,
    providerReport,
    key,
    mode: 'quick',
    startedAt: 10000,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.cases.map((entry) => [entry.id, entry.status]), [
    ['J0B-exact-identity', 'pass'],
    ['J0B-capability-evidence', 'pass'],
    ['J0B-axis-scope', 'pass'],
  ])
})

test('J0b evidence inspection catches identity drift and failed runs must preserve old evidence', () => {
  const key = 'vision-http/cloud/model'
  const before = {
    suiteRevision: 3,
    candidates: [{
      key,
      provider: 'vision-http',
      model: 'cloud/model',
      fingerprint: 'ep2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      measured: { suiteRevision: 3, scores: { ocr: 0.5 }, measuredAtByAxis: { ocr: 100 }, measuredAxes: ['ocr'] },
    }],
  }
  const after = structuredClone(before)
  after.candidates[0].fingerprint = 'ep2_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const failed = inspectProviderEvidence({
    beforeSnapshot: before,
    afterSnapshot: after,
    providerReport: { ok: false, candidate: { key, provider: 'vision-http', model: 'cloud/model' } },
    key,
    mode: 'quick',
    startedAt: 1000,
  })
  const byId = new Map(failed.cases.map((entry) => [entry.id, entry]))
  assert.equal(byId.get('J0B-exact-identity')?.status, 'fail')
  assert.equal(byId.get('J0B-failure-preserves-evidence')?.status, 'pass')
  assert.equal(failed.ok, false)
})

test('public acceptance surface scanner allows fingerprints but rejects secrets and raw URLs', () => {
  assert.deepEqual(inspectPublicSurfacePayload({ endpointFingerprint: 'ep2_0123456789abcdef0123456789abcdef' }), [])
  assert.ok(inspectPublicSurfacePayload({ apiKeyEnv: 'SECRET_ENV' }).length > 0)
  assert.ok(inspectPublicSurfacePayload({ error: 'Bearer abcdefghijklmnopqrstuvwxyz' }).length > 0)
  assert.ok(inspectPublicSurfacePayload({ endpoint: 'https://example.test/v1' }).length > 0)
})
