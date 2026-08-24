import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { SETTINGS_IA_CLIENT_PRELUDE } from '../lib/settings-ia-client-prelude.js'

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

function reactStub(stateValues = [], stateWrites = []) {
  let index = 0
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useMemo(factory) { return factory() },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    useState(initial) {
      const slot = index++
      const value = slot < stateValues.length ? stateValues[slot] : initial
      return [value, (next) => stateWrites.push({ slot, next })]
    },
    useEffect() {},
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

function containing(tree, needle) {
  return findAll(tree, (node) => typeof node.type === 'string' && textOf(node).includes(needle))[0]
}

function harness({
  page = 'general',
  drafts = {},
  value = baseSettings(),
  user = {},
  status = 'ready',
  writable = true,
  mode = 'host',
  remoteDisabled = false,
  remoteReason,
  remoteErrorCode,
  catalog = { status: 'ready', groups: [], failures: [] },
  caps = { status: 'ready', capabilities: {}, builtinFallback: [], anonymousRpmPerModel: 2 },
  local = true,
  fetchImpl,
  mutateScope,
} = {}) {
  const stateWrites = []
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
  ], stateWrites)

  let captured
  let Component
  const loader = { load(spec) { captured = spec } }
  const fetchCalls = []
  const sandbox = {
    window: {
      __ModuleLoader__: loader,
      location: { hostname: local ? '127.0.0.1' : '10.0.0.20' },
      confirm() { return true },
    },
    document: { documentElement: { lang: 'zh-CN' } },
    navigator: { clipboard: { async writeText() {} } },
    fetch: async (...args) => {
      fetchCalls.push(args)
      if (fetchImpl) return fetchImpl(...args)
      return { ok: true, status: 200, async json() { return {} } }
    },
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
    status,
    writable,
    mode,
    remoteDisabled,
    remoteReason,
    remoteErrorCode,
    value,
    user,
    revision: 3,
  }
  const calls = []
  const scope = {
    subscribe() { return () => {} },
    getSnapshot() { return snapshot },
    async load() { calls.push(['load']) },
    async set(key, next) {
      calls.push(['set', key, next])
      if (mutateScope) return mutateScope({ operation: 'set', key, value: next, snapshot, setSnapshot: (nextSnapshot) => { snapshot = nextSnapshot } })
      snapshot = { ...snapshot, value: { ...snapshot.value, [key]: next }, user: { ...snapshot.user, [key]: next } }
    },
    async unset(key) {
      calls.push(['unset', key])
      if (mutateScope) return mutateScope({ operation: 'unset', key, snapshot, setSnapshot: (nextSnapshot) => { snapshot = nextSnapshot } })
      const nextUser = { ...snapshot.user }
      delete nextUser[key]
      snapshot = { ...snapshot, user: nextUser }
    },
  }
  return { Component, scope, tree: () => Component({ scope }), calls, fetchCalls, stateWrites, getSnapshot: () => snapshot }
}

test('acceptance: remote disabled/unavailable settings render an actionable state instead of blank', () => {
  const remote = harness({
    status: 'unavailable',
    writable: false,
    mode: 'remote',
    local: false,
    remoteDisabled: true,
    remoteReason: 'permission-disabled',
  })
  const text = textOf(remote.tree())
  assert.match(text, /远程设置未启用/)
  assert.match(text, /重试/)
})

test('acceptance: the local permission shim string form still renders allowRemoteSettings as enabled', () => {
  const view = harness({
    page: 'advanced',
    value: baseSettings({ allowRemoteSettings: 'true' }),
    user: { allowRemoteSettings: 'true' },
  })
  const section = containing(view.tree(), '允许可信 Host 远程修改设置')
  assert.ok(section)
  const checkbox = findAll(section, (node) => node.type === 'input' && node.props.type === 'checkbox')[0]
  assert.ok(checkbox)
  assert.equal(checkbox.props.checked, true)
  assert.match(textOf(section), /恢复默认/)
})

test('acceptance: a resolved-but-unlanded write is retried and never treated as success', async () => {
  const view = harness({
    page: 'advanced',
    drafts: { cache: false },
    user: {},
    mutateScope() {
      // Deliberately resolve without changing snapshot.user: this is the exact
      // Host failure mode that previously produced false “saved” UI.
    },
  })
  const save = button(view.tree(), '保存')
  await save.props.onClick()
  assert.equal(view.calls.filter((call) => call[0] === 'set' && call[1] === 'cache').length, 2)
  assert.equal(view.calls.some((call) => call[0] === 'load'), true)
  assert.equal(view.stateWrites.some((write) => write.slot === 5 && write.next?.status === 'saved'), false)
  assert.equal(view.stateWrites.some((write) => write.slot === 5 && write.next?.status === 'error'), true)
})

