import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPABILITY_PROFILE_CACHE_VERSION,
  capabilityProfileCachePath,
  createCapabilityProfileStore,
  runExactCapabilityBenchmark,
} from '../lib/vision-capability-probe.js'
import { CAPABILITY_BENCHMARK_SUITE_REVISION } from '../lib/vision-capability-benchmark.js'
import { capabilityEvidenceFingerprint } from '../lib/vision-capability-identity.js'

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
    benchmarkMedianLatencyMsByAxis: { general: 100 },
    fixtureCount: 1,
    failureCount: 0,
    ...overrides,
  }
}

test('exact benchmark probes one backend sequentially and stores benchmark latency as observation only', async () => {
  let clock = 10_000
  let active = 0
  let maxActive = 0
  const calls = []
  const backend = {
    provider: 'custom-provider',
    model: 'vision-model',
    endpoint: 'https://example.test/v1?api_key=secret&region=us',
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
      const output = outputForFixture(request.fixture)
      active -= 1
      return { output, usedFingerprint: request.backend.fingerprint, latencyMs: 7 }
    },
  })

  assert.equal(maxActive, 1)
  assert.equal(calls.length, 4)
  assert.equal(results.length, 4)
  assert.equal(record.fingerprint, capabilityEvidenceFingerprint(backend))
  assert.equal(record.scores.ocr, 1)
  assert.equal(record.scores.grounding, 1)
  assert.equal(record.scores.general, 1)
  assert.equal(record.benchmarkMedianLatencyMsByAxis.ocr, 7)
  assert.equal(record.benchmarkLatencyMs, 7)
  assert.equal('medianLatencyMs' in record, false)
  assert.equal('latencyMs' in record, false)
  assert.equal('endpoint' in record, false)
  assert.equal('config' in record, false)
})

test('backend fingerprint mismatch aborts instead of persisting fallback evidence', async () => {
  await assert.rejects(
    runExactCapabilityBenchmark({
      backend: { provider: 'p', model: 'm', endpoint: 'https://example.test/v1' },
      intents: ['general'],
      invoke: async () => ({ output: '3 circle square triangle', usedFingerprint: 'ep2_00000000000000000000000000000000' }),
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
      invoke: async () => { calls += 1; throw new Error('provider unavailable') },
    }),
    /provider unavailable/,
  )
  assert.equal(calls, 1)
})

test('capability profile store uses cache v4 and persists no freshness or secret material', async () => {
  assert.equal(CAPABILITY_PROFILE_CACHE_VERSION, 4)
  assert.match(capabilityProfileCachePath('/tmp/dsh-home'), /cache[\\/]vision-router[\\/]capability-profiles\.json$/)
  const mem = memoryFs()
  const cacheFile = '/virtual/capability-profiles.json'
  const store = createCapabilityProfileStore({ cacheFile, fsOps: mem.ops })
  const record = await store.put(recordBase({
    provider: 'provider-a',
    model: 'model-a',
    scores: { ocr: 0.91, grounding: 0.4, general: 0.82 },
    benchmarkMedianLatencyMsByAxis: { ocr: 123, grounding: 222, general: 456 },
    fixtureCount: 6,
    groundingDiagnostic: {
      score: 0.4,
      iou: 0.4,
      formatValid: true,
      parseSource: 'json',
      coordinateSpace: 'normalized-1000',
      responseShape: 'array',
      rawOutput: 'SECRET MUST NOT PERSIST',
    },
    endpoint: 'https://secret.example/v1',
    apiKey: 'never-persist-me',
  }))
  await store.flush()

  assert.deepEqual(record.measuredAtByAxis, { ocr: 50_000, grounding: 50_000, general: 50_000 })
  assert.equal(record.benchmarkMedianLatencyMsByAxis.ocr, 123)
  assert.equal(record.benchmarkLatencyMs, 222)
  const persistedText = mem.files.get(cacheFile)
  assert.equal(persistedText.includes('never-persist-me'), false)
  assert.equal(persistedText.includes('secret.example'), false)
  assert.equal(persistedText.includes('SECRET MUST NOT PERSIST'), false)
  assert.equal(/fresh|stale|expired/i.test(persistedText), false)
  const persisted = JSON.parse(persistedText)
  assert.equal(persisted.version, 4)
  assert.equal(mem.writes.at(-1).options.mode, 0o600)
})

test('cache v3 is not migrated because capability identity semantics changed in v4', async () => {
  const cacheFile = '/virtual/capability-profiles.json'
  const mem = memoryFs({
    [cacheFile]: JSON.stringify({ version: 3, profiles: [recordBase()] }),
  })
  assert.deepEqual(await createCapabilityProfileStore({ cacheFile, fsOps: mem.ops }).list(), [])
})

test('profile age never prunes capability observations', async () => {
  const cacheFile = '/virtual/capability-profiles.json'
  const old = recordBase({
    measuredAt: 1,
    measuredAtByAxis: { general: 1 },
    scores: { general: 0.8 },
  })
  const mem = memoryFs({
    [cacheFile]: JSON.stringify({ version: CAPABILITY_PROFILE_CACHE_VERSION, profiles: [old] }),
  })
  const [loaded] = await createCapabilityProfileStore({ cacheFile, fsOps: mem.ops }).list()
  assert.equal(loaded.scores.general, 0.8)
  assert.equal(loaded.measuredAtByAxis.general, 1)
})

test('partial retest updates only covered axes and keeps benchmark observations separate', async () => {
  const mem = memoryFs()
  const store = createCapabilityProfileStore({ cacheFile: '/virtual/capability-profiles.json', fsOps: mem.ops })
  const fingerprint = 'ep2_1234567890abcdef1234567890abcdef'
  await store.put(recordBase({
    fingerprint,
    measuredAt: 90_000,
    scores: { ocr: 0.8, document: 0.9, general: 0.8 },
    benchmarkMedianLatencyMsByAxis: { ocr: 600, document: 800, general: 500 },
    fixtureCount: 4,
  }))
  const returned = await store.put(recordBase({
    fingerprint,
    measuredAt: 100_000,
    scores: { ocr: 1, general: 1 },
    benchmarkMedianLatencyMsByAxis: { ocr: 350, general: 400 },
    fixtureCount: 3,
  }))

  assert.deepEqual(returned.scores, { ocr: 1, document: 0.9, general: 1 })
  assert.equal(returned.measuredAtByAxis.document, 90_000)
  assert.equal(returned.measuredAtByAxis.ocr, 100_000)
  assert.equal(returned.benchmarkMedianLatencyMsByAxis.document, 800)
  assert.equal(returned.benchmarkMedianLatencyMsByAxis.ocr, 350)
})

test('wrong-suite evidence is ignored rather than compared with the current suite', async () => {
  const cacheFile = '/virtual/capability-profiles.json'
  const mem = memoryFs({
    [cacheFile]: JSON.stringify({
      version: CAPABILITY_PROFILE_CACHE_VERSION,
      profiles: [recordBase({ suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION - 1 })],
    }),
  })
  assert.deepEqual(await createCapabilityProfileStore({ cacheFile, fsOps: mem.ops }).list(), [])
})
