import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPABILITY_PROFILE_CACHE_VERSION,
  DEFAULT_CAPABILITY_PROFILE_MAX_AGE_MS,
  capabilityProfileAxisFreshness,
  capabilityProfileCachePath,
  createCapabilityProfileStore,
  runExactCapabilityBenchmark,
} from '../lib/vision-capability-probe.js'
import { CAPABILITY_BENCHMARK_SUITE_REVISION } from '../lib/vision-capability-benchmark.js'

function outputForFixture(fixture) {
  if (fixture.intent === 'ocr') return fixture.expected.text
  if (fixture.intent === 'grounding') return JSON.stringify(fixture.expected.box)
  if (fixture.intent === 'structured') {
    return JSON.stringify({
      visual_kind: 'ui',
      overview: (fixture.expected.tokens ?? []).join(' '),
      regions: [],
      visible_text: fixture.expected.tokens ?? [],
      relationships: [],
      uncertainties: [],
    })
  }
  if (fixture.intent === 'document') return JSON.stringify(fixture.expected)
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

function recordBase(overrides = {}) {
  return {
    suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
    fingerprint: 'ep2_1234567890abcdef1234567890abcdef',
    provider: 'p',
    model: 'm',
    measuredAt: 50_000,
    scores: { general: 0.8 },
    medianLatencyMs: { general: 100 },
    fixtureCount: 1,
    failureCount: 0,
    ...overrides,
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
    credentialFingerprint: 'cred_test',
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
      return { output, usedFingerprint: request.backend.fingerprint, latencyMs: 7 }
    },
  })

  assert.equal(maxActive, 1)
  assert.equal(calls.length, 4)
  assert.equal(results.length, 4)
  assert.match(record.fingerprint, /^ep2_[0-9a-f]{32}$/)
  assert.equal(record.provider, 'custom-provider')
  assert.equal(record.model, 'vision-model')
  assert.equal(record.suiteRevision, CAPABILITY_BENCHMARK_SUITE_REVISION)
  assert.equal(record.fixtureCount, 4)
  assert.deepEqual(record.fixtureCountByAxis, { ocr: 2, grounding: 1, general: 1 })
  assert.equal(record.failureCount, 0)
  assert.equal(record.scores.ocr, 1)
  assert.equal(record.scores.grounding, 1)
  assert.equal(record.scores.general, 1)
  assert.equal(record.medianLatencyMs.ocr, 7)
  assert.equal(record.latencyMs, 7)
  assert.equal(record.measuredAtByAxis.ocr, record.measuredAt)
  assert.equal(record.measuredAtByAxis.grounding, record.measuredAt)
  assert.equal(record.measuredAtByAxis.general, record.measuredAt)
  assert.equal(record.groundingDiagnostic.formatValid, true)
  assert.equal(record.groundingDiagnostic.iou, 1)
  assert.equal(record.groundingDiagnostic.coordinateSpace, 'pixels')
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

test('any invocation failure fails fast instead of manufacturing zero-score evidence', async () => {
  let calls = 0
  await assert.rejects(
    runExactCapabilityBenchmark({
      backend: { provider: 'p', model: 'm', endpoint: 'https://example.test/v1' },
      intents: ['ocr', 'general'],
      now: (() => { let n = 1000; return () => (n += 5) })(),
      invoke: async () => {
        calls += 1
        throw new Error('provider unavailable\nwith noisy detail')
      },
    }),
    /provider unavailable/,
  )
  assert.equal(calls, 1)
})

