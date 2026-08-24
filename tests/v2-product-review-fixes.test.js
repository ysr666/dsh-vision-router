import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createBackgroundCapabilityProfiler,
  runExactVisionCheck,
} from '../lib/vision-background-benchmark.js'
import { VISION_EXACT_CHECK_CLIENT } from '../lib/vision-exact-check-client.js'
import { VISION_ROUTING_SETTINGS_PRELUDE } from '../lib/vision-routing-settings-prelude.js'

function backendFixtures() {
  return {
    local: {
      name: 'local-test',
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'vision-local',
      apiKeyEnv: '',
      maxTokens: 512,
    },
    paid: {
      name: 'paid-cloud',
      baseURL: 'https://paid.example.invalid/v1',
      model: 'vision-paid',
      apiKeyEnv: 'PAID_KEY',
      maxTokens: 512,
    },
  }
}

function settings(overrides = {}) {
  const { paid } = backendFixtures()
  return {
    routingMode: 'auto',
    routingPreference: 'balanced',
    backgroundBenchmarking: 'all',
    providers: [{ provider: 'vision-http', model: 'paid-cloud/vision-paid', fallbacks: [] }],
    httpProviders: [paid],
    ...overrides,
  }
}

function fakeCtx(config) {
  return {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'settings') return { get: () => config }
      if (name === 'credentials') return { resolve: async () => ({ value: 'paid-secret' }) }
      if (name === 'attachments') return { async saveImage() { return { id: 'exact-check-image', mediaType: 'image/png' } } }
      return undefined
    },
    llm: {
      registration() { return { adapter: { constructor: { name: 'FakeAdapter' } } } },
      async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
    },
    tools: { register() { return () => {} } },
    effect() { return () => {} },
  }
}

function fakeCore() {
  const { local, paid } = backendFixtures()
  return {
    DEFAULT_HTTP_PROVIDERS: [],
    adapterAvailable: () => true,
    decideVisionBackendCapability: () => ({ image: true, attemptable: true }),
    localProvidersOf: () => [local],
    httpProvidersOf: () => [paid],
  }
}

function inertTimer() {
  return { unref() {} }
}

test('background profiling covers the same basic axis across models before deepening one model', async () => {
  const config = settings()
  const records = new Map()
  const store = {
    async get(key) { return records.get(key) },
    async put(record) { records.set(record.fingerprint, record); return record },
  }
  const seen = []
  const profiler = createBackgroundCapabilityProfiler({
    ctx: fakeCtx(config),
    config,
    core: fakeCore(),
    store,
    idleMs: 0,
    gapMs: 0,
    scanMs: 0,
    setTimer: inertTimer,
    clearTimer() {},
    runAxisBenchmark: async ({ candidate, axis }) => {
      seen.push([candidate.key, axis])
      const previous = records.get(candidate.endpointFingerprint) ?? { scores: {} }
      records.set(candidate.endpointFingerprint, {
        ...previous,
        scores: { ...previous.scores, [axis]: 0.5 },
      })
    },
  })

  for (let index = 0; index < 4; index += 1) await profiler.tick()
  profiler.stop()

  assert.deepEqual(seen.map((entry) => entry[1]), ['ocr', 'ocr', 'general', 'general'])
  assert.equal(new Set(seen.slice(0, 2).map((entry) => entry[0])).size, 2)
})

test('manual Benchmark pauses background work without manufacturing a new foreground idle window', () => {
  const config = settings()
  let now = 1_000
  let scheduled
  const profiler = createBackgroundCapabilityProfiler({
    ctx: fakeCtx(config),
    config,
    core: fakeCore(),
    store: { async get() {}, async put(record) { return record } },
    now: () => now,
    idleMs: 30_000,
    gapMs: 15_000,
    setTimer(delayCallback, delay) { scheduled = delay; return inertTimer() },
    clearTimer() {},
    runAxisBenchmark: async () => {},
  })

  now = 5_000
  profiler.manualStart()
  assert.equal(profiler.snapshot().lastForegroundAt, 1_000)
  profiler.manualEnd()
  assert.equal(profiler.snapshot().lastForegroundAt, 1_000)
  assert.equal(scheduled, 15_000)
  profiler.stop()
})

test('background profiler can be woken immediately by settings or model topology changes', () => {
  const config = settings()
  let scheduled
  const profiler = createBackgroundCapabilityProfiler({
    ctx: fakeCtx(config),
    config,
    core: fakeCore(),
    store: { async get() {}, async put(record) { return record } },
    idleMs: 30_000,
    setTimer(callback, delay) { scheduled = delay; return inertTimer() },
    clearTimer() {},
    runAxisBenchmark: async () => {},
  })
  profiler.wake()
  assert.equal(scheduled, 0)
  profiler.stop()
})

test('exact image check remains a one-request product action independent from Auto Benchmark evidence', () => {
  assert.match(VISION_EXACT_CHECK_CLIENT, /测试识图/)
  assert.match(VISION_EXACT_CHECK_CLIENT, /1次请求/)
  assert.match(VISION_EXACT_CHECK_CLIENT, /不写入Auto能力数据/)
  assert.match(VISION_EXACT_CHECK_CLIENT, /capability-runtime/)
  assert.doesNotMatch(VISION_EXACT_CHECK_CLIENT, /mode:'quick'|mode:'full'/)
})

test('exact image check can probe the current live adapter model before it enters the Auto candidate pool', async () => {
  const config = { routingMode: 'ordered', providers: [] }
  const ctx = fakeCtx(config)
  let seen
  await assert.rejects(
    runExactVisionCheck({
      ctx,
      config,
      core: { ...fakeCore(), localProvidersOf: () => [], httpProvidersOf: () => [] },
      store: { async get() {} },
      provider: 'opencode-go',
      model: 'hy3',
      invokerOptions: {
        renderFixture: async () => Buffer.from('png'),
        streamExact(call) {
          seen = call
          throw new Error('reached exact adapter invocation')
        },
      },
    }),
    /reached exact adapter invocation/,
  )
  assert.equal(seen.provider, 'opencode-go')
  assert.equal(seen.model, 'hy3')
})

test('exact image check is bounded, selection-safe, and does not expose raw backend errors as primary copy', () => {
  assert.match(VISION_EXACT_CHECK_CLIENT, /activeRuns/)
  assert.match(VISION_EXACT_CHECK_CLIENT, /abortActive/)
  assert.match(VISION_EXACT_CHECK_CLIENT, /currentRun/)
  assert.match(VISION_EXACT_CHECK_CLIENT, /setTimeout\(function\(\)\{controller\.abort\(\);\},50000\)/)
  assert.match(VISION_EXACT_CHECK_CLIENT, /正在测试当前模型/)
  assert.match(VISION_EXACT_CHECK_CLIENT, /测试超时，已自动结束/)
  assert.match(VISION_EXACT_CHECK_CLIENT, /VISION_CHECK_BACKEND_STALE/)
  assert.doesNotMatch(VISION_EXACT_CHECK_CLIENT, /setStatus\(control,'✗ '\+selection\.provider\+'\/'\+selection\.model\+' · '\+detail,detail\)/)
})

test('ordered mode hides capability Benchmark while retaining the independent exact image check', () => {
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /data-vr-routing-mode/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /data-vr-capability-control/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /chain\.dataset\.vrRoutingMode = settings\.mode/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /lastReadySettings/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /function buildPanelUi/)
  assert.doesNotMatch(VISION_ROUTING_SETTINGS_PRELUDE, /panel\.replaceChildren/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /vr-routing-state-line/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /后台补测中：/)
})
