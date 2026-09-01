import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { SETTINGS_NATIVE_CARD_IA_PRELUDE } from '../lib/settings-native-card-layout.js'
import { V2_SETTINGS_IA_CLIENT } from '../lib/v2-settings-ia-integration.js'

function reactStub(stateValues = []) {
  let stateIndex = 0
  const updates = []
  return {
    updates,
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useMemo(factory) { return factory() },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    useState(initial) {
      const index = stateIndex++
      const value = index < stateValues.length ? stateValues[index] : initial
      return [value, (next) => { updates.push([index, next]) }]
    },
    useEffect() {},
    useRef(initial) { return { current: initial } },
  }
}

function walk(node, visit) {
  if (node === undefined || node === null || node === false) return
  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, visit))
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  for (const child of Array.isArray(node.children) ? node.children : []) walk(child, visit)
}

function findOne(tree, predicate) {
  const matches = []
  walk(tree, (node) => { if (predicate(node)) matches.push(node) })
  assert.equal(matches.length, 1)
  return matches[0]
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

function createHarness(React, { value = baseSettings(), guideStep } = {}) {
  let captured
  let registeredComponent
  let guideStarts = 0
  const finishCalls = []
  const commits = []
  const loader = { load(spec) { captured = spec; return spec } }
  const sandbox = {
    window: { __ModuleLoader__: loader, location: { hostname: '127.0.0.1' } },
    document: { documentElement: { lang: 'zh-CN' } },
    navigator: {},
    Object,
    Promise,
    Array,
    String,
    Number,
    Map,
    Set,
    WeakMap,
    Reflect,
    Proxy,
    Symbol,
    Math,
    JSON,
    Error,
    TypeError,
    console,
    setTimeout() { return 1 },
    clearTimeout() {},
  }
  vm.runInNewContext(SETTINGS_NATIVE_CARD_IA_PRELUDE, sandbox)

  loader.load({
    id: 'dsh-vision-router',
    factory() {
      return {
        startVisionSettingsGuide() { guideStarts += 1 },
        readVisionGuideStep() { return guideStep },
        finishVisionSettingsGuide(options) { finishCalls.push(options) },
        async commitSettingsPlan(_scope, items) {
          commits.push(items.map((item) => ({ key: item.key, run: item.run })))
          return { landed: true, failed: false, landedFields: items.map((item) => item.key), failures: [] }
        },
        apply(ctx) {
          ctx.slots.register(
            { name: 'settings.section', id: 'vision-router', order: 12 },
            function OriginalSection() {},
          )
        },
      }
    },
  })

  const plugin = captured.factory((id) => {
    assert.equal(id, 'react')
    return React
  })
  plugin.apply({
    slots: {
      register(_options, component) {
        registeredComponent = component
        return () => {}
      },
    },
    locale: { define() {} },
  })

  const scope = {
    subscribe() { return () => {} },
    getSnapshot() { return { status: 'ready', writable: true, value, user: {} } },
    async set() {},
    async load() {},
  }

  return {
    scope,
    commits,
    registeredComponent,
    get guideStarts() { return guideStarts },
    get finishCalls() { return finishCalls },
  }
}

function stateValues({ cardsOpen = { general: true }, drafts = {}, saveState = { status: 'idle' } } = {}) {
  return [
    cardsOpen,
    drafts,
    undefined,
    undefined,
    undefined,
    saveState,
    { status: 'ready', groups: [], failures: [] },
    { ollama: false, lmstudio: false, developer: false },
    { status: 'ready', capabilities: {}, builtinFallback: [], anonymousRpmPerModel: 2 },
  ]
}

test('hidden invalid Advanced draft does not block a valid General save', () => {
  const React = reactStub(stateValues({
    cardsOpen: { general: true },
    drafts: { freeFallback: false, timeoutMs: 999 },
  }))
  const harness = createHarness(React)
  const tree = harness.registeredComponent({ scope: harness.scope })
  const root = findOne(tree, (node) => node.props?.['data-vr-settings-ia'] === '1')
  const save = findOne(tree, (node) => node.props?.className === 'vr-btn vr-btn-save vr-ia-save')

  assert.equal(root.props['data-vr-dirty'], '1')
  assert.equal(root.props['data-vr-invalid'], '1')
  assert.equal(save.props.disabled, false)
})

test('saving General commits only General-owned fields', () => {
  const React = reactStub(stateValues({
    cardsOpen: { general: true },
    drafts: { freeFallback: false, timeoutMs: 130000 },
  }))
  const harness = createHarness(React)
  const tree = harness.registeredComponent({ scope: harness.scope })
  const save = findOne(tree, (node) => node.props?.className === 'vr-btn vr-btn-save vr-ia-save')

  save.props.onClick()
  assert.equal(harness.commits.length, 1)
  assert.deepEqual([...harness.commits[0].map((item) => item.key)], ['freeFallback'])
})

test('Diagnostics never exposes a settings save/discard footer even when another card is dirty', () => {
  const React = reactStub(stateValues({
    cardsOpen: { diagnostics: true },
    drafts: { freeFallback: false },
  }))
  const harness = createHarness(React)
  const tree = harness.registeredComponent({ scope: harness.scope })
  const footers = []
  walk(tree, (node) => {
    if (node.props?.className === 'vr-ia-card-footer') footers.push(node)
  })
  assert.equal(footers.length, 0)
})

test('guide replay uses the exported guide API without mounting the legacy Settings section', () => {
  const React = reactStub(stateValues({ cardsOpen: {} }))
  const harness = createHarness(React)
  const tree = harness.registeredComponent({ scope: harness.scope })
  const guide = findOne(tree, (node) => node.props?.className === 'vr-btn vr-ia-guide-button')

  assert.equal(guide.props.disabled, false)
  guide.props.onClick()
  assert.equal(harness.guideStarts, 1)
  assert.doesNotMatch(SETTINGS_NATIVE_CARD_IA_PRELUDE, /data-vr-guide-bridge/)
})

test('v2 routing blocks immediate writes from the stable root dirty contract', () => {
  let clickHandler
  const warning = { textContent: '', style: {} }
  const panel = {
    querySelector(selector) {
      if (selector === '[data-vr-ia-routing-warning]') return warning
      return null
    },
  }
  const root = {
    dataset: { vrDirty: '1' },
    querySelector() { return null },
  }
  const target = {
    closest(selector) {
      if (selector === '.vr-settings-ia-root') return root
      if (selector === '[data-vr-routing-settings-panel]') return panel
      return target
    },
  }
  const document = {
    documentElement: { lang: 'zh-CN' },
    addEventListener(type, handler) {
      if (type === 'click') clickHandler = handler
    },
  }
  class MutationObserver {
    constructor() {}
    observe() {}
  }
  vm.runInNewContext(V2_SETTINGS_IA_CLIENT, {
    document,
    MutationObserver,
    setTimeout() { return 1 },
    Array,
    String,
  })

  const calls = { prevent: 0, stop: 0, immediate: 0 }
  clickHandler({
    target,
    preventDefault() { calls.prevent += 1 },
    stopPropagation() { calls.stop += 1 },
    stopImmediatePropagation() { calls.immediate += 1 },
  })

  assert.deepEqual(calls, { prevent: 1, stop: 1, immediate: 1 })
  assert.match(warning.textContent, /先保存或放弃当前修改/)
  assert.match(V2_SETTINGS_IA_CLIENT, /data-vr-dirty/)
})

test('General card renders the guide completion callout while the guide is on step 2', () => {
  const React = reactStub(stateValues({ cardsOpen: { general: true } }))
  const harness = createHarness(React, { guideStep: 'step2' })
  const tree = harness.registeredComponent({ scope: harness.scope })
  const callout = findOne(tree, (node) => node.props?.className === 'vr-guide-callout')
  const title = findOne(tree, (node) => node.props?.className === 'vr-guide-callout-title')
  const done = findOne(tree, (node) => {
    if (node.props?.className !== 'vr-btn vr-btn-save') return false
    const children = Array.isArray(node.children) ? node.children : [node.children]
    return children.some((child) => child === '完成')
  })

  assert.match(String(title.children), /确认识图模型/)
  assert.equal(harness.finishCalls.length, 0)
  done.props.onClick()
  assert.equal(harness.finishCalls.length, 1)
  // The options object is created inside the vm sandbox realm; compare its
  // fields instead of deepStrictEqual against a host-realm object.
  assert.equal(harness.finishCalls[0].complete, true)
  assert.ok(callout)
})

test('guide completion callout stays hidden when the guide is not on step 2', () => {
  const React = reactStub(stateValues({ cardsOpen: { general: true } }))
  const harness = createHarness(React, { guideStep: undefined })
  const tree = harness.registeredComponent({ scope: harness.scope })
  const callouts = []
  walk(tree, (node) => { if (node.props?.className === 'vr-guide-callout') callouts.push(node) })
  assert.equal(callouts.length, 0)
})

test('saving General completes an active guide', async () => {
  const React = reactStub(stateValues({
    cardsOpen: { general: true },
    drafts: { freeFallback: false },
  }))
  const harness = createHarness(React, { guideStep: 'step2' })
  const tree = harness.registeredComponent({ scope: harness.scope })
  const save = findOne(tree, (node) => node.props?.className === 'vr-btn vr-btn-save vr-ia-save')

  save.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(harness.commits.length, 1)
  assert.equal(harness.finishCalls.length, 1)
  assert.equal(harness.finishCalls[0].complete, true)
})

test('saving General does not touch the guide when it is not active', () => {
  const React = reactStub(stateValues({
    cardsOpen: { general: true },
    drafts: { freeFallback: false },
  }))
  const harness = createHarness(React, { guideStep: undefined })
  const tree = harness.registeredComponent({ scope: harness.scope })
  const save = findOne(tree, (node) => node.props?.className === 'vr-btn vr-btn-save vr-ia-save')

  save.props.onClick()
  assert.equal(harness.commits.length, 1)
  assert.equal(harness.finishCalls.length, 0)
})

test('guide replay button is disabled while any card has staged edits', () => {
  const React = reactStub(stateValues({
    cardsOpen: {},
    drafts: { freeFallback: false },
  }))
  const harness = createHarness(React)
  const tree = harness.registeredComponent({ scope: harness.scope })
  const guide = findOne(tree, (node) => node.props?.className === 'vr-btn vr-ia-guide-button')

  assert.equal(guide.props.disabled, true)
})
