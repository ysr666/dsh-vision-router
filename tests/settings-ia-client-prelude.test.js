import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import {
  SETTINGS_IA_CLIENT_PRELUDE,
  injectSettingsIaClientPrelude,
} from '../lib/settings-ia-client-prelude.js'
import {
  SETTINGS_NATIVE_CARD_IA_PRELUDE,
  SETTINGS_NATIVE_CARD_STYLE,
  transformSettingsIaToNativeCards,
} from '../lib/settings-native-card-layout.js'

function reactStub(stateValues = []) {
  let stateIndex = 0
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useMemo(factory) { return factory() },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    useState(initial) {
      const index = stateIndex++
      const value = index < stateValues.length ? stateValues[index] : initial
      return [value, () => {}]
    },
    useEffect() {},
    useRef(initial) { return { current: initial } },
  }
}

function walk(node, visit) {
  if (node === undefined || node === null || node === false) return
  if (typeof node === 'string' || typeof node === 'number') {
    visit(node)
    return
  }
  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, visit))
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  for (const child of Array.isArray(node.children) ? node.children : []) walk(child, visit)
}

function textOf(tree) {
  const parts = []
  walk(tree, (node) => {
    if (typeof node === 'string' || typeof node === 'number') parts.push(String(node))
  })
  return parts.join(' ')
}

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
    ...overrides,
  }
}

function createHarness(React, {
  value = baseSettings(),
  local = true,
  prelude = SETTINGS_IA_CLIENT_PRELUDE,
} = {}) {
  let captured
  const loader = { load(spec) { captured = spec } }
  const sandbox = {
    window: {
      __ModuleLoader__: loader,
      location: { hostname: local ? '127.0.0.1' : '10.0.0.20' },
    },
    document: { documentElement: { lang: 'zh-CN' } },
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
  vm.runInNewContext(prelude, sandbox)

  let registeredComponent
  const OriginalSection = function OriginalSection() { return { type: 'legacy-section' } }
  loader.load({
    id: 'dsh-vision-router',
    factory() {
      return {
        apply(ctx) {
          ctx.slots.register(
            { name: 'settings.section', id: 'vision-router', order: 12 },
            OriginalSection,
          )
        },
      }
    },
  })

  const plugin = captured.factory((id) => {
    assert.equal(id, 'react')
    return React
  })
  const ctx = {
    slots: {
      register(_options, component) {
        registeredComponent = component
        return () => {}
      },
    },
  }
  plugin.apply(ctx)

  const scope = {
    subscribe() { return () => {} },
    getSnapshot() { return { status: 'ready', writable: true, value } },
    async set() {},
    async load() {},
  }
  return { registeredComponent, OriginalSection, scope }
}

test('settings IA prelude injects once', () => {
  const html = '<html><head></head><body></body></html>'
  const once = injectSettingsIaClientPrelude(html)
  assert.match(once, /data-vision-router-settings-ia/)
  assert.equal(injectSettingsIaClientPrelude(once), once)
})

test('settings IA replaces the legacy section and exposes five second-level destinations', () => {
  const React = reactStub()
  const { registeredComponent, OriginalSection, scope } = createHarness(React)
  assert.notEqual(registeredComponent, OriginalSection)

  const tree = registeredComponent({ scope })
  const text = textOf(tree)
  for (const label of ['常规', '识图策略', '本地与设备', '高级', '诊断']) assert.match(text, new RegExp(label))
  assert.match(text, /内置免费识图/)
})

test('native card composition is parseable, drift-guarded, and removes sticky chrome', () => {
  assert.doesNotThrow(() => new vm.Script(SETTINGS_NATIVE_CARD_IA_PRELUDE))
  assert.match(SETTINGS_NATIVE_CARD_IA_PRELUDE, /vr-ia-plugin-card-header/)
  assert.doesNotMatch(SETTINGS_NATIVE_CARD_IA_PRELUDE, /data-vr-guide-bridge/)
  assert.match(SETTINGS_NATIVE_CARD_IA_PRELUDE, /startVisionSettingsGuide/)
  assert.match(SETTINGS_NATIVE_CARD_IA_PRELUDE, /重新查看新手引导/)
  assert.doesNotMatch(SETTINGS_NATIVE_CARD_IA_PRELUDE, /vr-ia-nav-item/)
  assert.doesNotMatch(SETTINGS_NATIVE_CARD_STYLE, /position\s*:\s*sticky/i)
  assert.doesNotMatch(SETTINGS_NATIVE_CARD_STYLE, /backdrop-filter/i)
  assert.throws(
    () => transformSettingsIaToNativeCards('not-the-settings-ia'),
    /settings native-card transform anchor missing/,
  )
})

test('native card composition renders five disclosure cards and restores guide replay action', () => {
  const React = reactStub()
  const { registeredComponent, scope } = createHarness(React, {
    prelude: SETTINGS_NATIVE_CARD_IA_PRELUDE,
  })

  const tree = registeredComponent({ scope })
  const headers = []
  walk(tree, (node) => {
    if (node && typeof node === 'object' && node.props?.className === 'vr-ia-plugin-card-header') {
      headers.push(node)
    }
  })

  assert.equal(headers.length, 5)
  assert.equal(headers.filter((node) => node.props['aria-expanded'] === true).length, 1)
  assert.match(textOf(tree), /重新查看新手引导/)
  assert.match(textOf(tree), /内置免费识图/)
  assert.doesNotMatch(textOf(tree), /性能与稳定性/)
})

test('general page keeps the happy path focused on model chain and free fallback', () => {
  const React = reactStub()
  const { registeredComponent, scope } = createHarness(React, {
    value: baseSettings({
      providers: [
        { provider: 'openrouter', model: 'qwen-vl', fallbacks: [] },
        { provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] },
      ],
    }),
  })
  const tree = registeredComponent({ scope })
  const text = textOf(tree)
  assert.match(text, /识图已就绪/)
  assert.match(text, /识图模型/)
  assert.match(text, /内置免费兜底/)
  assert.doesNotMatch(text, /整轮视觉路由（旧工作流）/)
  assert.doesNotMatch(text, /渐进式工具暴露/)
})

