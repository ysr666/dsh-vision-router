import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function loadClientBundle() {
  let spec = null
  globalThis.window = { __ModuleLoader__: { load(s) { spec = s } } }
  const url = new URL('../lib/client.js', import.meta.url)
  // eslint-disable-next-line no-eval
  ;(0, eval)(readFileSync(url, 'utf8'))
  const ReactStub = {
    useState: (initial) => [initial, () => {}],
    useMemo: (fn) => fn(),
    useSyncExternalStore: () => ({ status: 'ready', writable: true, value: {}, user: {} }),
  }
  return spec.factory((name) => {
    if (name === 'react') return ReactStub
    if (name === '@deepseek-ai/dsh-client-ui-attachment') {
      return { ImageGallery: () => null }
    }
    throw new Error('require(' + name + ')')
  })
}

test('unwrapModelsResult reads the catalog from the RPC envelope', () => {
  const bundle = loadClientBundle()
  const groups = [{ id: 'deepseek-official', name: 'DeepSeek', models: [] }]
  const value = bundle.unwrapModelsResult({
    rpcId: 'x',
    result: { ok: true, value: { groups, failures: [] } },
  })
  assert.deepEqual(value.groups, groups)
  // plain values pass through untouched
  assert.deepEqual(bundle.unwrapModelsResult({ groups: [] }), { groups: [] })
  // failed envelopes throw with the host message
  assert.throws(
    () => bundle.unwrapModelsResult({ rpcId: 'x', result: { ok: false, error: { message: 'boom' } } }),
    /boom/,
  )
})

test('filterVisionBackendGroups hides text-only models and the internal vision-http route', () => {
  const bundle = loadClientBundle()
  const groups = [
    { id: 'vision-http', name: 'Vision HTTP', models: [{ id: 'free', name: 'free' }] },
    { id: 'opencode-go', name: 'opencode-go', models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'qwen-vl', name: 'Qwen VL' },
    ] },
  ]
  const filtered = bundle.filterVisionBackendGroups(groups, {
    'opencode-go': {
      'deepseek-v4-flash': { image: false },
      'qwen-vl': { image: true },
    },
  })
  assert.deepEqual(filtered.map((group) => [group.id, group.models.map((model) => model.id)]), [
    ['opencode-go', ['qwen-vl']],
  ])
  assert.deepEqual(bundle.filterVisionBackendGroups(groups, {}).map((group) => group.id), [])
})

test('the client bundle still loads and registers with the proven injects', () => {
  const bundle = loadClientBundle()
  assert.deepEqual(bundle.inject, ['settingsScope', 'slots', 'locale', 'sessions'])
  assert.equal(typeof bundle.apply, 'function')
})


test('model-selection guide separates session and vision models and targets the vision chain', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes("onboardingStep1Title: '1 · 会话 / 文字模型'"), true)
  assert.equal(source.includes("onboardingStep2Body: '打开「设置 → 插件 → Vision Router」"), true)
  assert.equal(source.includes("onboardingStep1Title: '1 · Session / text model'"), true)
  assert.equal(source.includes('Settings → Plugins → Vision Router'), true)
  assert.equal(source.includes("VISION_GUIDE_STORAGE_KEY = 'dsh-vision-router:guide:vision-backend-v1'"), true)
  assert.equal(source.includes('visionGuideActiveMemory = false'), true)
  assert.equal(source.includes('startVisionSettingsGuide(t)'), true)
  assert.equal(source.includes("id: 'vr-vision-backend-chain'"), true)
  assert.equal(source.includes("'data-vr-guide-target': 'vision-backend'"), true)
  assert.equal(source.includes("target.scrollIntoView({ behavior: 'smooth', block: 'center' })"), true)
  assert.equal(source.includes('if (!open) setOpen(true)'), true)
})
