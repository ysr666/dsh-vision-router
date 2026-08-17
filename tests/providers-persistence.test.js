import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function loadClientBundle() {
  let spec = null
  globalThis.window = { __ModuleLoader__: { load(s) { spec = s } } }
  const url = new URL('../lib/client.js', import.meta.url)
  // eslint-disable-next-line no-eval
  ;(0, eval)(readFileSync(url, 'utf8'))
  const ReactStub = { memo: (value) => value }
  return spec.factory((name) => {
    if (name === 'react') return ReactStub
    if (name === '@deepseek-ai/dsh-client-ui-attachment') return { ImageGallery: () => null }
    throw new Error('require(' + name + ')')
  })
}

test('providers save canonicalizes fallback defaults and survives reopen/restart', async () => {
  const bundle = loadClientBundle()
  const sparse = [{ provider: 'zhipu', model: 'glm-4.6v-flash' }]
  const normalized = [{ provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: [] }]

  assert.deepEqual(bundle.canonicalizeProviders(sparse), normalized)
  assert.equal(bundle.settingsValueEqual('providers', sparse, normalized), true)
  assert.equal(
    bundle.settingsValueEqual(
      'other',
      { provider: 'x', model: 'y' },
      { provider: 'x', model: 'y', fallbacks: [] },
    ),
    false,
  )

  const run = bundle.canonicalizeSettingsRun('providers', { value: sparse })
  assert.deepEqual(run.value, normalized)

  const snapshot = { status: 'ready', writable: true, user: {} }
  const persisted = {}
  const outcome = await bundle.commitSettingsPlan({
    async set(field, value) {
      persisted[field] = structuredClone(value)
      snapshot.user[field] = structuredClone(value)
    },
    getSnapshot() { return snapshot },
  }, [{ key: 'providers', run }], { providers: sparse })

  assert.equal(outcome.landed, true)
  assert.equal(outcome.failed, false)
  assert.deepEqual(persisted.providers, normalized)

  const reopened = bundle.normalizeVisionChainRows(structuredClone(persisted.providers))
  const restarted = bundle.normalizeVisionChainRows(JSON.parse(JSON.stringify(persisted.providers)))
  assert.deepEqual(reopened, normalized)
  assert.deepEqual(restarted, normalized)
  assert.equal(restarted[0].provider, 'zhipu')
  assert.equal(restarted[0].model, 'glm-4.6v-flash')
})

test('providers readback accepts inserted empty fallbacks but rejects a real model mismatch', async () => {
  const bundle = loadClientBundle()
  const requested = [{ provider: 'zhipu', model: 'glm-4.6v-flash' }]
  const snapshot = { status: 'ready', writable: true, user: {} }

  const accepted = await bundle.commitSettingsPlan({
    async set(field) {
      snapshot.user[field] = [{ provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: [] }]
    },
    getSnapshot() { return snapshot },
  }, [{ key: 'providers', run: { value: requested } }], { providers: requested })
  assert.equal(accepted.landed, true)

  const rejected = await bundle.commitSettingsPlan({
    async set(field) {
      snapshot.user[field] = [{ provider: 'zhipu', model: 'different-model', fallbacks: [] }]
    },
    getSnapshot() { return snapshot },
  }, [{ key: 'providers', run: { value: requested } }], { providers: requested })
  assert.equal(rejected.landed, false)
  assert.equal(rejected.failures[0].reason, 'readback-mismatch')
})

test('vision chain editor preserves or initializes fallbacks on provider/model edits', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("{ provider: '', model: '', fallbacks: [] }"), true)
  assert.equal(
    source.includes('fallbacks: row.fallbacks === undefined ? [] : row.fallbacks'),
    true,
  )
})
