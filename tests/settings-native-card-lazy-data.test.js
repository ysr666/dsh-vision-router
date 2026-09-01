import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { SETTINGS_NATIVE_CARD_IA_PRELUDE } from '../lib/settings-native-card-layout.js'

function reactWithEffects(cardsOpen) {
  let stateIndex = 0
  const effects = []
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useMemo(factory) { return factory() },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    useState(initial) {
      const value = stateIndex++ === 0 ? cardsOpen : initial
      return [value, () => {}]
    },
    useEffect(effect) { effects.push(effect) },
    useRef(initial) { return { current: initial } },
  }
  return { React, effects }
}

function settingsValue() {
  return {
    providers: [{ provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] }],
    freeFallback: true,
    tool: true,
    structuredVisionBootstrap: false,
    guidanceOverrides: [],
    wrappedProviders: [],
    localOllama: {},
    localLmStudio: {},
  }
}

function renderWith(cardsOpen) {
  const { React, effects } = reactWithEffects(cardsOpen)
  let captured
  let component
  let modelCalls = 0
  let capabilityCalls = 0
  const loader = { load(spec) { captured = spec; return spec } }
  const sandbox = {
    window: { __ModuleLoader__: loader, location: { hostname: '127.0.0.1' } },
    document: { documentElement: { lang: 'zh-CN' } },
    navigator: {},
    fetch(url) {
      if (url === '/_dsh/vision-router/model-capabilities') capabilityCalls += 1
      return Promise.resolve({ ok: true, json: async () => ({ capabilities: {}, builtinFallback: [] }) })
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
      register(_options, registered) {
        component = registered
        return () => {}
      },
    },
    locale: { define() {} },
  })
  const scope = {
    subscribe() { return () => {} },
    getSnapshot() { return { status: 'ready', writable: true, value: settingsValue(), user: {} } },
    async set() {},
    async load() {},
  }
  component({
    scope,
    getConnection() {
      return {
        api: {
          llm: {
            models() {
              modelCalls += 1
              return Promise.resolve({ groups: [], failures: [] })
            },
          },
        },
      }
    },
  })
  for (const effect of effects) effect()
  return { modelCalls, capabilityCalls }
}

test('closed Settings cards perform no model-catalog or capability preload', () => {
  assert.deepEqual(renderWith({}), { modelCalls: 0, capabilityCalls: 0 })
})

test('Strategy and Local remain data-cold when expanded', () => {
  assert.deepEqual(renderWith({ strategy: true }), { modelCalls: 0, capabilityCalls: 0 })
  assert.deepEqual(renderWith({ local: true }), { modelCalls: 0, capabilityCalls: 0 })
})

test('General, Advanced, and Diagnostics load model data only after disclosure', () => {
  assert.deepEqual(renderWith({ general: true }), { modelCalls: 1, capabilityCalls: 1 })
  assert.deepEqual(renderWith({ advanced: true }), { modelCalls: 1, capabilityCalls: 1 })
  assert.deepEqual(renderWith({ diagnostics: true }), { modelCalls: 1, capabilityCalls: 1 })
})
