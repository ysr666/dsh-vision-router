import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { SETTINGS_IA_CLIENT_PRELUDE } from '../lib/settings-ia-client-prelude.js'
import {
  WRAPPER_SCOPE_CLIENT_PRELUDE,
  injectWrapperScopeClientPrelude,
} from '../lib/wrapper-scope-client-prelude.js'

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

function settingsValue() {
  return {
    providers: [
      { provider: 'openrouter', model: 'qwen-vl', fallbacks: [] },
      { provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] },
    ],
    freeFallback: true,
    tool: true,
    structuredVisionBootstrap: false,
    visionDepth: 'standard',
    visionDepthMaxCalls: 0,
    guidanceOverrides: [],
    localOllama: { enabled: true, baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5vl', format: 'openai' },
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
  }
}

function harness({ stateValues = [], localeDictionaries } = {}) {
  const React = reactStub(stateValues)
  let captured
  let registeredComponent
  let defined
  const loader = { load(spec) { captured = spec } }
  const sandbox = {
    window: { __ModuleLoader__: loader, location: { hostname: '127.0.0.1' } },
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
  vm.runInNewContext(SETTINGS_IA_CLIENT_PRELUDE, sandbox)

  loader.load({
    id: 'dsh-vision-router',
    factory() {
      return {
        apply(ctx) {
          if (localeDictionaries) ctx.locale.define('vision-router', localeDictionaries)
          ctx.slots.register(
            { name: 'settings.section', id: 'vision-router', order: 12 },
            function LegacySettings() {},
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
    locale: {
      define(namespace, dictionaries) { defined = { namespace, dictionaries } },
    },
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
    getSnapshot() { return { status: 'ready', writable: true, value: settingsValue() } },
    async set() {},
    async load() {},
  }
  return { registeredComponent, scope, defined }
}

test('F: diagnostics is a real read-only status surface, not a placeholder', () => {
  const { registeredComponent, scope } = harness({
    stateValues: [
      'diagnostics',
      {},
      undefined,
      undefined,
      undefined,
      { status: 'idle' },
      {
        status: 'ready',
        groups: [
          { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'qwen-vl' }, { id: 'gemini-vision' }] },
          { id: 'zhipu', name: 'Zhipu', models: [{ id: 'glm-4.6v' }] },
        ],
      },
      { ollama: false, lmstudio: false, developer: false },
    ],
  })
  const text = textOf(registeredComponent({ scope }))
  for (const expected of [
    '设置协议', '模型目录', '可选 Provider', '可选模型', '已配置识图模型',
    'Ollama', 'LM Studio', '桌面截图', '重新检测模型', '复制诊断信息',
    'dsh-vision-router doctor',
  ]) assert.match(text, new RegExp(expected))
  assert.doesNotMatch(text, /诊断页将在下一阶段/)
})

test('G: onboarding copy teaches the composer Vision control instead of wrapper groups', () => {
  const dictionaries = {
    zh: {
      quickStartBody: 'old',
      onboardingStep1Body: 'old',
      guideStep1Body: 'old',
    },
    en: {
      quickStartBody: 'old',
      onboardingStep1Body: 'old',
      guideStep1Body: 'old',
    },
  }
  const { defined } = harness({ localeDictionaries: dictionaries })
  assert.equal(defined.namespace, 'vision-router')
  assert.match(defined.dictionaries.zh.quickStartBody, /👁 识图/)
  assert.match(defined.dictionaries.zh.onboardingStep1Body, /👁 识图/)
  assert.match(defined.dictionaries.zh.onboardingStep2Body, /Vision Router → 常规/)
  assert.match(defined.dictionaries.zh.onboardingStep3Title, /可选/)
  assert.match(defined.dictionaries.en.quickStartBody, /👁 Vision/)
  assert.doesNotMatch(defined.dictionaries.zh.quickStartBody, /\+ 自动识图/)
})

test('J: Settings IA no longer relies on sibling-DOM hiding to suppress duplicate cards', () => {
  assert.doesNotMatch(SETTINGS_IA_CLIENT_PRELUDE, /previousElementSibling|nextElementSibling/)
})

test('J: legacy wrapper-scope prelude is an inert compatibility tombstone', () => {
  assert.equal(WRAPPER_SCOPE_CLIENT_PRELUDE, '')
  const html = '<html><head></head><body></body></html>'
  assert.equal(injectWrapperScopeClientPrelude(html), html)
})
