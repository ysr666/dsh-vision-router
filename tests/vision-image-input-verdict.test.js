import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createImageInputVerdictStore } from '../lib/vision-image-input-verdict.js'

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
