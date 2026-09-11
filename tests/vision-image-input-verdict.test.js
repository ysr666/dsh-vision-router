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
    },
  }
}

test('measured image rejection persists only a sanitized fingerprint-scoped verdict', async () => {
  const mem = memoryFs()
  const file = '/virtual/image-input-verdicts.json'
  const store = createImageInputVerdictStore({ cacheFile: file, fsOps: mem.ops })
  const fingerprint = 'ep2_0123456789abcdef0123456789abcdef'
  await store.markUnsupported({
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
    reason: 'provider-rejected-image',
    measuredAt: index + 1,
    suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
  }))
  const mem = memoryFs({
    [file]: JSON.stringify({ version: 1, verdicts }),
  })
  const store = createImageInputVerdictStore({ cacheFile: file, fsOps: mem.ops })

  const loaded = await store.list()
  assert.equal(loaded.length, 128)
  assert.equal(loaded[0].measuredAt, 140)
  assert.equal(loaded.at(-1).measuredAt, 13)

  const newestFingerprint = `ep2_${'f'.repeat(32)}`
  assert.ok(await store.markUnsupported({
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
    fingerprint: tooOldFingerprint,
    key: 'provider/too-old',
    provider: 'provider',
    model: 'too-old',
    measuredAt: 1,
  }), undefined)
  assert.equal((await store.list()).some((item) => item.fingerprint === tooOldFingerprint), false)
})
