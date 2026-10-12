import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createImageInputVerdictStore } from '../lib/vision-image-input-verdict.js'

async function withTempDir(prefix, fn) {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  try { return await fn(root) }
  finally { await rm(root, { recursive: true, force: true }) }
}

test('independent cache writers cannot collide on a same-millisecond atomic temp path', async () => {
  await withTempDir('dvr-cache-race-', async (root) => {
    const file = path.join(root, 'image-input-verdicts.json')
    const warnings = []
    const logger = { warn(...args) { warnings.push(args) } }
    const originalNow = Date.now
    Date.now = () => 1790645000000
    try {
      const first = createImageInputVerdictStore({ cacheFile: file, logger })
      const second = createImageInputVerdictStore({ cacheFile: file, logger })
      await Promise.all([first.list(), second.list()])
      await Promise.all([
        first.markUnsupported({
          fingerprint: `ep2_${'a'.repeat(32)}`,
          key: 'first', provider: 'provider-a', model: 'model-a', hostMode: 'native-image',
        }),
        second.markUnsupported({
          fingerprint: `ep2_${'b'.repeat(32)}`,
          key: 'second', provider: 'provider-b', model: 'model-b', hostMode: 'native-image',
        }),
      ])
      await Promise.all([first.flush(), second.flush()])
      assert.equal(warnings.length, 0)
      const body = JSON.parse(await readFile(file, 'utf8'))
      assert.equal(body.version, 2)
      assert.equal(Array.isArray(body.verdicts), true)
      assert.equal(body.verdicts.length, 1, 'independent snapshots may remain last-writer-wins, but publication must stay atomic')
    } finally {
      Date.now = originalNow
    }
  })
})