test('capability profile store uses cache v3, atomic 0600 writes, suite revision, and strips secrets/extras', async () => {
  assert.equal(CAPABILITY_PROFILE_CACHE_VERSION, 3)
  assert.match(capabilityProfileCachePath('/tmp/dsh-home'), /cache[\\/]vision-router[\\/]capability-profiles\.json$/)
  assert.equal(DEFAULT_CAPABILITY_PROFILE_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1000)
  const mem = memoryFs()
  const cacheFile = '/virtual/capability-profiles.json'
  const now = () => 50_000
  const store = createCapabilityProfileStore({ cacheFile, fsOps: mem.ops, now })
  const record = await store.put(recordBase({
    provider: 'provider-a',
    model: 'model-a',
    scores: { ocr: 0.91, grounding: 0.4, general: 0.82, constructor: 1 },
    medianLatencyMs: { ocr: 123, grounding: 222, general: 456 },
    latencyMs: 289.5,
    fixtureCount: 6,
    groundingDiagnostic: {
      score: 0.4,
      iou: 0.4,
      formatValid: true,
      parseSource: 'glm-box-markers',
      coordinateSpace: 'normalized-1000',
      responseShape: 'array',
      parsed: [672, 672, 901, 813],
      normalized: { x1: 516.096, y1: 344.064, x2: 691.968, y2: 416.256 },
      candidateSpaces: ['normalized-1000'],
      rawOutput: 'SECRET MUST NOT PERSIST',
    },
    endpoint: 'https://secret.example/v1',
    apiKey: 'never-persist-me',
    config: { token: 'never-persist-me' },
  }))
  await store.flush()

  assert.equal(record.provider, 'provider-a')
  assert.equal(record.suiteRevision, CAPABILITY_BENCHMARK_SUITE_REVISION)
  assert.deepEqual(record.measuredAtByAxis, { ocr: 50_000, grounding: 50_000, general: 50_000 })
  assert.deepEqual(record.fixtureCountByAxis, { ocr: 4, grounding: 1, general: 1 })
  assert.equal(record.groundingDiagnostic.parseSource, 'glm-box-markers')
  assert.equal('rawOutput' in record.groundingDiagnostic, false)
  assert.ok(mem.writes.length >= 1)
  assert.equal(mem.writes.at(-1).options.mode, 0o600)
  const persistedText = mem.files.get(cacheFile)
  assert.equal(persistedText.includes('never-persist-me'), false)
  assert.equal(persistedText.includes('secret.example'), false)
  assert.equal(persistedText.includes('SECRET MUST NOT PERSIST'), false)
  const persisted = JSON.parse(persistedText)
  assert.equal(persisted.version, 3)
  assert.equal(persisted.profiles.length, 1)
  assert.equal(persisted.profiles[0].suiteRevision, CAPABILITY_BENCHMARK_SUITE_REVISION)
  assert.deepEqual(Object.keys(persisted.profiles[0].scores).sort(), ['general', 'grounding', 'ocr'])

  const reloaded = createCapabilityProfileStore({ cacheFile, fsOps: mem.ops, now })
  assert.deepEqual(await reloaded.get(record.fingerprint), record)
})

test('cache v2 migrates to per-axis timestamps while version 1 and wrong suites remain ignored', async () => {
  const cacheFile = '/virtual/capability-profiles.json'
  const v2 = memoryFs({
    [cacheFile]: JSON.stringify({ version: 2, profiles: [recordBase({ scores: { ocr: 0.8, general: 0.9 }, fixtureCount: 3 })] }),
  })
  const migrated = await createCapabilityProfileStore({ cacheFile, fsOps: v2.ops, now: () => 50_000 }).list()
  assert.equal(migrated.length, 1)
  assert.deepEqual(migrated[0].measuredAtByAxis, { ocr: 50_000, general: 50_000 })
  assert.deepEqual(migrated[0].fixtureCountByAxis, { ocr: 2, general: 1 })

  const legacy = memoryFs({
    [cacheFile]: JSON.stringify({ version: 1, profiles: [recordBase()] }),
  })
  assert.deepEqual(await createCapabilityProfileStore({ cacheFile, fsOps: legacy.ops, now: () => 50_000 }).list(), [])

  const wrongSuite = memoryFs({
    [cacheFile]: JSON.stringify({
      version: 2,
      profiles: [recordBase({ suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION - 1 })],
    }),
  })
  assert.deepEqual(await createCapabilityProfileStore({ cacheFile, fsOps: wrongSuite.ops, now: () => 50_000 }).list(), [])
})

test('partial retest refreshes only covered axes and preserves richer untouched evidence', async () => {
  const mem = memoryFs()
  const store = createCapabilityProfileStore({ cacheFile: '/virtual/capability-profiles.json', fsOps: mem.ops, now: () => 100_000 })
  const fingerprint = 'ep2_1234567890abcdef1234567890abcdef'
  await store.put(recordBase({
    fingerprint,
    measuredAt: 90_000,
    scores: { structured: 1, ocr: 0.8, grounding: 0.7, document: 0.9, general: 0.8 },
    medianLatencyMs: { structured: 700, ocr: 600, grounding: 900, document: 800, general: 500 },
    fixtureCount: 6,
    groundingDiagnostic: {
      score: 0.7, iou: 0.7, formatValid: true, parseSource: 'flat-four-tuple',
      coordinateSpace: 'normalized-1000', responseShape: 'array', parsed: [672, 672, 901, 813],
      candidateSpaces: ['normalized-1000'],
    },
  }))
  const returned = await store.put(recordBase({
    fingerprint,
    measuredAt: 100_000,
    scores: { ocr: 1, general: 1 },
    medianLatencyMs: { ocr: 350, general: 400 },
    fixtureCount: 3,
  }))

  assert.deepEqual(returned.scores, { structured: 1, ocr: 1, grounding: 0.7, document: 0.9, general: 1 })
  assert.equal(returned.measuredAtByAxis.structured, 90_000)
  assert.equal(returned.measuredAtByAxis.document, 90_000)
  assert.equal(returned.measuredAtByAxis.grounding, 90_000)
  assert.equal(returned.measuredAtByAxis.ocr, 100_000)
  assert.equal(returned.measuredAtByAxis.general, 100_000)
  assert.equal(returned.medianLatencyMs.ocr, 350)
  assert.equal(returned.medianLatencyMs.general, 400)
  assert.equal(returned.medianLatencyMs.document, 800)
  assert.equal(returned.groundingDiagnostic.iou, 0.7)
  assert.equal(returned.fixtureCount, 6)
})