test('acceptance: only landed fields clear while a failed draft remains reported', async () => {
  const view = harness({
    page: 'advanced',
    drafts: { cache: false, downscale: false },
    user: {},
    mutateScope({ key, value, snapshot, setSnapshot }) {
      if (key !== 'cache') return
      setSnapshot({ ...snapshot, value: { ...snapshot.value, [key]: value }, user: { ...snapshot.user, [key]: value } })
    },
  })
  await button(view.tree(), '保存').props.onClick()
  const draftWrite = view.stateWrites.find((write) => write.slot === 1 && typeof write.next === 'function')
  assert.ok(draftWrite, 'landed fields must update the draft object')
  const nextDrafts = draftWrite.next({ cache: false, downscale: false })
  assert.equal(Object.hasOwn(nextDrafts, 'cache'), false)
  assert.equal(nextDrafts.downscale, false)
  assert.equal(view.stateWrites.some((write) => write.slot === 5 && write.next?.status === 'error'), true)
})

test('acceptance: saving desktop capture on triggers the native permission probe only after readback lands', async () => {
  const view = harness({ page: 'local', drafts: { desktopScreenshot: true } })
  await button(view.tree(), '保存').props.onClick()
  assert.equal(view.fetchCalls.some(([url, init]) => url === '/_dsh/vision-router/request-screenshot-permission' && init?.method === 'POST'), true)
})

test('acceptance: overridden fields retain the user-layer reset path', async () => {
  const view = harness({ page: 'advanced', user: { cache: true } })
  const reset = button(view.tree(), '恢复默认')
  await reset.props.onClick()
  assert.deepEqual(view.calls.find((call) => call[0] === 'unset'), ['unset', 'cache'])
})

test('acceptance: invalid numbers, blank enabled LM Studio, and half text fallback block save', () => {
  const badNumber = harness({ page: 'advanced', drafts: { timeoutMs: 999 } })
  assert.equal(button(badNumber.tree(), '保存').props.disabled, true)

  const badLocal = harness({
    page: 'local',
    drafts: { localLmStudio: { enabled: true, baseURL: 'http://localhost:1234/v1', model: '', format: 'openai' } },
  })
  assert.equal(button(badLocal.tree(), '保存').props.disabled, true)
  assert.match(textOf(badLocal.tree()), /启用 LM Studio 时必须填写真实模型标识/)

  const badText = harness({
    page: 'advanced',
    value: baseSettings({ routing: true }),
    drafts: { textProvider: { provider: 'deepseek-official', model: '' } },
  })
  assert.equal(button(badText.tree(), '保存').props.disabled, true)
  assert.match(textOf(badText.tree()), /Provider 和 model 必须同时填写/)
})

test('acceptance: structural non-generative capability rejects stay out of the vision picker', () => {
  const view = harness({
    value: baseSettings({ providers: [{ provider: 'openrouter', model: 'good-vl', fallbacks: [] }] }),
    catalog: {
      status: 'ready',
      failures: [],
      groups: [{ id: 'openrouter', name: 'OpenRouter', models: [{ id: 'good-vl' }, { id: 'bad-embedding-vl' }] }],
    },
    caps: {
      status: 'ready',
      builtinFallback: [],
      anonymousRpmPerModel: 2,
      capabilities: {
        openrouter: {
          'good-vl': { attemptable: true, image: true },
          'bad-embedding-vl': { attemptable: false, image: false, reason: 'non-generative' },
        },
      },
    },
  })
  const text = textOf(view.tree())
  assert.match(text, /good-vl/)
  assert.doesNotMatch(text, /bad-embedding-vl/)
})

test('acceptance: diagnostics retains operational controls from the previous settings surface', () => {
  const view = harness({ page: 'diagnostics' })
  const text = textOf(view.tree())
  for (const expected of ['测试连接', '重新检测模型', '打开日志文件夹', '复制诊断信息', '版本更新', '检查更新', 'dsh-vision-router doctor']) {
    assert.match(text, new RegExp(expected))
  }
})

test('acceptance: every necessary editable setting from the old surface has one destination in the new IA', () => {
  const expected = [
    'providers', 'freeFallback',
    'tool', 'structuredVisionBootstrap', 'visionDepth', 'visionDepthMaxCalls', 'guidanceOverrides',
    'localOllama', 'localLmStudio', 'desktopScreenshot',
    'downscale', 'downscaleMaxPixels', 'cache', 'cacheTtlSeconds', 'cacheMaxEntries',
    'timeoutMs', 'visionTaskTimeoutMs', 'visionTurnBudgetMs', 'ocrTimeoutMs', 'freeCloudFirst',
    'autoWrapProviders', 'wrappedProviders', 'allowRemoteSettings', 'proxy', 'proxyHosts',
    'rewriteImages', 'routing', 'reverseRouting', 'textProvider',
    'progressiveTools', 'stealth', 'wrapperRoute', 'chainRoute', 'extraVisionModels',
  ]
  for (const key of expected) assert.match(SETTINGS_IA_CLIENT_PRELUDE, new RegExp(`['\"]${key}['\"]`), key)
  for (const retired of ['instantDescribe', 'localDescribeStyle', 'visionGuideStep']) {
    assert.doesNotMatch(SETTINGS_IA_CLIENT_PRELUDE, new RegExp(`['\"]${retired}['\"]`), retired)
  }
})
