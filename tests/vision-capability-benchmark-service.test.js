import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createCapabilityBenchmarkManager,
  createExactCapabilityInvoker,
} from '../lib/vision-capability-benchmark-service.js'
import { capabilityBenchmarkFingerprint } from '../lib/vision-capability-benchmark.js'

function fakeCtx(settingsValue = {}) {
  return {
    get(name) {
      if (name === 'settings') return { get: () => settingsValue }
      return undefined
    },
    llm: {
      listProviders: () => [],
      async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
    },
  }
}

function fakeCore() {
  const local = {
    name: 'local-ollama',
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5vl',
    apiKeyEnv: '',
    maxTokens: 2048,
  }
  const http = {
    name: 'ovh-free',
    baseURL: 'https://example.test/v1',
    model: 'qwen3-vl',
    apiKeyEnv: '',
    maxTokens: 2048,
  }
  return {
    adapterAvailable: () => true,
    decideVisionBackendCapability: () => ({ image: true, attemptable: true }),
    localProvidersOf: () => [local],
    httpProvidersOf: () => [http],
    local,
    http,
  }
}

test('exact invoker sends one selected vision-http provider directly and never enters a fallback loop', async () => {
  const core = fakeCore()
  const candidate = {
    key: 'http:ovh-free/qwen3-vl',
    provider: 'vision-http',
    model: 'ovh-free/qwen3-vl',
    endpoint: core.http.baseURL,
  }
  const calls = []
  const invoke = createExactCapabilityInvoker(fakeCtx(), core, candidate, {}, {
    renderFixture: async () => Buffer.from('png'),
    callDirect: async (provider, messages, options) => {
      calls.push({ provider, messages, options })
      return 'exact answer'
    },
  })
  const backend = {
    provider: candidate.provider,
    model: candidate.model,
    endpoint: candidate.endpoint,
    config: { api: 'openai-completions' },
  }
  backend.fingerprint = capabilityBenchmarkFingerprint(backend)
  const result = await invoke({
    backend,
    fixture: { id: 'f', svg: '<svg/>', prompt: 'read it' },
    exactBackend: true,
    allowFallback: false,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, core.http)
  assert.equal(calls[0].messages.length, 1)
  assert.equal(calls[0].messages[0].content[0].type, 'image_url')
  assert.equal(result.output, 'exact answer')
  assert.equal(result.usedFingerprint, backend.fingerprint)
})

test('endpoint-backed registered provider benchmarks the resolved exact HTTP endpoint instead of detouring through the DSH adapter', async () => {
  const candidate = {
    key: 'zhipu-glm/glm-4.6v-flash',
    provider: 'zhipu-glm',
    model: 'glm-4.6v-flash',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    endpointConfig: { api: 'openai-completions' },
    endpointCredentialRef: 'ZHIPU_API_KEY',
    evidenceScope: 'endpoint',
  }
  const ctx = {
    get(name) {
      if (name === 'credentials') {
        return { async resolve(ref) { return ref === 'ZHIPU_API_KEY' ? { value: 'secret' } : undefined } }
      }
      return undefined
    },
    llm: {
      stream() {
        throw new Error('adapter path must not be used for endpoint-scoped evidence')
      },
    },
  }
  const calls = []
  const core = { localProvidersOf: () => [], httpProvidersOf: () => [] }
  const invoke = createExactCapabilityInvoker(ctx, core, candidate, {}, {
    renderFixture: async () => Buffer.from('png'),
    callDirect: async (provider, messages, options) => {
      calls.push({ provider, messages, options })
      assert.equal(await options.resolveCredential(provider.apiKeyEnv), 'secret')
      return 'zhipu exact answer'
    },
  })
  const backend = {
    provider: candidate.provider,
    model: candidate.model,
    endpoint: candidate.endpoint,
    config: candidate.endpointConfig,
  }
  backend.fingerprint = capabilityBenchmarkFingerprint(backend)
  const result = await invoke({
    backend,
    fixture: { id: 'zhipu', svg: '<svg/>', prompt: 'describe' },
    exactBackend: true,
    allowFallback: false,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider.name, 'zhipu-glm')
  assert.equal(calls[0].provider.baseURL, candidate.endpoint)
  assert.equal(calls[0].provider.model, candidate.model)
  assert.equal(calls[0].provider.apiKeyEnv, 'ZHIPU_API_KEY')
  assert.equal(calls[0].messages[0].content[0].type, 'image_url')
  assert.equal(result.output, 'zhipu exact answer')
  assert.equal(result.usedFingerprint, backend.fingerprint)
})

test('exact adapter benchmark awaits Promise<AsyncIterable> from llm.stream', async () => {
  const ctx = {
    get(name) {
      if (name === 'attachments') {
        return {
          async saveImage() {
            return { attachmentId: 'synthetic-fixture', mediaType: 'image/png', name: 'fixture.png' }
          },
        }
      }
      return undefined
    },
  }
  const core = { localProvidersOf: () => [], httpProvidersOf: () => [] }
  const candidate = { provider: 'custom-provider', model: 'vision-model' }
  const calls = []
  const invoke = createExactCapabilityInvoker(ctx, core, candidate, {}, {
    renderFixture: async () => Buffer.from('png'),
    streamExact: async (options) => {
      calls.push(options)
      return (async function* () {
        yield { type: 'text', text: 'hello ' }
        yield { type: 'text', text: 'vision' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  })
  const backend = {
    provider: candidate.provider,
    model: candidate.model,
    endpoint: 'https://adapter.example/v1',
    config: { api: 'openai-completions' },
  }
  backend.fingerprint = capabilityBenchmarkFingerprint(backend)
  const result = await invoke({
    backend,
    fixture: { id: 'adapter', svg: '<svg/>', prompt: 'describe' },
    exactBackend: true,
    allowFallback: false,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'custom-provider')
  assert.equal(calls[0].model, 'vision-model')
  assert.equal(calls[0].messages[0].content[0].type, 'image')
  assert.equal(result.output, 'hello vision')
  assert.equal(result.usedFingerprint, backend.fingerprint)
})

test('generated fixture rendering works when the core namespace has no loadSharp export', async () => {
  let savedPng
  const ctx = {
    get(name) {
      if (name === 'attachments') {
        return {
          async saveImage(value) {
            savedPng = value?.data
            return { attachmentId: 'generated-fixture', mediaType: 'image/png', name: 'fixture.png' }
          },
        }
      }
      return undefined
    },
  }
  const core = { localProvidersOf: () => [], httpProvidersOf: () => [] }
  const candidate = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const invoke = createExactCapabilityInvoker(ctx, core, candidate, {}, {
    streamExact: async () => (async function* () {
      yield { type: 'text', text: 'fixture rendered' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  })
  const backend = {
    provider: candidate.provider,
    model: candidate.model,
    endpoint: 'dsh-adapter://deepseek-official',
    config: { route: 'registered-adapter', provider: candidate.provider },
  }
  backend.fingerprint = capabilityBenchmarkFingerprint(backend)
  const result = await invoke({
    backend,
    fixture: {
      id: 'render-regression',
      prompt: 'describe',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="white"/><text x="2" y="16">VR</text></svg>',
    },
    exactBackend: true,
    allowFallback: false,
  })
  assert.ok(Buffer.isBuffer(savedPng))
  assert.deepEqual([...savedPng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(result.output, 'fixture rendered')
})

test('exact invoker rejects a caller that tries to enable fallback semantics', async () => {
  const core = fakeCore()
  const invoke = createExactCapabilityInvoker(fakeCtx(), core, {
    provider: 'vision-http',
    model: 'ovh-free/qwen3-vl',
  }, {}, {
    renderFixture: async () => Buffer.from('png'),
    callDirect: async () => 'should not run',
  })
  await assert.rejects(
    invoke({ backend: { fingerprint: 'ep2_x' }, fixture: {}, exactBackend: false, allowFallback: true }),
    /refuses non-exact\/fallback/,
  )
})

test('manager lists benchmarkable endpoints without exposing endpoint or credential routing details', async () => {
  const config = { providers: [] }
  const ctx = fakeCtx(config)
  const core = fakeCore()
  const store = { async get() { return undefined }, async put(record) { return record } }
  const manager = createCapabilityBenchmarkManager(ctx, config, core, { store })
  const snapshot = await manager.snapshot()
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.candidates.length, 2)
  assert.ok(snapshot.candidates.every((candidate) => candidate.benchmarkable === true))
  assert.ok(snapshot.candidates.every((candidate) => !('endpoint' in candidate)))
  assert.ok(snapshot.candidates.every((candidate) => !('endpointCredentialRef' in candidate)))
  assert.ok(snapshot.candidates.every((candidate) => /^ep2_[0-9a-f]{32}$/.test(candidate.fingerprint)))
})

test('manager persists only a result whose fingerprint still matches the selected endpoint', async () => {
  const config = { providers: [] }
  const ctx = fakeCtx(config)
  const core = fakeCore()
  const persisted = []
  const store = {
    async get() { return undefined },
    async put(record) { persisted.push(record); return record },
  }
  const expected = capabilityBenchmarkFingerprint({
    provider: 'vision-http',
    model: 'local-ollama/qwen2.5vl',
    endpoint: core.local.baseURL,
    config: { api: 'openai-completions' },
  })
  const manager = createCapabilityBenchmarkManager(ctx, config, core, {
    store,
    runBenchmark: async ({ backend }) => ({
      record: {
        fingerprint: capabilityBenchmarkFingerprint(backend),
        provider: backend.provider,
        model: backend.model,
        measuredAt: 123,
        source: 'self-benchmark',
        scores: { general: 0.9 },
        medianLatencyMs: { general: 100 },
        latencyMs: 100,
        fixtureCount: 1,
        failureCount: 0,
      },
      results: [],
    }),
    renderFixture: async () => Buffer.from('png'),
    callDirect: async () => 'unused',
  })
  const result = await manager.run('vision-http/local-ollama/qwen2.5vl', ['general'])
  assert.equal(result.ok, true)
  assert.equal(result.record.fingerprint, expected)
  assert.equal(persisted.length, 1)
})

test('manager rejects all-failure runs and removes stale zero-score evidence instead of persisting it', async () => {
  const config = { providers: [] }
  const ctx = fakeCtx(config)
  const core = fakeCore()
  let writes = 0
  const removed = []
  const manager = createCapabilityBenchmarkManager(ctx, config, core, {
    store: {
      async get() { return undefined },
      async put(record) { writes += 1; return record },
      async remove(fingerprint) { removed.push(fingerprint); return true },
    },
    runBenchmark: async ({ backend }) => ({
      record: {
        fingerprint: capabilityBenchmarkFingerprint(backend),
        provider: backend.provider,
        model: backend.model,
        measuredAt: 123,
        source: 'self-benchmark',
        scores: { structured: 0, general: 0 },
        medianLatencyMs: { structured: 0, general: 0 },
        latencyMs: 0,
        fixtureCount: 2,
        failureCount: 2,
      },
      results: [
        { fixture: 'a', intent: 'structured', score: 0, details: { error: 'sharp renderer is unavailable' } },
        { fixture: 'b', intent: 'general', score: 0, details: { error: 'sharp renderer is unavailable' } },
      ],
    }),
  })
  await assert.rejects(
    manager.run('vision-http/local-ollama/qwen2.5vl'),
    (error) => error?.code === 'CAPABILITY_BENCHMARK_NO_USABLE_EVIDENCE' && /sharp renderer/.test(error.message),
  )
  assert.equal(writes, 0)
  assert.equal(removed.length, 1)
  assert.match(removed[0], /^ep2_[0-9a-f]{32}$/)
})

test('manager refuses to persist a stale/mismatched endpoint result', async () => {
  const config = { providers: [] }
  const ctx = fakeCtx(config)
  const core = fakeCore()
  let writes = 0
  const manager = createCapabilityBenchmarkManager(ctx, config, core, {
    store: { async get() { return undefined }, async put(record) { writes += 1; return record } },
    runBenchmark: async () => ({
      record: {
        fingerprint: 'ep2_00000000000000000000000000000000',
        scores: { general: 1 },
      },
      results: [],
    }),
  })
  await assert.rejects(
    manager.run('http:ovh-free/qwen3-vl', ['general']),
    (error) => error?.code === 'CAPABILITY_BENCHMARK_FINGERPRINT_CHANGED',
  )
  assert.equal(writes, 0)
})
