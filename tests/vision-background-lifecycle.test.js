import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  backgroundFailurePolicy,
  BACKGROUND_AUTH_STOP_TTL_MS,
  BACKGROUND_ENDPOINT_STOP_TTL_MS,
} from '../lib/vision-background-failure-policy.js'
import { createBackgroundBenchmarkStopStore } from '../lib/vision-background-stop-store.js'
import { CAPABILITY_BENCHMARK_SUITE_REVISION } from '../lib/vision-capability-benchmark.js'
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
  })
  assert.deepEqual(backgroundFailurePolicy('infrastructure'), {
    retryable: true,
    persist: false,
    retryAfterMs: 30 * 60 * 1000,
  })
  assert.deepEqual(backgroundFailurePolicy('auth'), {
    retryable: false,
    persist: false,
    ttlMs: BACKGROUND_AUTH_STOP_TTL_MS,
  })
  assert.equal(backgroundFailurePolicy('protocol').ttlMs, BACKGROUND_ENDPOINT_STOP_TTL_MS)
  assert.equal(backgroundFailurePolicy('unavailable').ttlMs, BACKGROUND_ENDPOINT_STOP_TTL_MS)
  assert.equal(backgroundFailurePolicy('unsupported-image').persist, false)
})

test('background stop cache v3 drops secret-derived auth stops and expires bounded endpoint stops', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vision-background-stop-v3-'))
  const cacheFile = path.join(root, 'stops.json')
  let clock = 1_000
  try {
    await writeFile(cacheFile, JSON.stringify({
      version: 2,
      stops: [
        {
          fingerprint: FINGERPRINT,
          key: 'http:paid/vision',
          provider: 'vision-http',
          model: 'paid/vision',
          axis: 'ocr',
          errorClass: 'auth',
          credentialFingerprint: 'cred_aaaaaaaaaaaaaaaaaaaaaaaa',
          recordedAt: 100,
          expiresAt: 1_050,
          suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
        },
        {
          fingerprint: FINGERPRINT,
          key: 'http:paid/vision',
          provider: 'vision-http',
          model: 'paid/vision',
          axis: 'general',
          errorClass: 'protocol',
          recordedAt: 100,
          expiresAt: 1_050,
          suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
        },
      ],
    }))
    const store = createBackgroundBenchmarkStopStore({ cacheFile, now: () => clock })
    const migrated = await store.list()
    assert.equal(migrated.length, 1, 'safe v2 endpoint stops migrate while secret-derived AUTH stops are dropped')
    assert.equal(migrated[0].errorClass, 'protocol')
    const migratedDisk = JSON.parse(await readFile(cacheFile, 'utf8'))
    assert.equal(migratedDisk.version, 3)
    assert.equal(JSON.stringify(migratedDisk).includes('credentialFingerprint'), false)

    const auth = await store.mark({
      fingerprint: FINGERPRINT,
      key: 'http:paid/vision',
      provider: 'vision-http',
      model: 'paid/vision',
      axis: 'ocr',
      errorClass: 'auth',
      recordedAt: clock,
      expiresAt: clock + BACKGROUND_AUTH_STOP_TTL_MS,
    })
    assert.equal(auth, undefined, 'AUTH stops are process-local and never enter the persistent cache')
    await store.clearStop(FINGERPRINT, 'general')

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
    assert.equal(disk.version, 3)
    assert.deepEqual(disk.stops, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('AUTH background stop is in-memory, transport-wide, and credential change releases it immediately', async () => {
  const paidA = {
    name: 'paid-cloud-a',
    baseURL: 'https://paid.example.invalid/v1',
    model: 'vision-paid-a',
    apiKeyEnv: 'PAID_KEY',
    maxTokens: 512,
  }
  const paidB = {
    name: 'paid-cloud-b',
    baseURL: 'https://paid.example.invalid/v1',
    model: 'vision-paid-b',
    apiKeyEnv: 'PAID_KEY',
    maxTokens: 512,
  }
  const config = {
    routingMode: 'auto',
    routingPreference: 'balanced',
    backgroundBenchmarking: 'all',
    providers: [
      { provider: 'vision-http', model: 'paid-cloud-a/vision-paid-a', fallbacks: [] },
      { provider: 'vision-http', model: 'paid-cloud-b/vision-paid-b', fallbacks: [] },
    ],
    httpProviders: [paidA, paidB],
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'settings') return { get: () => config }
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
    httpProvidersOf: () => [paidA, paidB],
  }
  const store = {
    async get() { return undefined },
    async put(record) { return record },
  }
  const persisted = []
  const backgroundStopStore = {
    async list() { return [] },
    async mark(stop) { persisted.push(stop); return stop },
    async clearStop() { return false },
    async clearFingerprint() { return false },
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
  assert.equal(profiler.snapshot().backoffSize, 1)
  assert.deepEqual(persisted, [], 'AUTH failures must never persist secret-derived credential identity')

  await profiler.tick()
  assert.equal(calls, 1, 'same transport sibling must not rotate into another 401 on the next 15s slot')

  failAuth = false
  profiler.credentialsChanged('PAID_KEY')
  assert.equal(profiler.snapshot().backoffSize, 0, 'credential event releases the in-memory AUTH stop synchronously')
  clock += 1
  await profiler.tick()
  assert.equal(calls, 2, 'new credential can revalidate immediately without waiting for the AUTH TTL')
  profiler.stop()
})
