import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CAPABILITY_PROFILE_MAX_AGE_MS,
  capabilityProfileCachePath,
  createCapabilityProfileStore,
  runExactCapabilityBenchmark,
} from '../lib/vision-capability-probe.js'

function outputForFixture(fixture) {
  if (fixture.intent === 'ocr') return fixture.expected.text
  if (fixture.intent === 'grounding') return JSON.stringify(fixture.expected.box)
  if (fixture.intent === 'structured') {
    return JSON.stringify({
      visual_kind: 'ui',
      overview: (fixture.expected.tokens ?? []).join(' '),
      regions: [],
      visible_text: [],
      relationships: [],
      uncertainties: [],
    })
  }
  return (fixture.expected.tokens ?? []).join(' ')
}

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  const writes = []
  return {
    files,
    writes,
    ops: {
      async readFile(file) {
        if (!files.has(file)) {
          const error = new Error('missing')
          error.code = 'ENOENT'
          throw error
        }
        return files.get(file)
      },
      async mkdir() {},
      async writeFile(file, body, options) {
        writes.push({ file, body, options })
        files.set(file, body)
      },
      async rename(from, to) {
        assert.ok(files.has(from))
        files.set(to, files.get(from))
        files.delete(from)
      },
    },
  }
}

test('exact benchmark probes one backend sequentially with fallback forbidden', async () => {
  let clock = 10_000
  let active = 0
  let maxActive = 0
  const calls = []
  const backend = {
    provider: 'custom-provider',
    model: 'vision-model',
    endpoint: 'https://example.test/v1?api_key=must-not-affect-fingerprint&region=us',
    config: { quantization: 'q8', nested: { temperature: 0, token: 'secret' } },
  }

  const { record, results } = await runExactCapabilityBenchmark({
    backend,
    intents: ['ocr', 'grounding', 'general'],
    now: () => { clock += 11; return clock },
    invoke: async (request) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      calls.push(request)
      assert.equal(request.exactBackend, true)
      assert.equal(request.allowFallback, false)
      assert.equal(request.backend.provider, backend.provider)
      assert.equal(request.backend.model, backend.model)
      const output = outputForFixture(request.fixture)
      active -= 1
      return { output, usedFingerprint: request.backend.fingerprint }
    },
  })

  assert.equal(maxActive, 1)
  assert.equal(calls.length, 4) // OCR has Latin/UI + Chinese chat fixtures.
  assert.equal(results.length, 4)
  assert.match(record.fingerprint, /^ep2_[0-9a-f]{32}$/)
  assert.equal(record.provider, 'custom-provider')
  assert.equal(record.model, 'vision-model')
  assert.equal(record.fixtureCount, 4)
  assert.equal(record.failureCount, 0)
  assert.equal(record.scores.ocr, 1)
  assert.equal(record.scores.grounding, 1)
  assert.equal(record.scores.general, 1)
  assert.ok(record.latencyMs >= 0)
  assert.equal('endpoint' in record, false)
  assert.equal('config' in record, false)
})

test('backend fingerprint mismatch aborts instead of persisting fallback evidence', async () => {
  await assert.rejects(
    runExactCapabilityBenchmark({
      backend: { provider: 'p', model: 'm', endpoint: 'https://example.test/v1' },
      intents: ['general'],
      now: (() => { let n = 100; return () => ++n })(),
      invoke: async () => ({
        output: '3 circle square triangle',
        usedFingerprint: 'ep2_00000000000000000000000000000000',
      }),
    }),
    (error) => error?.code === 'CAPABILITY_BENCHMARK_BACKEND_MISMATCH',
  )
})

test('ordinary probe failures score zero but remain bounded evidence for the exact endpoint', async () => {
  const { record, results } = await runExactCapabilityBenchmark({
    backend: { provider: 'p', model: 'm', endpoint: 'https://example.test/v1' },
    intents: ['general'],
    now: (() => { let n = 1000; return () => (n += 5) })(),
    invoke: async () => { throw new Error('provider unavailable\nwith noisy detail') },
  })
  assert.equal(record.failureCount, 1)
  assert.equal(record.scores.general, 0)
  assert.equal(results[0].score, 0)
  assert.match(results[0].details.error, /provider unavailable with noisy detail/)
})

