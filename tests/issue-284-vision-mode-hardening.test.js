import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import {
  CLIENT_PRESENTATION_PRELUDE,
  resolveVisionModePair,
} from '../lib/client-presentation-boundary.js'

const deepseekGroups = (routes = ['relay-auto-vision']) => [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    ],
  },
  ...routes.map((route) => ({
    id: route,
    name: 'DeepSeek + 自动识图',
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    ],
  })),
]

const genericGroups = [
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    models: [
      { id: 'qwen3.6-plus', name: 'Qwen 3.6 Plus' },
      { id: 'minimax-m2.7', name: 'MiniMax M2.7' },
    ],
  },
  {
    id: 'opencode-go-vision',
    name: 'OpenCode Go + 自动识图',
    models: [
      { id: 'qwen3.6-plus', name: 'Qwen 3.6 Plus' },
      { id: 'minimax-m2.7', name: 'MiniMax M2.7' },
    ],
  },
]

function firstChildOfType(node, type) {
  if (!node) return undefined
  if (node.type === type) return node
  if (!Array.isArray(node.children)) return undefined
  return node.children.find((child) => child && child.type === type)
}

test('issue #284 infers one unique DeepSeek wrapper when browser settings are unavailable', () => {
  assert.deepEqual(resolveVisionModePair(deepseekGroups(), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  }, {}), {
    mode: 'off',
    target: { provider: 'relay-auto-vision', model: 'deepseek-v4-pro' },
  })

  assert.deepEqual(resolveVisionModePair(deepseekGroups(), {
    provider: 'relay-auto-vision',
    model: 'deepseek-v4-pro',
  }, {}), {
    mode: 'on',
    target: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  })
})

test('issue #284 fails closed when multiple DeepSeek wrapper candidates are indistinguishable', () => {
  const groups = deepseekGroups(['deepseek-vision', 'relay-auto-vision'])
  assert.deepEqual(resolveVisionModePair(groups, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  }, {}), { mode: 'unavailable' })
})

test('issue #284 configured wrapper route wins over an ambiguous directory', () => {
  const groups = deepseekGroups(['deepseek-vision', 'relay-auto-vision'])
  assert.deepEqual(resolveVisionModePair(groups, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  }, { wrapperRoute: 'relay-auto-vision' }), {
    mode: 'off',
    target: { provider: 'relay-auto-vision', model: 'deepseek-v4-pro' },
  })
})

test('issue #284 does not trust a stale configured wrapper route just because another matching route exists', () => {
  assert.deepEqual(resolveVisionModePair(deepseekGroups(['deepseek-vision']), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  }, { wrapperRoute: 'relay-auto-vision' }), { mode: 'unavailable' })
})

test('issue #284 rejects generic twins when automatic wrapping is disabled and no explicit wrapper permits them', () => {
  assert.deepEqual(resolveVisionModePair(genericGroups, {
    provider: 'opencode-go',
    model: 'qwen3.6-plus',
  }, {
    autoWrapProviders: false,
    wrappedProviders: [],
  }), { mode: 'unavailable' })
})

test('issue #284 accepts only explicitly permitted generic twin models when automatic wrapping is disabled', () => {
  const config = {
    autoWrapProviders: false,
    wrappedProviders: [{ provider: 'opencode-go', models: ['qwen3.6-plus'] }],
  }
  assert.deepEqual(resolveVisionModePair(genericGroups, {
    provider: 'opencode-go',
    model: 'qwen3.6-plus',
  }, config), {
    mode: 'off',
    target: { provider: 'opencode-go-vision', model: 'qwen3.6-plus' },
  })
  assert.deepEqual(resolveVisionModePair(genericGroups, {
    provider: 'opencode-go',
    model: 'minimax-m2.7',
  }, config), { mode: 'unavailable' })
})

test('issue #284 explicit generic wrapper with an empty model filter permits every mirrored model', () => {
  const config = {
    autoWrapProviders: false,
    wrappedProviders: [{ provider: 'opencode-go', models: [] }],
  }
  assert.equal(resolveVisionModePair(genericGroups, {
    provider: 'opencode-go',
    model: 'minimax-m2.7',
  }, config).mode, 'off')
})

test('issue #284 browser toggle infers a unique custom wrapper when settings scope exposes no value', async () => {
  let registered
  const loader = {
    load(spec) {
      registered = spec
      return spec
    },
  }
  const window = { __ModuleLoader__: loader }
  vm.runInNewContext(CLIENT_PRESENTATION_PRELUDE, {
    window,
    Object,
    Promise,
    Array,
    String,
    Map,
    Set,
    WeakMap,
    Proxy,
    Reflect,
    console,
  })

  let snapshot = {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    groups: deepseekGroups(),
    status: 'ready',
    error: null,
  }
  const selections = []
  const store = {
    subscribe() { return () => {} },
    getSnapshot() { return snapshot },
  }
  const directory = {
    store,
    async select(selection) {
      selections.push(selection)
      snapshot = { ...snapshot, current: selection }
    },
  }

  const hookState = []
  let hookCursor = 0
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) {
      const at = hookCursor++
      if (!(at in hookState)) hookState[at] = initial
      return [hookState[at], (next) => {
        hookState[at] = typeof next === 'function' ? next(hookState[at]) : next
      }]
    },
    useEffect() {},
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  }

  loader.load({
    id: 'dsh-vision-router',
    factory(require) {
      require('@deepseek-ai/dsh-client-ui-attachment')
      return { apply() {} }
    },
  })
  const plugin = registered.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected host value request: ${id}`)
  })

  let injection
  const ctx = {
    locale: { register() { return () => {} } },
    settingsScope: {
      bind() {
        return {
          subscribe() { return () => {} },
          getSnapshot() { return { status: 'unavailable', value: undefined } },
        }
      },
    },
    effect(run) { return run() },
    inject(dependencies, callback) { injection = { dependencies, callback } },
  }
  plugin.apply(ctx)
  assert.deepEqual(Array.from(injection.dependencies), ['slots', 'modelDirectories'])

  let registration
  let Component
  injection.callback({
    modelDirectories: { directoryFor() { return directory } },
    sessions: { subagentAddress() { return undefined } },
    effect(run) { return run() },
    slots: {
      inject(_name, entries) {
        Array.from(entries())
        return () => {}
      },
      register(options, component) {
        registration = options
        Component = component
        return () => {}
      },
    },
  })

  const props = registration.inject('session-1')
  hookCursor = 0
  const rendered = Component({
    ...props,
    session: {},
    t(key) {
      return ({ label: '识图', enable: '开启', disable: '关闭', unavailable: '不可用', loading: '加载中', switching: '切换中' })[key] ?? key
    },
  })
  // The component may wrap the control with auxiliary UI such as a transient
  // toast. Assert the button contract instead of assuming the root node shape.
  const button = firstChildOfType(rendered, 'button')
  assert.ok(button)
  assert.equal(button.props.disabled, false)
  button.props.onClick()
  await Promise.resolve()
  assert.equal(selections.at(-1)?.provider, 'relay-auto-vision')
})
