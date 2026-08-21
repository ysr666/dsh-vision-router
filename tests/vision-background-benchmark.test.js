import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createBackgroundCapabilityProfiler,
  installBackgroundCapabilityProfiling,
} from '../lib/vision-background-benchmark.js'

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
    backgroundBenchmarking: 'local-free',
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

function memoryStore(records = new Map()) {
  return {
    async get(key) { return records.get(key) },
    async put(record) { records.set(record.fingerprint, record); return record },
  }
}

function inertTimer() {
  return { unref() {} }
}

function profilerFor(config, runAxisBenchmark, extra = {}) {
  return createBackgroundCapabilityProfiler({
    ctx: fakeCtx(config),
    config,
    core: fakeCore(),
    store: memoryStore(),
    idleMs: 0,
    gapMs: 0,
    scanMs: 0,
    setTimer: inertTimer,
    clearTimer() {},
    runAxisBenchmark,
    ...extra,
  })
}

test('local-free background policy skips paid cloud and profiles a local backend first', async () => {
  const seen = []
  const profiler = profilerFor(settings(), async ({ candidate, axis }) => { seen.push([candidate.key, axis]) })
  await profiler.tick()
  profiler.stop()
  assert.deepEqual(seen, [['vision-http/local-test/vision-local', 'ocr']])
})

test('all policy is explicit authorization for paid configured cloud backends', async () => {
  const seen = []
  const profiler = profilerFor(settings({ backgroundBenchmarking: 'all' }), async ({ candidate, axis }) => { seen.push([candidate.key, axis]) })
  await profiler.tick()
  profiler.stop()
  assert.deepEqual(seen, [['http:paid-cloud/vision-paid', 'ocr']])
})

test('ordered mode and off policy never schedule background model requests', async () => {
  for (const config of [
    settings({ routingMode: 'ordered' }),
    settings({ backgroundBenchmarking: 'off' }),
  ]) {
    let calls = 0
    const profiler = profilerFor(config, async () => { calls += 1 })
    await profiler.tick()
    profiler.stop()
    assert.equal(calls, 0)
  }
})

test('background profiler does not remeasure a complete profile solely because it is old', async () => {
  const DAY = 24 * 60 * 60 * 1000
  const oldRecord = {
    measuredAt: Date.now() - 365 * DAY,
    measuredAtByAxis: {
      structured: Date.now() - 365 * DAY,
      ocr: Date.now() - 365 * DAY,
      document: Date.now() - 365 * DAY,
      grounding: Date.now() - 365 * DAY,
      general: Date.now() - 365 * DAY,
    },
    scores: { structured: 0.8, ocr: 0.8, document: 0.8, grounding: 0.8, general: 0.8 },
  }
  const store = {
    async get() { return oldRecord },
    async put(record) { return record },
  }
  let calls = 0
  const profiler = profilerFor(settings(), async () => { calls += 1 }, { store })
  await profiler.tick()
  profiler.stop()
  assert.equal(calls, 0)
})

test('recent foreground task moves its directly measurable axis to the front of progressive work', async () => {
  const seen = []
  const profiler = profilerFor(settings(), async ({ axis }) => { seen.push(axis) })
  profiler.foregroundStart({ toolName: 'vision_long_screenshot_ocr', args: {} })
  profiler.foregroundEnd()
  await profiler.tick()
  profiler.stop()
  assert.deepEqual(seen, ['document'])
})

test('real foreground vision aborts an in-flight background request and does not backoff it as a provider failure', async () => {
  let started
  const ready = new Promise((resolve) => { started = resolve })
  let observedSignal
  const profiler = profilerFor(settings(), ({ signal }) => new Promise((resolve, reject) => {
    observedSignal = signal
    started()
    signal.addEventListener('abort', () => reject(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
  }))
  const ticking = profiler.tick()
  await ready
  profiler.foregroundStart({ toolName: 'vision_ocr', args: {} })
  await ticking
  assert.equal(observedSignal.aborted, true)
  assert.equal(profiler.snapshot().activeForeground, 1)
  assert.equal(profiler.snapshot().backoffSize, 0)
  profiler.foregroundEnd()
  profiler.stop()
})

test('manual benchmark lease pauses and preempts background profiling until all manual work releases', async () => {
  let calls = 0
  const profiler = profilerFor(settings(), async () => { calls += 1 })
  profiler.manualStart()
  await profiler.tick()
  assert.equal(calls, 0)
  assert.equal(profiler.snapshot().activeManualBenchmarks, 1)
  profiler.manualEnd()
  await profiler.tick()
  assert.equal(calls, 1)
  profiler.stop()
})

test('installed profiler is shared through the capability store without becoming enumerable persisted data', () => {
  const config = settings()
  const store = memoryStore()
  const installed = installBackgroundCapabilityProfiling(fakeCtx(config), config, fakeCore(), store, {
    idleMs: 60_000,
    setTimer: inertTimer,
    clearTimer() {},
    runAxisBenchmark: async () => {},
  })
  assert.equal(store.backgroundProfiler, installed.profiler)
  assert.equal(Object.keys(store).includes('backgroundProfiler'), false)
  installed.profiler.stop()
})