test('capability profile store uses the DSH cache area, atomic 0600 writes, and strips secrets/extras', async () => {
  assert.match(capabilityProfileCachePath('/tmp/dsh-home'), /cache[\\/]vision-router[\\/]capability-profiles\.json$/)
  assert.equal(DEFAULT_CAPABILITY_PROFILE_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1000)
  const mem = memoryFs()
  const cacheFile = '/virtual/capability-profiles.json'
  const now = () => 50_000
  const store = createCapabilityProfileStore({ cacheFile, fsOps: mem.ops, now })
  const record = await store.put({
    fingerprint: 'ep2_1234567890abcdef1234567890abcdef',
    provider: 'provider-a',
    model: 'model-a',
    measuredAt: 50_000,
    scores: { ocr: 0.91, general: 0.82, constructor: 1 },
    medianLatencyMs: { ocr: 123, general: 456 },
    latencyMs: 289.5,
    fixtureCount: 3,
    failureCount: 0,
    endpoint: 'https://secret.example/v1',
    apiKey: 'never-persist-me',
    config: { token: 'never-persist-me' },
  })
  await store.flush()

  assert.equal(record.provider, 'provider-a')
  assert.ok(mem.writes.length >= 1)
  assert.equal(mem.writes.at(-1).options.mode, 0o600)
  assert.ok(mem.files.has(cacheFile))
  const persistedText = mem.files.get(cacheFile)
  assert.equal(persistedText.includes('never-persist-me'), false)
  assert.equal(persistedText.includes('secret.example'), false)
  const persisted = JSON.parse(persistedText)
  assert.equal(persisted.version, 1)
  assert.equal(persisted.profiles.length, 1)
  assert.deepEqual(Object.keys(persisted.profiles[0].scores).sort(), ['general', 'ocr'])

  const reloaded = createCapabilityProfileStore({ cacheFile, fsOps: mem.ops, now })
  assert.deepEqual(await reloaded.get(record.fingerprint), record)
})

test('quick retest cannot downgrade a richer full benchmark profile', async () => {
  const mem = memoryFs()
  const store = createCapabilityProfileStore({
    cacheFile: '/virtual/capability-profiles.json',
    fsOps: mem.ops,
    now: () => 100_000,
  })
  const fingerprint = 'ep2_1234567890abcdef1234567890abcdef'
  const full = await store.put({
    fingerprint,
    provider: 'p',
    model: 'm',
    measuredAt: 90_000,
    scores: { structured: 1, ocr: 0.8, grounding: 0.7, document: 0.9, general: 0.8 },
    medianLatencyMs: { general: 500 },
    fixtureCount: 6,
    failureCount: 0,
  })
  const writesAfterFull = mem.writes.length
  const returned = await store.put({
    fingerprint,
    provider: 'p',
    model: 'm',
    measuredAt: 100_000,
    scores: { ocr: 1, general: 1 },
    medianLatencyMs: { general: 400 },
    fixtureCount: 3,
    failureCount: 0,
  })
  assert.deepEqual(returned, full)
  assert.deepEqual(await store.get(fingerprint), full)
  assert.equal(mem.writes.length, writesAfterFull)
})

test('corrupt or stale capability cache fails soft instead of poisoning routing', async () => {
  const cacheFile = '/virtual/capability-profiles.json'
  const corrupt = memoryFs({ [cacheFile]: '{not json' })
  const store = createCapabilityProfileStore({ cacheFile, fsOps: corrupt.ops, now: () => 100_000 })
  assert.deepEqual(await store.list(), [])

  const stale = memoryFs({
    [cacheFile]: JSON.stringify({
      version: 1,
      profiles: [{
        fingerprint: 'ep2_1234567890abcdef1234567890abcdef',
        provider: 'p',
        model: 'm',
        measuredAt: 1,
        scores: { general: 1 },
        medianLatencyMs: {},
        fixtureCount: 1,
        failureCount: 0,
      }],
    }),
  })
  const staleStore = createCapabilityProfileStore({
    cacheFile,
    fsOps: stale.ops,
    now: () => 200_000_000,
    maxAgeMs: 86_400_000,
  })
  assert.deepEqual(await staleStore.list(), [])
})
