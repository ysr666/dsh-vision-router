import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyBackgroundBenchmarkFailure,
  createBackgroundCapabilityProfiler,
} from '../lib/vision-background-benchmark.js'
import {
  CAPABILITY_BENCHMARK_SUITE_REVISION,
} from '../lib/vision-capability-benchmark.js'
import { sanitizeCapabilityProfileRecord } from '../lib/vision-capability-probe.js'

function inertTimer() {
  return { unref() {} }
}

function configFor(pairs, overrides = {}) {
  return {
    routingMode: 'auto',
    routingPreference: 'balanced',
    backgroundBenchmarking: 'all',
    providers: pairs.map(([provider, model]) => ({ provider, model, fallbacks: [] })),
    ...overrides,
  }
}

function fakeCtx(config, options = {}) {
  const modalities = options.modalities ?? {}
  const piProviders = options.piProviders ?? {}
  return {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name !== 'settings') return undefined
      return {
        get(namespace) {
          if (namespace === 'vision-router') return config
          if (namespace === 'llm-pi-ai') return { providers: piProviders }
          return undefined
        },
      }
    },
    llm: {
      registration() { return { adapter: { constructor: { name: 'FakeAdapter' } } } },
      async resolveModelInfo(provider, model) {
        return { inputModalities: modalities[`${provider}/${model}`] ?? ['text', 'image'] }
      },
    },
    tools: { register() { return () => {} } },
    effect() { return () => {} },
  }
}

function fakeCore() {
  return {
    DEFAULT_HTTP_PROVIDERS: [],
    adapterAvailable: () => true,
    decideVisionBackendCapability(info) {
      const input = Array.isArray(info?.inputModalities) ? info.inputModalities : []
      return { image: input.includes('image'), attemptable: true }
    },
    localProvidersOf: () => [],
    httpProvidersOf: () => [],
  }
}

function memoryStore(recordForFingerprint) {
  const writes = []
  return {
    writes,
    async get(fingerprint) {
      return typeof recordForFingerprint === 'function'
        ? recordForFingerprint(fingerprint)
        : recordForFingerprint
    },
    async put(record) { writes.push(record); return record },
  }
}

function memoryVerdictStore() {
  const records = new Map()
  return {
    records,
    async get(fingerprint) { return records.get(fingerprint) },
    async markUnsupported(value) {
      const record = { ...value, state: 'unsupported', reason: 'provider-rejected-image' }
      records.set(value.fingerprint, record)
      return record
    },
    async clear(fingerprint) { return records.delete(fingerprint) },
  }
}

function profilerFor(config, ctx, store, runAxisBenchmark, extra = {}) {
  return createBackgroundCapabilityProfiler({
    ctx,
    config,
    core: fakeCore(),
    store,
    idleMs: 0,
    gapMs: 0,
    scanMs: 0,
    setTimer: inertTimer,
    clearTimer() {},
    runAxisBenchmark,
    ...extra,
  })
}

test('Zhipu-like image adapter remains eligible for unattended background profiling', async () => {
  const config = configFor([['zhipu-glm', 'glm-4.6v']])
  const ctx = fakeCtx(config, { modalities: { 'zhipu-glm/glm-4.6v': ['text', 'image'] } })
  const seen = []
  const profiler = profilerFor(config, ctx, memoryStore(), async ({ candidate, axis }) => {
    seen.push([candidate.key, axis])
  })
  await profiler.tick()
  profiler.stop()
  assert.deepEqual(seen, [['zhipu-glm/glm-4.6v', 'ocr']])
})

test('Host-declared text-only adapter is actually probed under explicit background authority', async () => {
  const config = configFor([['deepseek-official', 'deepseek-v4-flash']])
  const ctx = fakeCtx(config, {
    modalities: { 'deepseek-official/deepseek-v4-flash': ['text'] },
  })
  const seen = []
  const profiler = profilerFor(config, ctx, memoryStore(), async ({ candidate, axis }) => {
    seen.push([candidate.key, axis])
  })
  await profiler.tick()
  const snapshot = profiler.snapshot()
  profiler.stop()
  assert.deepEqual(seen, [['deepseek-official/deepseek-v4-flash', 'ocr']])
  assert.deepEqual(snapshot.excluded, [])
})

