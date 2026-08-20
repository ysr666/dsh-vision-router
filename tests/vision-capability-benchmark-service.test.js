import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPABILITY_BENCHMARK_MODE_REQUESTS,
  classifyCapabilityBenchmarkFailure,
  createCapabilityBenchmarkManager,
  createExactCapabilityInvoker,
} from '../lib/vision-capability-benchmark-service.js'
import { capabilityBenchmarkFingerprint } from '../lib/vision-capability-benchmark.js'

function fakeCtx(settingsValue = {}, image = true) {
  return {
    get(name) {
      if (name === 'settings') return { get: () => settingsValue }
      return undefined
    },
    llm: {
      listProviders: () => [],
      registration() { return { adapter: { constructor: { name: 'FakeAdapter' } } } },
      async resolveModelInfo() { return { inputModalities: image ? ['text', 'image'] : ['text'] } },
    },
  }
}

function fakeCore(image = true) {
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
    decideVisionBackendCapability: () => ({ image, attemptable: true }),
    localProvidersOf: () => [local],
    httpProvidersOf: () => [http],
    local,
    http,
  }
}

function memoryStore(initial = []) {
  const map = new Map(initial.map((record) => [record.fingerprint, record]))
  return {
    writes: 0,
    removals: 0,
    async get(key) { return map.get(key) },
    async put(record) { this.writes += 1; map.set(record.fingerprint, record); return record },
    async remove(key) { this.removals += 1; return map.delete(key) },
  }
}

function successfulResult(backend, fixtureCount = 4) {
  return {
    record: {
      fingerprint: capabilityBenchmarkFingerprint(backend),
      provider: backend.provider,
      model: backend.model,
      measuredAt: Date.now(),
      source: 'self-benchmark',
      scores: { structured: 1, ocr: 0.8, general: 0.7 },
      medianLatencyMs: { structured: 100, ocr: 120, general: 110 },
      latencyMs: 110,
      fixtureCount,
      failureCount: 0,
    },
    results: [],
  }
}

test('exact invoker sends one selected vision-http provider directly and never enters fallback', async () => {
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
    callDirect: async (provider, messages) => {
      calls.push({ provider, messages })
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
  assert.equal(calls[0].messages[0].content[0].type, 'image_url')
  assert.equal(result.output, 'exact answer')
})

test('endpoint-scoped pi-ai provider benchmarks its exact HTTP endpoint rather than its DSH adapter', async () => {
  const calls = []
  const invoke = createExactCapabilityInvoker(fakeCtx(), fakeCore(), {
    key: 'zhipu-glm/glm-4.6v-flash',
    provider: 'zhipu-glm',
    model: 'glm-4.6v-flash',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    endpointConfig: { api: 'openai-completions' },
    endpointCredentialRef: 'ZHIPU_API_KEY',
    evidenceScope: 'endpoint',
  }, {}, {
    renderFixture: async () => Buffer.from('png'),
    callDirect: async (provider) => { calls.push(provider); return 'vision ok' },
    streamExact: async () => { throw new Error('adapter path must not run') },
  })
  const backend = {
    provider: 'zhipu-glm',
    model: 'glm-4.6v-flash',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    config: { api: 'openai-completions' },
  }
  backend.fingerprint = capabilityBenchmarkFingerprint(backend)
  await invoke({ backend, fixture: { id: 'f', prompt: 'x' }, exactBackend: true, allowFallback: false })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'glm-4.6v-flash')
  assert.equal(calls[0].apiKeyEnv, 'ZHIPU_API_KEY')
})

test('FIFO queue runs one benchmark at a time and exposes queue position/progress', async () => {
  const store = memoryStore()
  const order = []
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  let calls = 0
  const manager = createCapabilityBenchmarkManager(fakeCtx({ providers: [] }), { providers: [] }, fakeCore(), {
    store,
    runBenchmark: async ({ backend }) => {
      order.push(backend.model)
      calls += 1
      if (calls === 1) await firstGate
      return successfulResult(backend, CAPABILITY_BENCHMARK_MODE_REQUESTS.quick)
    },
  })
  const first = await manager.enqueue('vision-http/local-ollama/qwen2.5vl', 'quick')
  const second = await manager.enqueue('http:ovh-free/qwen3-vl', 'quick')
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  const mid = await manager.snapshot()
  assert.equal(mid.jobs.find((job) => job.key === 'vision-http/local-ollama/qwen2.5vl').state, 'running')
  const queued = mid.jobs.find((job) => job.key === 'http:ovh-free/qwen3-vl')
  assert.equal(queued.state, 'queued')
  assert.equal(queued.position, 1)
  releaseFirst()
  await manager.waitForIdle()
  assert.deepEqual(order, ['local-ollama/qwen2.5vl', 'ovh-free/qwen3-vl'])
  const done = await manager.snapshot()
  assert.equal(done.jobs.filter((job) => job.state === 'completed').length, 2)
})

