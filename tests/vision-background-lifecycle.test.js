import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  backgroundFailurePolicy,
  BACKGROUND_AUTH_STOP_TTL_MS,
  BACKGROUND_ENDPOINT_STOP_TTL_MS,
  credentialFingerprintChanged,
} from '../lib/vision-background-failure-policy.js'
import { createBackgroundBenchmarkStopStore } from '../lib/vision-background-stop-store.js'
import { createBackgroundCapabilityProfiler } from '../lib/vision-background-benchmark.js'

const FINGERPRINT = `ep2_${'a'.repeat(32)}`

function inertTimer() {
  return { unref() {} }
}

test('background failure policy separates transient retry from persistent stop authority', () => {
  assert.deepEqual(backgroundFailurePolicy('visual-proof'), {
    retryable: true,
    persist: false,
    retryAfterMs: 30 * 60 * 1000,
    credentialScoped: false,
  })
  assert.deepEqual(backgroundFailurePolicy('infrastructure'), {
    retryable: true,
    persist: false,
    retryAfterMs: 30 * 60 * 1000,
    credentialScoped: false,
  })
  assert.deepEqual(backgroundFailurePolicy('auth'), {
    retryable: false,
    persist: true,
    ttlMs: BACKGROUND_AUTH_STOP_TTL_MS,
    credentialScoped: true,
  })
  assert.equal(backgroundFailurePolicy('protocol').ttlMs, BACKGROUND_ENDPOINT_STOP_TTL_MS)
  assert.equal(backgroundFailurePolicy('unavailable').ttlMs, BACKGROUND_ENDPOINT_STOP_TTL_MS)
  assert.equal(backgroundFailurePolicy('unsupported-image').persist, false)
})

test('credential stop invalidation is conservative only while current identity is unresolved', () => {
  assert.equal(credentialFingerprintChanged('unresolved', 'cred_111111111111111111111111'), true)
  assert.equal(credentialFingerprintChanged('cred_aaaaaaaaaaaaaaaaaaaaaaaa', 'cred_bbbbbbbbbbbbbbbbbbbbbbbb'), true)
  assert.equal(credentialFingerprintChanged('cred_aaaaaaaaaaaaaaaaaaaaaaaa', 'unresolved'), false)
  assert.equal(credentialFingerprintChanged('unresolved', 'unresolved'), false)
})

test('background stop cache v2 drops legacy permanent stops and expires bounded stops', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vision-background-stop-v2-'))
  const cacheFile = path.join(root, 'stops.json')
  let clock = 1_000
  try {
    await writeFile(cacheFile, JSON.stringify({
      version: 1,
      stops: [{
        fingerprint: FINGERPRINT,
        key: 'http:paid/vision',
        provider: 'vision-http',
        model: 'paid/vision',
        axis: 'ocr',
        errorClass: 'auth',
        recordedAt: 100,
        suiteRevision: 3,
      }],
    }))
    const store = createBackgroundBenchmarkStopStore({ cacheFile, now: () => clock })
    assert.deepEqual(await store.list(), [], 'v1 unbounded stop authority must not migrate')

    const marked = await store.mark({
      fingerprint: FINGERPRINT,
      key: 'http:paid/vision',
      provider: 'vision-http',
      model: 'paid/vision',
      axis: 'ocr',
      errorClass: 'protocol',
      recordedAt: clock,
      expiresAt: clock + 100,
    })
    assert.equal(marked?.expiresAt, 1_100)
    assert.equal((await store.list()).length, 1)

    clock = 1_101
    assert.deepEqual(await store.list(), [])
    await store.flush()
    const disk = JSON.parse(await readFile(cacheFile, 'utf8'))
    assert.equal(disk.version, 2)
    assert.deepEqual(disk.stops, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('AUTH background stop is invalidated when an unresolved credential becomes observable', async () => {
  const paid = {
    name: 'paid-cloud',
    baseURL: 'https://paid.example.invalid/v1',
    model: 'vision-paid',
    apiKeyEnv: 'PAID_KEY',
    maxTokens: 512,
  }
  const config = {
    routingMode: 'auto',
    routingPreference: 'balanced',
    backgroundBenchmarking: 'all',
    providers: [{ provider: 'vision-http', model: 'paid-cloud/vision-paid', fallbacks: [] }],
    httpProviders: [paid],
  }
  let secret
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'settings') return { get: () => config }
      if (name === 'credentials') return { resolve: async () => ({ value: secret }) }
      return undefined
    },
    llm: {
      registration() { return { adapter: { constructor: { name: 'FakeAdapter' } } } },
      async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
    },
  }
  const core = {
    DEFAULT_HTTP_PROVIDERS: [],
    adapterAvailable: () => true,
    decideVisionBackendCapability: () => ({ image: true, attemptable: true }),
    localProvidersOf: () => [],
    httpProvidersOf: () => [paid],
  }
  const store = {
    async get() { return undefined },
    async put(record) { return record },
  }
  const stops = []
  let cleared = 0
  const backgroundStopStore = {
    async list() { return [...stops] },
    async mark(stop) { stops.splice(0, stops.length, stop); return stop },
    async clearStop(fingerprint, axis) {
      const index = stops.findIndex((item) => item.fingerprint === fingerprint && item.axis === axis)
      if (index < 0) return false
      stops.splice(index, 1)
      cleared += 1
      return true
    },
    async clearFingerprint(fingerprint) {
      let removed = false
      for (let index = stops.length - 1; index >= 0; index -= 1) {
        if (stops[index].fingerprint !== fingerprint) continue
        stops.splice(index, 1)
        removed = true
      }
      return removed
    },
  }
  let clock = 100_000
  let calls = 0
  let failAuth = true
  const profiler = createBackgroundCapabilityProfiler({
    ctx,
    config,
    core,
    store,
    now: () => clock,
    idleMs: 0,
    gapMs: 0,
    scanMs: 0,
    setTimer: inertTimer,
    clearTimer() {},
    setIntervalFn: inertTimer,
    clearIntervalFn() {},
    imageVerdictStore: { async get() { return undefined } },
    backgroundStopStore,
    runAxisBenchmark: async () => {
      calls += 1
      if (!failAuth) return
      const error = new Error('401 invalid API key')
      error.code = 'AUTH'
      error.benchmarkClass = 'auth'
      throw error
    },
  })

  await profiler.tick()
  assert.equal(calls, 1)
  assert.equal(stops.length, 1)
  assert.equal(stops[0].credentialFingerprint, 'unresolved')
  assert.equal(stops[0].expiresAt, clock + BACKGROUND_AUTH_STOP_TTL_MS)
  assert.equal(profiler.snapshot().backoffSize, 1)

  secret = 'new-secret'
  failAuth = false
  clock += 1
  await profiler.tick()
  assert.equal(calls, 2, 'newly observable credential must make the backend eligible immediately')
  assert.equal(cleared, 1, 'the stale persistent AUTH stop must be removed')
  assert.deepEqual(stops, [])
  assert.equal(profiler.snapshot().backoffSize, 0)
  profiler.stop()
})