test('running background snapshot exposes fixture progress and elapsed time', async () => {
  const config = configFor([['zhipu-glm', 'glm-4.6v']])
  const ctx = fakeCtx(config)
  let clock = 1_000
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const profiler = profilerFor(config, ctx, memoryStore(), async ({ onProgress }) => {
    onProgress?.({ phase: 'start', completed: 0, total: 2, fixture: 'ocr-a', intent: 'ocr' })
    onProgress?.({ phase: 'finish', completed: 1, total: 2, fixture: 'ocr-a', intent: 'ocr' })
    clock = 4_500
    await gate
  }, { now: () => clock })
  const running = profiler.tick()
  await new Promise((resolve) => setImmediate(resolve))
  const snapshot = profiler.snapshot()
  assert.equal(snapshot.running?.key, 'zhipu-glm/glm-4.6v')
  assert.equal(snapshot.running?.axis, 'ocr')
  assert.equal(snapshot.running?.completed, 1)
  assert.equal(snapshot.running?.total, 2)
  assert.equal(snapshot.running?.startedAt, 1_000)
  assert.equal(snapshot.running?.elapsedMs, 3_500)
  assert.equal(snapshot.running?.currentFixture, 'ocr-a')
  release()
  await running
  profiler.stop()
})

test('one failed model does not block the next model on the same axis', async () => {
  const config = configFor([
    ['first-cloud', 'vision-a'],
    ['zhipu-glm', 'glm-4.6v'],
  ])
  const ctx = fakeCtx(config)
  const seen = []
  const profiler = profilerFor(config, ctx, memoryStore(), async ({ candidate, axis }) => {
    seen.push([candidate.key, axis])
    if (candidate.key === 'first-cloud/vision-a') throw new Error('fetch failed: network unavailable')
  })
  await profiler.tick()
  await profiler.tick()
  profiler.stop()
  assert.deepEqual(seen, [
    ['first-cloud/vision-a', 'ocr'],
    ['zhipu-glm/glm-4.6v', 'ocr'],
  ])
})

test('failed axis backoff does not contaminate another axis of the same model', async () => {
  const config = configFor([['zhipu-glm', 'glm-4.6v']])
  const ctx = fakeCtx(config)
  const seen = []
  let first = true
  const profiler = profilerFor(config, ctx, memoryStore(), async ({ axis }) => {
    seen.push(axis)
    if (first) {
      first = false
      throw new Error('socket network failure')
    }
  })
  await profiler.tick()
  await profiler.tick()
  profiler.stop()
  assert.deepEqual(seen, ['ocr', 'general'])
})

test('complete current profile sends zero background requests', async () => {
  const now = Date.now()
  const complete = {
    scores: { ocr: 0.9, general: 0.8, document: 0.7, structured: 0.85, grounding: 0.75 },
    measuredAt: now,
    measuredAtByAxis: { ocr: now, general: now, document: now, structured: now, grounding: now },
  }
  const config = configFor([['opencode-go', 'minimax-m3']])
  const ctx = fakeCtx(config)
  let calls = 0
  const profiler = profilerFor(config, ctx, memoryStore(complete), async () => { calls += 1 })
  await profiler.tick()
  profiler.stop()
  assert.equal(calls, 0)
})

test('partial profile fills only the first missing axis instead of restarting completed axes', async () => {
  const now = Date.now()
  const partial = {
    scores: { ocr: 0.9, general: 0.8 },
    measuredAt: now,
    measuredAtByAxis: { ocr: now, general: now },
  }
  const config = configFor([['opencode-go', 'minimax-m3']])
  const ctx = fakeCtx(config)
  const seen = []
  const profiler = profilerFor(config, ctx, memoryStore(partial), async ({ axis }) => { seen.push(axis) })
  await profiler.tick()
  profiler.stop()
  assert.deepEqual(seen, ['document'])
})

test('background failure classification distinguishes permanent and transient causes', () => {
  const auth = Object.assign(new Error('HTTP 401 unauthorized'), { status: 401 })
  assert.deepEqual(classifyBackgroundBenchmarkFailure(auth), {
    errorClass: 'auth',
    errorCode: undefined,
    retryable: false,
  })

  const rateLimit = Object.assign(new Error('too many requests'), { status: 429, code: 'RATE_LIMITED' })
  assert.deepEqual(classifyBackgroundBenchmarkFailure(rateLimit), {
    errorClass: 'rate-limit',
    errorCode: 'RATE_LIMITED',
    retryable: true,
  })

  const unavailable = Object.assign(new Error('model not found'), { status: 404, code: 'MODEL_NOT_FOUND' })
  assert.deepEqual(classifyBackgroundBenchmarkFailure(unavailable), {
    errorClass: 'unavailable',
    errorCode: 'MODEL_NOT_FOUND',
    retryable: false,
  })

  const visualProof = Object.assign(new Error('benchmark visual proof missing'), { benchmarkClass: 'visual-proof' })
  assert.deepEqual(classifyBackgroundBenchmarkFailure(visualProof), {
    errorClass: 'visual-proof',
    errorCode: undefined,
    retryable: false,
  })

  const unsupported = Object.assign(new Error('model does not support image input'), { benchmarkClass: 'unsupported-image' })
  assert.deepEqual(classifyBackgroundBenchmarkFailure(unsupported), {
    errorClass: 'unsupported-image',
    errorCode: undefined,
    retryable: false,
  })

  const timeout = Object.assign(new Error('fixture timed out'), { code: 'CAPABILITY_BENCHMARK_TIMEOUT' })
  assert.equal(classifyBackgroundBenchmarkFailure(timeout).errorClass, 'timeout')
  assert.equal(classifyBackgroundBenchmarkFailure(timeout).retryable, true)
})

