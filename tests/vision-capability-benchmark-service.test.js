import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPABILITY_BENCHMARK_MODE_REQUESTS,
  classifyCapabilityBenchmarkFailure,
  createCapabilityBenchmarkManager as createCapabilityBenchmarkManagerRaw,
  createExactCapabilityInvoker,
} from '../lib/vision-capability-benchmark-service.js'
import { capabilityBenchmarkFingerprint } from '../lib/vision-capability-benchmark.js'
import { grantManualMeasurementFromUserAction } from '../lib/vision-routing-authority.js'

function createCapabilityBenchmarkManager(...args) {
  const manager = createCapabilityBenchmarkManagerRaw(...args)
  const authority = grantManualMeasurementFromUserAction('local-ui')
  const enqueue = manager.enqueue.bind(manager)
  const run = manager.run.bind(manager)
  manager.enqueue = (key, mode, force) => enqueue(key, mode, force, authority)
  manager.run = (key, intents, signal) => run(key, intents, signal, authority)
  return manager
}

function fakeCtx(settingsValue = {}, image = true) {
  return {
    get(name) {
      if (name === 'settings') return { get: () => settingsValue }
      if (name === 'attachments') {
        return {
          async saveImage() {
            return { id: 'benchmark-image', mediaType: 'image/png' }
          },
        }
      }
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

function runtimeBridgeCore(image = true) {
  return {
    ...fakeCore(image),
    VISION_FAILURE_KINDS: {
      INVALID_REQUEST: 'invalid-request',
      NETWORK: 'network',
      OTHER: 'other',
      AUTH: 'auth',
    },
    classifyVisionFailure(error) {
      if (/invalid/i.test(String(error?.message ?? error))) return { kind: 'invalid-request' }
      if (/network/i.test(String(error?.message ?? error))) return { kind: 'network' }
      if (/auth/i.test(String(error?.message ?? error))) return { kind: 'auth' }
      return { kind: 'other' }
    },
  }
}

function asyncTextStream(text) {
  return (async function* () {
    yield { text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
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

function successfulResult(backend, fixtureCount = CAPABILITY_BENCHMARK_MODE_REQUESTS.quick) {
  return {
    record: {
      fingerprint: capabilityBenchmarkFingerprint(backend),
      provider: backend.provider,
      model: backend.model,
      measuredAt: Date.now(),
      source: 'self-benchmark',
      scores: { ocr: 0.8, general: 0.7 },
      medianLatencyMs: { ocr: 120, general: 110 },
      latencyMs: 110,
      fixtureCount,
      failureCount: 0,
    },
    results: [],
  }
}

test('Quick and Full request counts stay bounded', () => {
  assert.deepEqual(CAPABILITY_BENCHMARK_MODE_REQUESTS, { quick: 3, full: 6 })
})

test('removed diagnostic modes cannot create a hidden one-axis benchmark', async () => {
  let seenIntents
  const manager = createCapabilityBenchmarkManager(fakeCtx({ providers: [] }), { providers: [] }, fakeCore(), {
    store: memoryStore(),
    runBenchmark: async ({ backend, intents }) => {
      seenIntents = intents
      return successfulResult(backend)
    },
  })
  const queued = await manager.enqueue('vision-http/local-ollama/qwen2.5vl', 'grounding')
  assert.equal(queued.job.mode, 'quick')
  assert.equal(queued.job.total, CAPABILITY_BENCHMARK_MODE_REQUESTS.quick)
  await manager.waitForIdle()
  assert.deepEqual(seenIntents, ['ocr', 'general'])
})

test('manual benchmark manager rejects programmatic measurement without explicit authority', async () => {
  let calls = 0
  const manager = createCapabilityBenchmarkManagerRaw(fakeCtx({ providers: [] }), { providers: [] }, fakeCore(), {
    store: memoryStore(),
    runBenchmark: async ({ backend }) => { calls += 1; return successfulResult(backend) },
  })
  await assert.rejects(
    manager.enqueue('vision-http/local-ollama/qwen2.5vl', 'quick'),
    (error) => error?.code === 'CAPABILITY_BENCHMARK_AUTHORITY_REQUIRED',
  )
  await assert.rejects(
    manager.run('vision-http/local-ollama/qwen2.5vl', ['ocr']),
    (error) => error?.code === 'CAPABILITY_BENCHMARK_AUTHORITY_REQUIRED',
  )
  assert.equal(calls, 0)
})

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
    streamExact: async () => { throw new Error('vision-http must not enter DSH adapter path') },
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
  assert.equal(result.transport, 'http-direct')
})

test('endpoint-scoped DSH provider uses its exact registered adapter before considering HTTP bridge', async () => {
  const adapterCalls = []
  let directCalls = 0
  const invoke = createExactCapabilityInvoker(fakeCtx(), fakeCore(), {
    key: 'zhipu-glm/glm-4.6v',
    provider: 'zhipu-glm',
    model: 'glm-4.6v',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    endpointConfig: { api: 'openai-completions' },
    endpointCredentialRef: 'ZHIPU_API_KEY',
    evidenceScope: 'endpoint',
  }, {}, {
    renderFixture: async () => Buffer.from('png'),
    streamExact: (call) => {
      adapterCalls.push(call)
      return asyncTextStream('[672,672,901,813]')
    },
    callDirect: async () => {
      directCalls += 1
      throw new Error('HTTP bridge must not run after successful adapter call')
    },
  })
  const backend = {
    provider: 'zhipu-glm',
    model: 'glm-4.6v',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    config: { api: 'openai-completions' },
  }
  backend.fingerprint = capabilityBenchmarkFingerprint(backend)
  const result = await invoke({
    backend,
    fixture: { id: 'grounding', intent: 'grounding', prompt: 'locate SAVE' },
    exactBackend: true,
    allowFallback: false,
  })
  assert.equal(adapterCalls.length, 1)
  assert.equal(adapterCalls[0].provider, 'zhipu-glm')
  assert.equal(adapterCalls[0].model, 'glm-4.6v')
  assert.equal(adapterCalls[0].messages[0].content[0].type, 'image')
  assert.equal(directCalls, 0)
  assert.equal(result.output, '[672,672,901,813]')
  assert.equal(result.transport, 'adapter')
})

test('DSH provider uses exact HTTP bridge only after a v1-compatible adapter failure', async () => {
  const directCalls = []
  const core = runtimeBridgeCore()
  const invoke = createExactCapabilityInvoker(fakeCtx(), core, {
    key: 'zhipu-glm/glm-4.6v',
    provider: 'zhipu-glm',
    model: 'glm-4.6v',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    endpointConfig: { api: 'openai-completions' },
    endpointCredentialRef: 'ZHIPU_API_KEY',
    evidenceScope: 'endpoint',
  }, {}, {
    renderFixture: async () => Buffer.from('png'),
    streamExact: async () => { throw new Error('invalid request from adapter') },
    callDirect: async (provider) => {
      directCalls.push(provider)
      return '[672,672,901,813]'
    },
  })
  const backend = {
    provider: 'zhipu-glm',
    model: 'glm-4.6v',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    config: { api: 'openai-completions' },
  }
  backend.fingerprint = capabilityBenchmarkFingerprint(backend)
  const result = await invoke({
    backend,
    fixture: { id: 'grounding', intent: 'grounding', prompt: 'locate SAVE' },
    exactBackend: true,
    allowFallback: false,
  })
  assert.equal(directCalls.length, 1)
  assert.equal(directCalls[0].name, 'zhipu-glm')
  assert.equal(directCalls[0].model, 'glm-4.6v')
  assert.equal(directCalls[0].apiKeyEnv, 'ZHIPU_API_KEY')
  assert.equal(result.transport, 'adapter-bridge')
})

test('non-bridgeable adapter failure never falls through to HTTP', async () => {
  let directCalls = 0
  const core = runtimeBridgeCore()
  const invoke = createExactCapabilityInvoker(fakeCtx(), core, {
    key: 'zhipu-glm/glm-4.6v',
    provider: 'zhipu-glm',
    model: 'glm-4.6v',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    endpointConfig: { api: 'openai-completions' },
    endpointCredentialRef: 'ZHIPU_API_KEY',
    evidenceScope: 'endpoint',
  }, {}, {
    renderFixture: async () => Buffer.from('png'),
    streamExact: async () => { throw new Error('auth failure') },
    callDirect: async () => { directCalls += 1; return 'must not run' },
  })
  const backend = {
    provider: 'zhipu-glm',
    model: 'glm-4.6v',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    config: { api: 'openai-completions' },
  }
  backend.fingerprint = capabilityBenchmarkFingerprint(backend)
  await assert.rejects(
    invoke({ backend, fixture: { id: 'f', prompt: 'x' }, exactBackend: true, allowFallback: false }),
    /auth failure/,
  )
  assert.equal(directCalls, 0)
})

test('fatal transport error fails fast after the first fixture and never persists a partial profile', async () => {
  const store = memoryStore()
  let calls = 0
  const manager = createCapabilityBenchmarkManager(fakeCtx({ providers: [] }), { providers: [] }, fakeCore(), {
    store,
    renderFixture: async () => Buffer.from('png'),
    callDirect: async () => {
      calls += 1
      const error = new Error('HTTP 401 unauthorized')
      error.status = 401
      throw error
    },
  })
  await manager.enqueue('vision-http/local-ollama/qwen2.5vl', 'quick')
  await manager.waitForIdle()
  assert.equal(calls, 1)
  assert.equal(store.writes, 0)
  assert.equal(store.removals, 0)
  const snapshot = await manager.snapshot()
  const job = snapshot.jobs.find((entry) => entry.key === 'vision-http/local-ollama/qwen2.5vl')
  assert.equal(job.state, 'failed')
  assert.equal(job.errorClass, 'auth')
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

test('completed full job exposes bounded grounding diagnostics without raw model text', async () => {
  const manager = createCapabilityBenchmarkManager(fakeCtx({ providers: [] }), { providers: [] }, fakeCore(), {
    store: memoryStore(),
    runBenchmark: async ({ backend }) => ({
      record: {
        ...successfulResult(backend, CAPABILITY_BENCHMARK_MODE_REQUESTS.full).record,
        scores: { structured: 1, ocr: 0.5, document: 1, grounding: 0, general: 0.75 },
        fixtureCount: CAPABILITY_BENCHMARK_MODE_REQUESTS.full,
      },
      results: [{
        fixture: 'grounding-target-v1',
        intent: 'grounding',
        score: 0,
        details: {
          iou: 0,
          parseSource: 'bracket-array',
          parsed: [10, 20, 30, 40],
          normalized: { x1: 7.68, y1: 10.24, x2: 23.04, y2: 20.48 },
          coordinateSpace: 'normalized-1000',
          responseShape: 'array',
          formatValid: true,
          candidateSpaces: ['normalized-1000', 'pixels'],
        },
      }],
    }),
  })
  await manager.enqueue('vision-http/local-ollama/qwen2.5vl', 'full')
  await manager.waitForIdle()
  const snapshot = await manager.snapshot()
  const job = snapshot.jobs.find((entry) => entry.key === 'vision-http/local-ollama/qwen2.5vl')
  assert.equal(job.state, 'completed')
  assert.deepEqual(job.groundingDiagnostic, {
    score: 0,
    iou: 0,
    formatValid: true,
    parseSource: 'bracket-array',
    coordinateSpace: 'normalized-1000',
    responseShape: 'array',
    normalized: { x1: 7.68, y1: 10.24, x2: 23.04, y2: 20.48 },
    parsed: [10, 20, 30, 40],
    candidateSpaces: ['normalized-1000', 'pixels'],
  })
  assert.equal(JSON.stringify(job.groundingDiagnostic).includes('raw model'), false)
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
    fixtureCount: CAPABILITY_BENCHMARK_MODE_REQUESTS.quick,
    failureCount: 0,
  }
  const store = memoryStore([old])
  const manager = createCapabilityBenchmarkManager(fakeCtx({ providers: [] }), { providers: [] }, core, {
    store,
    runBenchmark: async ({ backend }) => ({
      record: { ...successfulResult(backend).record, failureCount: 1 },
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
