import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createImageInputVerdictStore } from '../lib/vision-image-input-verdict.js'
import { CAPABILITY_BENCHMARK_SUITE_REVISION } from '../lib/vision-capability-benchmark.js'

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
        files.set(file, body)
        writes.push({ file, body, options })
      },
      async rename(from, to) {
        files.set(to, files.get(from))
        files.delete(from)
      },
      async rm(file) { files.delete(file) },
    },
  }
}

test('old and Host-text-only rejection verdicts never poison corrected models', async () => {
  const fp = 'ep2_0123456789abcdef0123456789abcdef'
  const file = '/virtual/legacy-verdicts.json'
  const legacy = [{ fingerprint: fp, key: 'p/m', provider: 'p', model: 'm', state: 'unsupported', measuredAt: 1, suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION }]
  const mem = memoryFs({ [file]: JSON.stringify({ version: 1, verdicts: legacy }) })
  const store = createImageInputVerdictStore({ cacheFile: file, fsOps: mem.ops })
  assert.equal(await store.get(fp), undefined)
  assert.equal(await store.markUnsupported({ fingerprint: fp, key: 'p/m', provider: 'p', model: 'm', hostMode: 'text-projected' }), undefined)
  assert.equal(await store.get(fp), undefined)
})

test('measured image rejection persists only a sanitized fingerprint-scoped verdict', async () => {
  const mem = memoryFs()
  const file = '/virtual/image-input-verdicts.json'
  const store = createImageInputVerdictStore({ cacheFile: file, fsOps: mem.ops })
  const fingerprint = 'ep2_0123456789abcdef0123456789abcdef'
  await store.markUnsupported({
    hostMode: 'native-image',
    fingerprint,
    key: 'deepseek-official/deepseek-v4-flash',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    measuredAt: 12345,
    error: 'SECRET RAW PROVIDER ERROR',
  })
  await store.flush()

  const verdict = await store.get(fingerprint)
  assert.equal(verdict.state, 'unsupported')
  assert.equal(verdict.reason, 'provider-rejected-image')
  assert.equal(verdict.measuredAt, 12345)
  assert.equal(mem.writes.at(-1).options.mode, 0o600)
  assert.doesNotMatch(mem.files.get(file), /SECRET RAW PROVIDER ERROR/)
})

test('successful explicit retest clears the exact fingerprint verdict', async () => {
  const mem = memoryFs()
  const store = createImageInputVerdictStore({ cacheFile: '/virtual/image-input-verdicts.json', fsOps: mem.ops })
  const fingerprint = 'ep2_abcdef0123456789abcdef0123456789'
  await store.markUnsupported({
    hostMode: 'native-image',
    fingerprint,
    key: 'provider/model',
    provider: 'provider',
    model: 'model',
    measuredAt: 100,
  })
  assert.ok(await store.get(fingerprint))
  assert.equal(await store.clear(fingerprint), true)
  assert.equal(await store.get(fingerprint), undefined)
})

test('oversized verdict cache is bounded on load and live survivors match the next persisted set', async () => {
  const file = '/virtual/image-input-verdicts.json'
  const verdicts = Array.from({ length: 140 }, (_, index) => ({
    fingerprint: `ep2_${(index + 1).toString(16).padStart(32, '0')}`,
    key: `provider/model-${index + 1}`,
    provider: 'provider',
    model: `model-${index + 1}`,
    state: 'unsupported',
    hostMode: 'native-image',
    reason: 'provider-rejected-image',
    measuredAt: index + 1,
    suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
  }))
  const mem = memoryFs({
    [file]: JSON.stringify({ version: 2, verdicts }),
  })
  const store = createImageInputVerdictStore({ cacheFile: file, fsOps: mem.ops })

  const loaded = await store.list()
  assert.equal(loaded.length, 128)
  assert.equal(loaded[0].measuredAt, 140)
  assert.equal(loaded.at(-1).measuredAt, 13)

  const newestFingerprint = `ep2_${'f'.repeat(32)}`
  assert.ok(await store.markUnsupported({
    hostMode: 'native-image',
    fingerprint: newestFingerprint,
    key: 'provider/newest',
    provider: 'provider',
    model: 'newest',
    measuredAt: 1_000,
  }))
  const live = await store.list()
  assert.equal(live.length, 128)
  await store.flush()
  const disk = JSON.parse(mem.files.get(file)).verdicts
  assert.deepEqual(disk.map((item) => item.fingerprint), live.map((item) => item.fingerprint))

  const tooOldFingerprint = `ep2_${'e'.repeat(32)}`
  assert.equal(await store.markUnsupported({
    hostMode: 'native-image',
    fingerprint: tooOldFingerprint,
    key: 'provider/too-old',
    provider: 'provider',
    model: 'too-old',
    measuredAt: 1,
  }), undefined)
  assert.equal((await store.list()).some((item) => item.fingerprint === tooOldFingerprint), false)
})

test('transient destination lock retries the atomic cache replace without losing data', async () => {
  const mem = memoryFs()
  const rename = mem.ops.rename
  const file = '/virtual/atomic-retry.json'
  let attempts = 0
  mem.ops.rename = async (from, to) => {
    attempts++
    if (attempts <= 2) {
      const error = new Error('temporarily locked destination')
      error.code = 'EBUSY'
      throw error
    }
    return rename(from, to)
  }
  const warnings = []
  const store = createImageInputVerdictStore({ cacheFile: file, fsOps: mem.ops, logger: {
    warn(...args) { warnings.push(args) },
  } })
  await store.markUnsupported({
    fingerprint: 'ep2_' + 'a'.repeat(32),
    key: 'a', provider: 'p', model: 'm', hostMode: 'native-image',
  })
  await store.flush()
  assert.equal(attempts, 3)
  assert.equal(warnings.length, 0)
  assert.equal(JSON.parse(mem.files.get(file)).verdicts.length, 1)
  assert.equal([...mem.files.keys()].filter((name) => name.endsWith('.tmp')).length, 0)
})

test('permanent cache replace failure is reported and removes its private temporary file', async () => {
  const mem = memoryFs()
  const file = '/virtual/permanent-error.json'
  mem.ops.rename = async () => {
    const error = new Error('disk rejected rename')
    error.code = 'EIO'
    throw error
  }
  const warnings = []
  const store = createImageInputVerdictStore({ cacheFile: file, fsOps: mem.ops, logger: {
    warn(...args) { warnings.push(args) },
  } })
  await store.markUnsupported({
    fingerprint: 'ep2_' + 'b'.repeat(32),
    key: 'b', provider: 'p', model: 'm', hostMode: 'native-image',
  })
  await store.flush()
  assert.equal(warnings.length, 1)
  assert.equal(mem.files.has(file), false)
  assert.equal([...mem.files.keys()].filter((name) => name.endsWith('.tmp')).length, 0)
})