test('explicit image rejection becomes a fingerprint-scoped whole-model background stop', async () => {
  const config = configFor([['deepseek-official', 'deepseek-v4-flash']])
  const ctx = fakeCtx(config)
  const verdicts = memoryVerdictStore()
  const seen = []
  const profiler = profilerFor(config, ctx, memoryStore(), async ({ candidate, axis }) => {
    seen.push([candidate.key, axis])
    throw Object.assign(new Error('model does not support image input'), {
      benchmarkClass: 'unsupported-image',
      code: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
    })
  }, { imageVerdictStore: verdicts })

  await profiler.tick()
  assert.deepEqual(seen, [['deepseek-official/deepseek-v4-flash', 'ocr']])
  assert.deepEqual(profiler.snapshot().excluded, [
    { key: 'deepseek-official/deepseek-v4-flash', reason: 'measured-text-only' },
  ])
  assert.equal(verdicts.records.size, 1)

  await profiler.tick()
  profiler.stop()
  assert.deepEqual(seen, [['deepseek-official/deepseek-v4-flash', 'ocr']])
})

test('non-retryable unavailable survives ordinary settings and topology refreshes', async () => {
  const config = configFor([['openrouter', 'openai/gpt-5.6-sol']])
  const ctx = fakeCtx(config)
  let calls = 0
  const profiler = profilerFor(config, ctx, memoryStore(), async () => {
    calls += 1
    throw Object.assign(new Error('model not found'), { status: 404, code: 'MODEL_NOT_FOUND' })
  })

  await profiler.tick()
  assert.equal(calls, 1)
  assert.equal(profiler.snapshot().deferred[0]?.errorClass, 'unavailable')
  assert.equal(profiler.snapshot().deferred[0]?.retryable, false)

  profiler.settingsChanged()
  await profiler.tick()
  assert.equal(calls, 1)

  profiler.topologyChanged()
  await profiler.tick()
  profiler.stop()
  assert.equal(calls, 1)
})

test('explicit successful image retest clears same-fingerprint nonretryable background stop', async () => {
  const config = configFor([['openrouter', 'openai/gpt-5.6-sol']])
  const ctx = fakeCtx(config)
  let calls = 0
  let fail = true
  const profiler = profilerFor(config, ctx, memoryStore(), async () => {
    calls += 1
    if (fail) throw Object.assign(new Error('model not found'), { status: 404, code: 'MODEL_NOT_FOUND' })
  })

  await profiler.tick()
  assert.equal(calls, 1)
  fail = false
  assert.equal(await profiler.recordImageSupported('openrouter', 'openai/gpt-5.6-sol'), true)
  await profiler.tick()
  profiler.stop()
  assert.equal(calls, 2)
})

test('non-retryable failure is fingerprint-scoped and a changed endpoint identity is measured again', async () => {
  const config = configFor([['zhipu-glm', 'glm-4.6v']])
  const piProviders = {
    'zhipu-glm': {
      baseURL: 'https://one.example.invalid/v1',
      api: 'openai-completions',
      apiKeyEnv: 'ZHIPU_API_KEY',
    },
  }
  const ctx = fakeCtx(config, { piProviders })
  const seen = []
  let fail = true
  const profiler = profilerFor(config, ctx, memoryStore(), async ({ candidate, axis }) => {
    seen.push([candidate.endpointFingerprint, axis])
    if (fail) {
      fail = false
      throw Object.assign(new Error('HTTP 401 unauthorized'), { status: 401 })
    }
  })
  await profiler.tick()
  const first = profiler.snapshot()
  assert.equal(first.deferred[0].retryable, false)
  assert.equal(first.deferred[0].errorClass, 'auth')

  piProviders['zhipu-glm'].baseURL = 'https://two.example.invalid/v1'
  await profiler.tick()
  profiler.stop()
  assert.equal(seen.length, 2)
  assert.notEqual(seen[0][0], seen[1][0])
  assert.equal(seen[1][1], 'ocr')
})

test('old benchmark suite records are invalidated while current-suite evidence remains valid', () => {
  const base = {
    fingerprint: 'ep2_0123456789abcdef0123456789abcdef',
    provider: 'opencode-go',
    model: 'minimax-m3',
    measuredAt: Date.now(),
    measuredAtByAxis: { ocr: Date.now() },
    scores: { ocr: 0.9 },
    fixtureCountByAxis: { ocr: 1 },
  }
  assert.equal(sanitizeCapabilityProfileRecord({
    ...base,
    suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION - 1,
  }), undefined)
  assert.ok(sanitizeCapabilityProfileRecord({
    ...base,
    suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
  }))
})
