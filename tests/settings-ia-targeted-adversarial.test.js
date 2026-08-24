import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { SETTINGS_IA_CLIENT_PRELUDE } from '../lib/settings-ia-client-prelude.js'
import { migrateLegacyVisionSettings } from '../lib/settings-migration.js'

function baseSettings(overrides = {}) {
  return {
    providers: [{ provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] }],
    freeFallback: true,
    tool: true,
    structuredVisionBootstrap: false,
    visionDepth: 'standard',
    visionDepthMaxCalls: 0,
    guidanceOverrides: [],
    localOllama: { enabled: false, baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5vl', format: 'openai' },
    localLmStudio: { enabled: false, baseURL: 'http://localhost:1234/v1', model: '', format: 'openai' },
    desktopScreenshot: false,
    downscale: true,
    downscaleMaxPixels: 4000000,
    cache: true,
    cacheTtlSeconds: 3600,
    cacheMaxEntries: 200,
    timeoutMs: 120000,
    visionTaskTimeoutMs: 120000,
    visionTurnBudgetMs: 0,
    ocrTimeoutMs: 30000,
    freeCloudFirst: false,
    autoWrapProviders: true,
    wrappedProviders: [{ provider: 'deepseek-official', models: [] }],
    allowRemoteSettings: false,
    proxy: '',
    proxyHosts: [],
    rewriteImages: true,
    routing: false,
    reverseRouting: true,
    textProvider: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    progressiveTools: false,
    stealth: false,
    wrapperRoute: 'deepseek-vision',
    chainRoute: 'vision-chain',
    extraVisionModels: [],
    settingsContractRevision: 4,
    ...overrides,
  }
}

function parseLocalProviderDraft(value, defaults) {
  const input = value && typeof value === 'object' ? value : {}
  const temperature =
    typeof input.temperature === 'number' && Number.isFinite(input.temperature)
      ? Math.min(2, Math.max(0, input.temperature))
      : undefined
  const topP =
    typeof input.top_p === 'number' && Number.isFinite(input.top_p)
      ? Math.min(1, Math.max(0, input.top_p))
      : undefined
  return {
    enabled: input.enabled === true,
    baseURL:
      typeof input.baseURL === 'string' && input.baseURL.trim() !== ''
        ? input.baseURL.trim()
        : defaults.baseURL,
    model:
      typeof input.model === 'string' && input.model.trim() !== ''
        ? input.model.trim()
        : defaults.model,
    format: input.format === 'anthropic' ? 'anthropic' : 'openai',
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { top_p: topP }),
  }
}

function reactStub(stateValues, stateWrites, effects) {
  let index = 0
  return {
    Fragment: Symbol('Fragment'),
    beginRender() { index = 0 },
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useMemo(factory) { return factory() },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    useState(initial) {
      const slot = index++
      const value = slot < stateValues.length ? stateValues[slot] : initial
      return [value, (next) => stateWrites.push({ slot, next })]
    },
    useEffect(effect) { effects.push(effect) },
    useRef(initial) { return { current: initial } },
  }
}

function walk(node, visit) {
  if (node === null || node === undefined || node === false) return
  if (typeof node === 'string' || typeof node === 'number') return visit(node)
  if (Array.isArray(node)) return node.forEach((item) => walk(item, visit))
  if (typeof node !== 'object') return
  visit(node)
  for (const child of Array.isArray(node.children) ? node.children : []) walk(child, visit)
}

function textOf(node) {
  const parts = []
  walk(node, (item) => {
    if (typeof item === 'string' || typeof item === 'number') parts.push(String(item))
  })
  return parts.join(' ')
}

function findAll(tree, predicate) {
  const found = []
  walk(tree, (node) => {
    if (node && typeof node === 'object' && predicate(node)) found.push(node)
  })
  return found
}

