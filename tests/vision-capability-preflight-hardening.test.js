import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createCapabilityBenchmarkManager,
  createExactCapabilityInvoker,
} from '../lib/vision-capability-benchmark-service.js'
import { resolveVisionCredential } from '../lib/vision-capability-identity.js'
import { collectCapabilityShadowCandidates } from '../lib/vision-capability-shadow.js'

function localBackend() {
  return {
    name: 'local-test',
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'vision-model',
    apiKeyEnv: '',
    maxTokens: 1024,
  }
}

function httpBackend(apiKeyEnv = 'TEST_KEY') {
  return {
    name: 'cloud-test',
    baseURL: 'https://example.test/v1',
    model: 'vision-model',
    apiKeyEnv,
    maxTokens: 1024,
  }
}

function core({ local = [localBackend()], http = [] } = {}) {
  return {
    DEFAULT_HTTP_PROVIDERS: [],
    adapterAvailable: () => true,
    decideVisionBackendCapability: () => ({ image: true, attemptable: true }),
    localProvidersOf: () => local,
    httpProvidersOf: () => http,
    callOpenAICompatible: async () => 'ok',
  }
}

function ctx(settings = {}, options = {}) {
  return {
    get(name) {
      if (name === 'settings') return { get: () => settings }
      if (name === 'attachments') {
        return {
          async saveImage(input) {
            options.onSaveImage?.(input)
            return { attachmentId: 'sha256:test', mediaType: 'image/png', bytes: input.data.length, width: 1, height: 1 }
          },
        }
      }
      if (name === 'credentials') {
        return options.credentials
          ? { resolve: async (ref) => ({ value: options.credentials[ref] }) }
          : undefined
      }
      return undefined
    },
    llm: {
      listProviders: () => [],
      registration() { return { adapter: { constructor: { name: 'FakeAdapter' } } } },
      async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
      stream: options.stream ?? (() => (async function* () {
        yield { text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()),
    },
  }
}

function memoryStore() {
  const map = new Map()
  return {
    writes: 0,
    async get(key) { return map.get(key) },
    async put(record) { this.writes += 1; map.set(record.fingerprint, record); return record },
  }
}

test('full benchmark preflights every fixture before making the first provider request', async () => {
  const settings = { providers: [{ provider: 'vision-http', model: 'local-test/vision-model', fallbacks: [] }] }
  let renders = 0
  let providerCalls = 0
  const manager = createCapabilityBenchmarkManager(ctx(settings), settings, core(), {
    store: memoryStore(),
    renderFixture: async () => {
      renders += 1
      if (renders === 4) {
        const error = new Error('synthetic fixture renderer failure')
        error.code = 'CAPABILITY_BENCHMARK_INFRASTRUCTURE'
        throw error
      }
      return Buffer.from('png')
    },
    callDirect: async () => { providerCalls += 1; return 'must not run' },
  })
  await manager.enqueue('vision-http/local-test/vision-model', 'full')
  await manager.waitForIdle()
  const job = (await manager.snapshot()).jobs.find((entry) => entry.key === 'vision-http/local-test/vision-model')
  assert.equal(renders, 4)
  assert.equal(providerCalls, 0)
  assert.equal(job.state, 'failed')
  assert.equal(job.errorClass, 'infrastructure')
})

test('adapter benchmark latency excludes fixture rendering and durable attachment preparation', async () => {
  let clock = 0
  const settings = { providers: [{ provider: 'adapter-x', model: 'vision-x', fallbacks: [] }] }
  const runtime = ctx(settings, {
    onSaveImage() { clock += 700 },
    stream: () => (async function* () {
      clock += 100
      yield { text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  })
  const invoke = createExactCapabilityInvoker(runtime, core({ local: [], http: [] }), {
    key: 'adapter-x/vision-x',
    provider: 'adapter-x', model: 'vision-x',
    endpoint: 'dsh-adapter://registered/adapter-x',
    endpointConfig: { api: 'dsh-adapter' }, evidenceScope: 'adapter-route',
  }, settings, {
    now: () => clock,
    renderFixture: async () => { clock += 500; return Buffer.from('png') },
  })
  const fixture = { id: 'f', intent: 'general', svg: '<svg/>', prompt: 'x' }
  await invoke.preflight([fixture])
  assert.equal(clock, 1200)
  const result = await invoke({
    backend: { fingerprint: 'ep2_00000000000000000000000000000000' },
    fixture, exactBackend: true, allowFallback: false,
  })
  assert.equal(result.transport, 'adapter')
  assert.equal(result.latencyMs, 100)
  assert.equal(clock, 1300)
})

test('benchmark timeout is a failed timeout, never a user cancellation', async () => {
  const settings = { providers: [{ provider: 'vision-http', model: 'local-test/vision-model', fallbacks: [] }] }
  const manager = createCapabilityBenchmarkManager(ctx(settings), settings, core(), {
    store: memoryStore(),
    renderFixture: async () => Buffer.from('png'),
    runBenchmark: async () => {
      const error = new Error('benchmark deadline exceeded')
      error.name = 'TimeoutError'
      throw error
    },
  })
  await manager.enqueue('vision-http/local-test/vision-model', 'quick')
  await manager.waitForIdle()
  const job = (await manager.snapshot()).jobs.find((entry) => entry.key === 'vision-http/local-test/vision-model')
  assert.equal(job.state, 'failed')
  assert.equal(job.errorClass, 'timeout')
  assert.equal(job.errorCode, 'CAPABILITY_BENCHMARK_TIMEOUT')
})

test('configured but unresolved credential stays distinct access state and never falls through the credentials seam', async () => {
  const previous = process.env.TEST_KEY
  process.env.TEST_KEY = 'ambient-secret-that-must-not-be-used'
  try {
    const noAuth = await resolveVisionCredential(ctx(), '')
    const unresolved = await resolveVisionCredential(ctx({}, { credentials: {} }), 'TEST_KEY')
    assert.equal(noAuth.fingerprint, 'none')
    assert.equal(noAuth.required, false)
    assert.equal(unresolved.required, true)
    assert.equal(unresolved.value, undefined)
    assert.equal(unresolved.fingerprint, 'unresolved')
    assert.equal(unresolved.source, 'credentials-miss')
  } finally {
    if (previous === undefined) delete process.env.TEST_KEY
    else process.env.TEST_KEY = previous
  }
})

test('rotating an API key changes access identity but not capability evidence identity', async () => {
  const backend = httpBackend('TEST_KEY')
  const settings = {
    providers: [{ provider: 'vision-http', model: 'cloud-test/vision-model', fallbacks: [] }],
    httpProviders: [backend],
  }
  const runtimeA = ctx(settings, { credentials: { TEST_KEY: 'key-A-secret' } })
  const runtimeB = ctx(settings, { credentials: { TEST_KEY: 'key-B-secret' } })
  const c = core({ local: [], http: [backend] })
  const store = { async get() { return undefined } }
  const [a] = await collectCapabilityShadowCandidates(runtimeA, settings, c, store)
  const [b] = await collectCapabilityShadowCandidates(runtimeB, settings, c, store)
  assert.ok(a)
  assert.ok(b)
  assert.equal(a.endpointFingerprint, b.endpointFingerprint)
  assert.equal(Object.hasOwn(a, 'credentialFingerprint'), false)
  assert.equal(Object.hasOwn(b, 'credentialFingerprint'), false)

  const accessA = await resolveVisionCredential(runtimeA, 'TEST_KEY')
  const accessB = await resolveVisionCredential(runtimeB, 'TEST_KEY')
  assert.notEqual(accessA.fingerprint, accessB.fingerprint)
  assert.match(accessA.fingerprint, /^cred_[0-9a-f]{24}$/)
  assert.doesNotMatch(JSON.stringify({ capability: a.endpointFingerprint, access: accessA.fingerprint }), /key-A-secret|key-B-secret/)
})