test('strategy page groups tool usage, 1+x depth, and custom guidance together', () => {
  const React = reactStub([
    'strategy',
    {},
    undefined,
    undefined,
    undefined,
    { status: 'idle', error: undefined },
    { status: 'ready', groups: [] },
    { ollama: false, lmstudio: false, developer: false },
  ])
  const { registeredComponent, scope } = createHarness(React, {
    value: baseSettings({ structuredVisionBootstrap: true, visionDepth: 'custom', visionDepthMaxCalls: 4 }),
  })
  const text = textOf(registeredComponent({ scope }))
  assert.match(text, /Agent 按需使用识图工具/)
  assert.match(text, /结构化预识别（1\+x）/)
  assert.match(text, /看图深度/)
  assert.match(text, /最多追加识图调用/)
  assert.match(text, /自定义识图引导/)
})

test('local page keeps Ollama, LM Studio, and desktop capture out of the general path', () => {
  const React = reactStub([
    'local',
    {},
    undefined,
    undefined,
    undefined,
    { status: 'idle', error: undefined },
    { status: 'ready', groups: [] },
    { ollama: false, lmstudio: false, developer: false },
  ])
  const { registeredComponent, scope } = createHarness(React)
  const text = textOf(registeredComponent({ scope }))
  assert.match(text, /Ollama/)
  assert.match(text, /LM Studio/)
  assert.match(text, /允许 Agent 读取桌面截图/)
})

test('advanced page consolidates performance, wrapper scope, compatibility, network, and aggregate budget', () => {
  const React = reactStub([
    'advanced',
    {},
    undefined,
    undefined,
    undefined,
    { status: 'idle', error: undefined },
    { status: 'ready', groups: [] },
    { ollama: false, lmstudio: false, developer: true },
  ])
  const { registeredComponent, scope } = createHarness(React)
  const text = textOf(registeredComponent({ scope }))
  assert.match(text, /性能与稳定性/)
  assert.match(text, /整轮视觉工具上限/)
  assert.match(text, /不限制（推荐）/)
  assert.match(text, /识图模式范围/)
  assert.match(text, /自动允许已启用模型使用识图/)
  assert.match(text, /网络与远程/)
  assert.match(text, /兼容模式/)
  assert.match(text, /整轮视觉路由（旧工作流）/)
  assert.match(text, /开发者设置/)
})

test('remote view does not expose local backend and privileged network controls', () => {
  const React = reactStub([
    'local',
    {},
    undefined,
    undefined,
    undefined,
    { status: 'idle', error: undefined },
    { status: 'ready', groups: [] },
    { ollama: false, lmstudio: false, developer: false },
  ])
  const { registeredComponent, scope } = createHarness(React, { local: false })
  const text = textOf(registeredComponent({ scope }))
  assert.match(text, /只能在运行 DSH 的机器上配置/)
  assert.doesNotMatch(text, /允许 Agent 读取桌面截图/)
})