function button(tree, label) {
  const hit = findAll(tree, (node) => node.type === 'button' && textOf(node).trim() === label)[0]
  assert.ok(hit, `button ${label} must exist`)
  return hit
}

function settingsHarness({
  page = 'general',
  drafts = {},
  value = baseSettings(),
  catalog = { status: 'ready', groups: [], failures: [] },
  caps = { status: 'ready', capabilities: {}, builtinFallback: [], anonymousRpmPerModel: 2 },
  includeClientHelpers = true,
} = {}) {
  const stateWrites = []
  const effects = []
  const fetchCalls = []
  const React = reactStub([
    page,
    drafts,
    undefined,
    undefined,
    undefined,
    { status: 'idle' },
    catalog,
    { ollama: false, lmstudio: false, developer: true },
    caps,
    { status: 'idle' },
    { status: 'idle' },
    { status: 'idle' },
    { status: 'idle' },
  ], stateWrites, effects)

  let captured
  let Component
  const loader = { load(spec) { captured = spec } }
  const sandbox = {
    window: {
      __ModuleLoader__: loader,
      location: { hostname: '127.0.0.1' },
      confirm() { return true },
    },
    document: { documentElement: { lang: 'zh-CN' } },
    navigator: { clipboard: { async writeText() {} } },
    fetch: async (...args) => {
      fetchCalls.push(args)
      return { ok: true, status: 200, async json() { return {} } }
    },
    // Deliberately inject host intrinsics. Objects created by the evaluated
    // prelude still belong to the VM realm, so constructor-identity checks
    // reproduce the cross-realm failure mode that the compatibility fallback
    // must not depend on.
    Object,
    Promise,
    Array,
    String,
    Number,
    Map,
    Set,
    WeakMap,
    Reflect,
    JSON,
  }
  vm.runInNewContext(SETTINGS_IA_CLIENT_PRELUDE, sandbox)

  loader.load({
    id: 'dsh-vision-router',
    factory() {
      return {
        ...(includeClientHelpers ? { parseLocalProviderDraft } : {}),
        apply(ctx) {
          ctx.slots.register({ name: 'settings.section', id: 'vision-router' }, function Legacy() {})
        },
      }
    },
  })
  const plugin = captured.factory((id) => {
    assert.equal(id, 'react')
    return React
  })
  plugin.apply({
    slots: { register(_options, component) { Component = component; return () => {} } },
    locale: { define() {} },
  })

  let snapshot = {
    status: 'ready',
    writable: true,
    mode: 'host',
    value,
    user: {},
    revision: 3,
  }
  const scope = {
    subscribe() { return () => {} },
    getSnapshot() { return snapshot },
    async load() {},
    async set(key, next) {
      snapshot = { ...snapshot, value: { ...snapshot.value, [key]: next }, user: { ...snapshot.user, [key]: next } }
    },
    async unset(key) {
      const nextUser = { ...snapshot.user }
      delete nextUser[key]
      snapshot = { ...snapshot, user: nextUser }
    },
  }

  return {
    fetchCalls,
    stateWrites,
    tree() {
      React.beginRender()
      return Component({ scope })
    },
    async runEffects() {
      const pending = effects.splice(0)
      for (const effect of pending) effect()
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

test('adversarial: historical nested fallbacks are visible rows and cannot ride across a provider edit', () => {
  const view = settingsHarness({
    value: baseSettings({
      freeFallback: false,
      providers: [{
        provider: 'openrouter',
        model: 'qwen-vl',
        fallbacks: ['qwen-vl-backup', 'qwen-vl-last'],
      }],
    }),
  })
  const tree = view.tree()
  const modelInputs = findAll(tree, (node) => node.type === 'input' && node.props.placeholder === 'model')
  assert.deepEqual(
    modelInputs.map((node) => node.props.value),
    ['qwen-vl', 'qwen-vl-backup', 'qwen-vl-last'],
  )

  const providerInputs = findAll(tree, (node) => node.type === 'input' && node.props.placeholder === 'provider')
  assert.equal(providerInputs.length, 3)
  providerInputs[0].props.onChange({ target: { value: 'zhipu' } })

  const write = view.stateWrites.find((entry) => entry.slot === 2 && Array.isArray(entry.next))
  assert.ok(write, 'editing the chain must write the chain draft slot')
  assert.equal(write.next[0].provider, 'zhipu')
  assert.deepEqual(write.next[0].fallbacks, [])
  assert.deepEqual(
    write.next.slice(1).map((row) => [row.provider, row.model, row.fallbacks]),
    [
      ['openrouter', 'qwen-vl-backup', []],
      ['openrouter', 'qwen-vl-last', []],
    ],
  )
})

test('adversarial: diagnostics performs no connection or update probe until the user clicks', async () => {
  const view = settingsHarness({ page: 'diagnostics' })
  view.tree()
  await view.runEffects()

  assert.equal(view.fetchCalls.some(([url]) => String(url).includes('/test-connection')), false)
  assert.equal(view.fetchCalls.some(([url]) => String(url).includes('/update-check')), false)

  button(view.tree(), '测试连接').props.onClick()
  button(view.tree(), '检查更新').props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(view.fetchCalls.some(([url]) => url === '/_dsh/vision-router/test-connection'), true)
  assert.equal(view.fetchCalls.some(([url]) => url === '/_dsh/vision-router/update-check?force=1'), true)
})

test('adversarial: old-bundle compatibility parsing rejects blank enabled LM Studio across VM realms', () => {
  const view = settingsHarness({
    page: 'local',
    includeClientHelpers: false,
    drafts: {
      localLmStudio: {
        enabled: true,
        baseURL: 'http://localhost:1234/v1',
        model: '',
        format: 'openai',
      },
    },
  })
  const tree = view.tree()
  assert.match(textOf(tree), /启用 LM Studio 时必须填写真实模型标识/)
  assert.equal(button(tree, '保存').props.disabled, true)
})

test('adversarial: migration conflict re-reads settings and never overwrites a concurrent providers chain', async () => {
  const concurrentProviders = [{ provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: [] }]
  let describes = 0
  const mutations = []
  const settings = {
    writable: true,
    describe() {
      describes += 1
      if (describes === 1) {
        return [{
          ns: 'vision-router',
          revision: 4,
          user: {
            provider: 'openrouter',
            model: 'qwen-vl',
            fallbacks: ['qwen-vl-backup'],
          },
          value: {
            provider: 'openrouter',
            model: 'qwen-vl',
            fallbacks: ['qwen-vl-backup'],
            providers: [{ provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] }],
          },
        }]
      }
      return [{
        ns: 'vision-router',
        revision: 5,
        user: {
          providers: concurrentProviders,
          provider: 'openrouter',
          model: 'qwen-vl',
          fallbacks: ['qwen-vl-backup'],
        },
        value: {
          provider: 'openrouter',
          model: 'qwen-vl',
          fallbacks: ['qwen-vl-backup'],
          providers: concurrentProviders,
        },
      }]
    },
    async mutate(ns, ops, revision) {
      mutations.push({ ns, ops, revision })
      if (mutations.length === 1) {
        const error = new Error('stale settings revision')
        error.code = 'SETTINGS_CONFLICT'
        throw error
      }
    },
  }

  const result = await migrateLegacyVisionSettings(settings)
  assert.equal(result.migrated, true)
  assert.equal(describes, 2)
  assert.equal(mutations.length, 2)
  assert.equal(mutations[1].revision, 5)
  assert.equal(mutations[1].ops.some((op) => op.op === 'set' && op.path[0] === 'providers'), false)
  assert.deepEqual(
    mutations[1].ops.map((op) => [op.op, op.path[0]]),
    [
      ['unset', 'provider'],
      ['unset', 'model'],
      ['unset', 'fallbacks'],
    ],
  )
})
