import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runV2ProviderAcceptance,
  runV2SafeAcceptance,
} from '../lib/v2-acceptance-service.js'
import {
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
      for (const provider of providers) adapters.set(provider, adapter)
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

test('provider J0a acceptance requires a second explicit grant for chargeable cloud candidates', async () => {
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

test('acceptance CLI requires explicit safe consent and provider flags compose monotonically', () => {
  assert.equal(parseAcceptanceArgs(['--accept-safe-mutations']).acceptedSafeMutations, true)
  assert.throws(() => parseAcceptanceArgs(['--accept-safe-mutations', '--provider', 'x/y']), /allow-provider-requests/)
  const options = parseAcceptanceArgs([
    '--accept-safe-mutations',
    '--provider', 'http:cloud/model',
    '--allow-provider-requests',
    '--allow-chargeable-cloud',
    '--mode', 'full',
  ])
  assert.equal(options.provider, 'http:cloud/model')
  assert.equal(options.acceptedProviderRequests, true)
  assert.equal(options.acceptedChargeableCloud, true)
  assert.equal(options.mode, 'full')
})

test('public acceptance surface scanner allows fingerprints but rejects secrets and raw URLs', () => {
  assert.deepEqual(inspectPublicSurfacePayload({ endpointFingerprint: 'ep2_0123456789abcdef0123456789abcdef' }), [])
  assert.ok(inspectPublicSurfacePayload({ apiKeyEnv: 'SECRET_ENV' }).length > 0)
  assert.ok(inspectPublicSurfacePayload({ error: 'Bearer abcdefghijklmnopqrstuvwxyz' }).length > 0)
  assert.ok(inspectPublicSurfacePayload({ endpoint: 'https://example.test/v1' }).length > 0)
})
