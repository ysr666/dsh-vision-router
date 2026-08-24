import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { WRAPPER_SCOPE_CLIENT_PRELUDE } from '../lib/wrapper-scope-client-prelude.js'

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
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const child of Array.isArray(node.children) ? node.children : []) {
    if (Array.isArray(child)) child.forEach((entry) => walk(entry, visit))
    else walk(child, visit)
  }
}

function createHarness(React) {
  let captured
  const loader = { load(spec) { captured = spec } }
  const sandbox = {
    window: { __ModuleLoader__: loader },
    Object,
    Promise,
    Array,
    String,
    Map,
    Set,
    WeakMap,
    Reflect,
    JSON,
  }
  vm.runInNewContext(WRAPPER_SCOPE_CLIENT_PRELUDE, sandbox)

  let dictionaries
  let registeredComponent
  const OriginalSection = function OriginalSection() { return null }
  loader.load({
    id: 'dsh-vision-router',
    factory() {
      return {
        apply(ctx) {
          ctx.locale.register('vision-router', {
            zh: { groupWrappers: '旧包装范围' },
            en: { groupWrappers: 'Old wrapper scope' },
          })
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
    locale: {
      register(_namespace, value) { dictionaries = value },
    },
    slots: {
      register(_options, component) {
        registeredComponent = component
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  return { dictionaries, registeredComponent, OriginalSection }
}

test('wrapper scope boundary promotes a primary settings card and labels the old advanced editor as a mirror', () => {
  const React = reactStub()
  const { dictionaries, registeredComponent, OriginalSection } = createHarness(React)

  assert.equal(dictionaries.zh.wrapperScopeTitle, '识图模式可用范围')
  assert.equal(dictionaries.en.wrapperScopeTitle, 'Vision mode scope')
  assert.equal(dictionaries.zh.groupWrappers, '包装范围（高级同步入口）')
  assert.notEqual(registeredComponent, OriginalSection)

  const rendered = registeredComponent({})
  assert.equal(rendered.type, React.Fragment)
  assert.equal(rendered.children.length, 2)
  assert.equal(typeof rendered.children[0].type, 'function')
  assert.equal(rendered.children[1].type, OriginalSection)
})

test('primary wrapper scope expands whole-provider and exact-model rows from the same wrappedProviders setting', () => {
  const groups = [
    { id: 'provider-a', name: 'Provider A', models: [{ id: 'a1', name: 'A1' }] },
    { id: 'provider-b', name: 'Provider B', models: [{ id: 'b1', name: 'B1' }, { id: 'b2', name: 'B2' }] },
  ]
  const React = reactStub([
    undefined,
    { status: 'idle', error: undefined },
    { status: 'ready', groups },
  ])
  const { registeredComponent } = createHarness(React)
  const section = registeredComponent({})
  const ScopeCard = section.children[0].type

  const scope = {
    subscribe() { return () => {} },
    getSnapshot() {
      return {
        status: 'ready',
        writable: true,
        value: {
          autoWrapProviders: false,
          wrapperRoute: 'deepseek-vision',
          chainRoute: 'vision-chain',
          wrappedProviders: [
            { provider: 'provider-a', models: [] },
            { provider: 'provider-b', models: ['b1', 'b2'] },
          ],
        },
      }
    },
  }
  const tree = ScopeCard({
    scope,
    t(key) { return key },
    getConnection() { return undefined },
  })

  const rows = []
  const badges = []
  walk(tree, (node) => {
    if (String(node.props?.className || '').includes('vr-chain-row')) rows.push(node)
    if (String(node.props?.className || '').includes('vr-badge')) badges.push(node)
  })
  assert.equal(rows.length, 3)
  assert.equal(badges.some((node) => node.children.includes('wrapperScopeAutoOff')), true)
})

test('wrapper scope boundary survives the rc8 queue-to-live ModuleLoader replacement', () => {
  let captured
  const loader = {
    load(spec) { captured = spec },
    create() {
      this.load = function liveLoad(spec) { captured = spec }
      return this
    },
  }
  const sandbox = {
    window: { __ModuleLoader__: loader },
    Object,
    Promise,
    Array,
    String,
    Map,
    Set,
    WeakMap,
    Reflect,
    JSON,
  }
  vm.runInNewContext(WRAPPER_SCOPE_CLIENT_PRELUDE, sandbox)
  loader.create()
  loader.load({
    id: 'dsh-vision-router',
    factory() { return { apply() {} } },
  })

  const React = reactStub()
  const plugin = captured.factory(() => React)
  assert.equal(plugin.apply.__visionRouterWrapperScope, true)
})