test('duplicate click does not enqueue the same backend twice', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const manager = createCapabilityBenchmarkManager(fakeCtx({ providers: [] }), { providers: [] }, fakeCore(), {
    store: memoryStore(),
    runBenchmark: async ({ backend }) => { await gate; return successfulResult(backend) },
  })
  const first = await manager.enqueue('vision-http/local-ollama/qwen2.5vl', 'quick')
  const duplicate = await manager.enqueue('vision-http/local-ollama/qwen2.5vl', 'full')
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.job.id, first.job.id)
  release()
  await manager.waitForIdle()
})

test('queued job can be cancelled without touching the running job', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const manager = createCapabilityBenchmarkManager(fakeCtx({ providers: [] }), { providers: [] }, fakeCore(), {
    store: memoryStore(),
    runBenchmark: async ({ backend }) => { calls += 1; await gate; return successfulResult(backend) },
  })
  await manager.enqueue('vision-http/local-ollama/qwen2.5vl', 'quick')
  const queued = await manager.enqueue('http:ovh-free/qwen3-vl', 'quick')
  const cancelled = await manager.cancel(queued.job.id)
  assert.equal(cancelled.cancelled, true)
  release()
  await manager.waitForIdle()
  assert.equal(calls, 1)
  const snapshot = await manager.snapshot()
  assert.equal(snapshot.jobs.find((job) => job.id === queued.job.id).state, 'cancelled')
})

test('known text-only route requires explicit force verification', async () => {
  const config = { providers: [{ provider: 'text-adapter', model: 'text-model', fallbacks: [] }] }
  const manager = createCapabilityBenchmarkManager(fakeCtx(config, false), config, {
    ...fakeCore(false),
    localProvidersOf: () => [],
    httpProvidersOf: () => [],
  }, {
    store: memoryStore(),
    runBenchmark: async ({ backend }) => successfulResult(backend),
  })
  await assert.rejects(
    manager.enqueue('text-adapter/text-model', 'quick'),
    (error) => error?.code === 'CAPABILITY_BENCHMARK_FORCE_REQUIRED',
  )
  const forced = await manager.enqueue('text-adapter/text-model', 'quick', true)
  assert.equal(forced.ok, true)
  await manager.waitForIdle()
})

test('failed retest preserves the previous valid profile instead of overwriting/removing it', async () => {
  const core = fakeCore()
  const fingerprint = capabilityBenchmarkFingerprint({
    provider: 'vision-http',
    model: 'local-ollama/qwen2.5vl',
    endpoint: core.local.baseURL,
    config: { api: 'openai-completions' },
  })
  const old = {
    fingerprint,
    provider: 'vision-http',
    model: 'local-ollama/qwen2.5vl',
    measuredAt: Date.now() - 1000,
    scores: { general: 0.9 },
    latencyMs: 100,
    fixtureCount: 4,
    failureCount: 0,
  }
  const store = memoryStore([old])
  const manager = createCapabilityBenchmarkManager(fakeCtx({ providers: [] }), { providers: [] }, core, {
    store,
    runBenchmark: async ({ backend }) => ({
      record: { ...successfulResult(backend).record, fixtureCount: 4, failureCount: 1 },
      results: [{ fixture: 'x', intent: 'general', score: 0, details: { error: 'HTTP 429 rate limit' } }],
    }),
  })
  await manager.enqueue('vision-http/local-ollama/qwen2.5vl', 'quick')
  await manager.waitForIdle()
  assert.equal(store.writes, 0)
  assert.equal(store.removals, 0)
  assert.equal(await store.get(fingerprint), old)
  const snapshot = await manager.snapshot()
  const job = snapshot.jobs.find((entry) => entry.key === 'vision-http/local-ollama/qwen2.5vl')
  assert.equal(job.state, 'failed')
  assert.equal(job.errorClass, 'rate-limit')
  assert.ok(snapshot.candidates.find((entry) => entry.key === 'vision-http/local-ollama/qwen2.5vl').measured)
})

test('failure classifier separates auth, rate limit, timeout, image support, protocol and network', () => {
  assert.equal(classifyCapabilityBenchmarkFailure('HTTP 401 unauthorized'), 'auth')
  assert.equal(classifyCapabilityBenchmarkFailure('429 rate limit exceeded'), 'rate-limit')
  assert.equal(classifyCapabilityBenchmarkFailure('request timed out'), 'timeout')
  assert.equal(classifyCapabilityBenchmarkFailure('model does not support image input'), 'unsupported-image')
  assert.equal(classifyCapabilityBenchmarkFailure('unsupported protocol openai-responses'), 'protocol')
  assert.equal(classifyCapabilityBenchmarkFailure('fetch failed ECONNRESET'), 'network')
})
