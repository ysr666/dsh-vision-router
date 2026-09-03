import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  classifyCapabilityBenchmarkFailure,
} from '../lib/vision-capability-benchmark-service.js'
import {
  createBackgroundCapabilityProfiler,
} from '../lib/vision-background-benchmark.js'

const SERVICE_URL = new URL('../lib/vision-capability-benchmark-service.js', import.meta.url)

function inertTimer() {
  return { unref() {} }
}

function configFor(provider, model) {
  return {
    routingMode: 'auto',
    routingPreference: 'balanced',
    backgroundBenchmarking: 'all',
    providers: [{ provider, model, fallbacks: [] }],
  }
}

function fakeCtx(config) {
  return {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name !== 'settings') return undefined
      return {
        get(namespace) {
          if (namespace === 'vision-router') return config
          if (namespace === 'llm-pi-ai') return { providers: {} }
          return undefined
        },
      }
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
  return {
    DEFAULT_HTTP_PROVIDERS: [],
    adapterAvailable: () => true,
    decideVisionBackendCapability: () => ({ image: true, attemptable: true }),
    localProvidersOf: () => [],
    httpProvidersOf: () => [],
  }
}

function memoryProfileStore() {
  return {
    async get() { return undefined },
    async put(record) { return record },
  }
}

function memoryStopStore() {
  const records = []
  return {
    records,
    async list() { return records.map((item) => ({ ...item })) },
    async mark(value) {
      const next = { ...value }
      const index = records.findIndex((item) => item.fingerprint === next.fingerprint && item.axis === next.axis)
      if (index >= 0) records[index] = next
      else records.push(next)
      return next
    },
    async clearFingerprint(fingerprint) {
      let removed = false
      for (let index = records.length - 1; index >= 0; index -= 1) {
        if (records[index].fingerprint !== fingerprint) continue
        records.splice(index, 1)
        removed = true
      }
      return removed
    },
  }
}

function profilerFor(config, runAxisBenchmark, backgroundStopStore) {
  return createBackgroundCapabilityProfiler({
    ctx: fakeCtx(config),
    config,
    core: fakeCore(),
    store: memoryProfileStore(),
    backgroundStopStore,
    idleMs: 0,
    gapMs: 0,
    scanMs: 0,
    setTimer: inertTimer,
    clearTimer() {},
    runAxisBenchmark,
  })
}

test('DSH UNSUPPORTED_CONTENT with explicit image rejection is classified as unsupported-image', () => {
  const rejection = Object.assign(
    new Error('deepseek-v4-flash does not accept image input'),
    { code: 'UNSUPPORTED_CONTENT' },
  )
  assert.equal(classifyCapabilityBenchmarkFailure(rejection), 'unsupported-image')
  assert.equal(
    classifyCapabilityBenchmarkFailure(Object.assign(new Error('unsupported content type'), { code: 'UNSUPPORTED_CONTENT' })),
    'provider',
  )
})

test('deployment-level unavailable stop survives profiler recreation and blocks every axis', async () => {
  const config = configFor('openrouter', 'openai/gpt-5.6-sol')
  const stops = memoryStopStore()
  const first = profilerFor(config, async () => {
    throw Object.assign(new Error('model not found'), { status: 404, code: 'MODEL_NOT_FOUND' })
  }, stops)
  await first.tick()
  first.stop()
  assert.equal(stops.records.length, 1)
  assert.equal(stops.records[0].errorClass, 'unavailable')

  let calls = 0
  const restarted = profilerFor(config, async () => { calls += 1 }, stops)
  await restarted.tick()
  const snapshot = restarted.snapshot()
  restarted.stop()
  assert.equal(calls, 0)
  assert.equal(snapshot.deferred[0]?.errorClass, 'unavailable')
  assert.equal(snapshot.deferred[0]?.retryable, false)
})

test('visual-proof failure is transient and axis-scoped without surviving restart', async () => {
  const config = configFor('opencode-go', 'kimi-k3')
  const stops = memoryStopStore()
  const first = profilerFor(config, async () => {
    const error = new Error('benchmark visual proof missing')
    error.code = 'CAPABILITY_BENCHMARK_VISUAL_PROOF_FAILED'
    error.benchmarkClass = 'visual-proof'
    throw error
  }, stops)
  await first.tick()
  const firstSnapshot = first.snapshot()
  first.stop()

  assert.equal(stops.records.length, 0)
  assert.equal(firstSnapshot.deferred[0]?.axis, 'ocr')
  assert.equal(firstSnapshot.deferred[0]?.errorClass, 'visual-proof')
  assert.equal(firstSnapshot.deferred[0]?.retryable, true)

  const seen = []
  const restarted = profilerFor(config, async ({ axis }) => { seen.push(axis) }, stops)
  await restarted.tick()
  restarted.stop()
  assert.deepEqual(seen, ['ocr'])
})

test('manual benchmark default budgets allow six legitimate 120s fixtures plus cleanup margin', async () => {
  const source = await readFile(SERVICE_URL, 'utf8')
  const run = source.match(/const DEFAULT_RUN_TIMEOUT_MS = (\d+) \* 60 \* 1000/)
  const fixture = source.match(/const DEFAULT_FIXTURE_TIMEOUT_MS = (\d+) \* 1000/)
  assert.ok(run)
  assert.ok(fixture)
  const runMs = Number(run[1]) * 60 * 1000
  const fixtureMs = Number(fixture[1]) * 1000
  assert.ok(fixtureMs >= 120_000)
  assert.ok(runMs > 6 * fixtureMs)
})