test('single grounding repair refreshes only grounding timestamp and keeps other axes untouched', async () => {
  const mem = memoryFs()
  const cacheFile = '/virtual/capability-profiles.json'
  const store = createCapabilityProfileStore({ cacheFile, fsOps: mem.ops, now: () => 120_000 })
  const fingerprint = 'ep2_1234567890abcdef1234567890abcdef'
  const measuredAt = 90_000
  await store.put(recordBase({
    fingerprint,
    provider: 'zhipu-glm',
    model: 'glm-4.6v',
    measuredAt,
    scores: { structured: 1, ocr: 0.5, document: 1, grounding: 0, general: 0.75 },
    medianLatencyMs: { structured: 3000, ocr: 2500, document: 2800, grounding: 2600, general: 2400 },
    latencyMs: 2600,
    fixtureCount: 6,
  }))

  const repaired = await store.put(recordBase({
    fingerprint,
    provider: 'zhipu-glm',
    model: 'glm-4.6v',
    measuredAt: 120_000,
    scores: { grounding: 0.9473 },
    medianLatencyMs: { grounding: 5324 },
    latencyMs: 5324,
    fixtureCount: 1,
    groundingDiagnostic: {
      score: 0.9473, iou: 0.9473, formatValid: true, parseSource: 'json',
      coordinateSpace: 'normalized-1000', responseShape: 'array', parsed: ['670,668,903,814'],
      normalized: { x1: 514.56, y1: 342.016, x2: 693.504, y2: 416.768 },
      candidateSpaces: ['normalized-1000'],
    },
  }))

  assert.deepEqual(repaired.scores, { structured: 1, ocr: 0.5, document: 1, grounding: 0.9473, general: 0.75 })
  assert.equal(repaired.medianLatencyMs.grounding, 5324)
  assert.equal(repaired.medianLatencyMs.document, 2800)
  assert.equal(repaired.fixtureCount, 6)
  assert.equal(repaired.failureCount, 0)
  assert.equal(repaired.measuredAt, 120_000)
  assert.equal(repaired.measuredAtByAxis.grounding, 120_000)
  assert.equal(repaired.measuredAtByAxis.document, measuredAt)
  assert.equal(repaired.latencyMs, 2800)
  assert.equal(repaired.groundingDiagnostic.iou, 0.9473)
  await store.flush()
  const reloaded = createCapabilityProfileStore({ cacheFile, fsOps: mem.ops, now: () => 120_000 })
  assert.deepEqual(await reloaded.get(fingerprint), repaired)
})

test('axis freshness is independent: refreshing general never makes stale OCR fresh', () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = 20 * DAY
  const record = recordBase({
    measuredAt: now,
    measuredAtByAxis: { ocr: now - 8 * DAY, general: now },
    scores: { ocr: 0.9, general: 0.8 },
  })
  assert.equal(capabilityProfileAxisFreshness(record, 'ocr', now), 'stale')
  assert.equal(capabilityProfileAxisFreshness(record, 'general', now), 'fresh')
})

test('cache prunes expired axes independently instead of deleting a mixed-age profile', async () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = 40 * DAY
  const cacheFile = '/virtual/capability-profiles.json'
  const mixed = recordBase({
    measuredAt: now - DAY,
    measuredAtByAxis: { ocr: now - 31 * DAY, general: now - DAY },
    scores: { ocr: 0.9, general: 0.8 },
    medianLatencyMs: { ocr: 200, general: 300 },
    fixtureCountByAxis: { ocr: 2, general: 1 },
    fixtureCount: 3,
  })
  const mem = memoryFs({
    [cacheFile]: JSON.stringify({ version: CAPABILITY_PROFILE_CACHE_VERSION, profiles: [mixed] }),
  })
  const [loaded] = await createCapabilityProfileStore({ cacheFile, fsOps: mem.ops, now: () => now }).list()
  assert.ok(loaded)
  assert.deepEqual(loaded.scores, { general: 0.8 })
  assert.deepEqual(loaded.measuredAtByAxis, { general: now - DAY })
  assert.deepEqual(loaded.fixtureCountByAxis, { general: 1 })
})

test('corrupt or wholly stale capability cache fails soft instead of poisoning routing', async () => {
  const cacheFile = '/virtual/capability-profiles.json'
  const corrupt = memoryFs({ [cacheFile]: '{not json' })
  const store = createCapabilityProfileStore({ cacheFile, fsOps: corrupt.ops, now: () => 100_000 })
  assert.deepEqual(await store.list(), [])

  const stale = memoryFs({
    [cacheFile]: JSON.stringify({
      version: CAPABILITY_PROFILE_CACHE_VERSION,
      profiles: [recordBase({ measuredAt: 1 })],
    }),
  })
  const staleStore = createCapabilityProfileStore({ cacheFile, fsOps: stale.ops, now: () => 200_000_000, maxAgeMs: 86_400_000 })
  assert.deepEqual(await staleStore.list(), [])
})