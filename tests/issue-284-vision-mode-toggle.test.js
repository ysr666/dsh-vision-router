import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import {
  CLIENT_PRESENTATION_PRELUDE,
  resolveVisionModePair,
} from '../lib/client-presentation-boundary.js'

const groups = [
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

test('issue #284 maps a normal selection to the matching generated vision twin', () => {
  assert.deepEqual(resolveVisionModePair(groups, {
    provider: 'opencode-go',
    model: 'qwen3.6-plus',
    reasoningEffort: 'high',
  }), {
    mode: 'off',
    target: {
      provider: 'opencode-go-vision',
      model: 'qwen3.6-plus',
      reasoningEffort: 'high',
    },
  })
})

test('issue #284 maps a generated vision twin back to its source route', () => {
  assert.deepEqual(resolveVisionModePair(groups, {
    provider: 'opencode-go-vision',
    model: 'minimax-m2.7',
  }), {
    mode: 'on',
    target: {
      provider: 'opencode-go',
      model: 'minimax-m2.7',
    },
  })
})

test('issue #284 refuses lookalike -vision providers not owned by the generated twin naming contract', () => {
  const lookalike = [
    { id: 'third-party', name: 'Third Party', models: [{ id: 'm', name: 'M' }] },
    { id: 'third-party-vision', name: 'Third Party Vision Native', models: [{ id: 'm', name: 'M' }] },
  ]
  assert.deepEqual(resolveVisionModePair(lookalike, {
    provider: 'third-party',
    model: 'm',
  }), { mode: 'unavailable' })
})

test('issue #284 refuses a twin when that exact model is not mirrored', () => {
  assert.deepEqual(resolveVisionModePair([
    { id: 'provider', name: 'Provider', models: [{ id: 'a', name: 'A' }] },
    { id: 'provider-vision', name: 'Provider + 自动识图', models: [{ id: 'b', name: 'B' }] },
  ], {
    provider: 'provider',
    model: 'a',
  }), { mode: 'unavailable' })
})

test('issue #284 omits reasoning effort when the current selection has none', () => {
  assert.deepEqual(resolveVisionModePair(groups, {
    provider: 'opencode-go',
    model: 'qwen3.6-plus',
  }), {
    mode: 'off',
    target: {
      provider: 'opencode-go-vision',
      model: 'qwen3.6-plus',
    },
  })
})

test('issue #284 browser prelude wires the right-slot toggle to the shared ModelDirectory', async () => {
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
    console,
  })

  const selections = []
  let snapshot = {
    current: { provider: 'opencode-go', model: 'qwen3.6-plus', reasoningEffort: 'high' },
    groups,
    status: 'ready',
    error: null,
  }
  const store = {
    subscribe() { return () => {} },
    getSnapshot() { return snapshot },
  }
  const directory = {
    store,
    async select(selection) {
      selections.push(selection)
      snapshot = { ...snapshot, current: selection, status: 'ready' }
    },
  }

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) { return [initial, () => {}] },
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

  let dependencyInjection
  const ctx = {
    locale: { register() { return () => {} } },
    effect(run) { return run() },
    inject(dependencies, callback) { dependencyInjection = { dependencies, callback } },
  }
  plugin.apply(ctx)
  assert.deepEqual(Array.from(dependencyInjection.dependencies), ['slots', 'modelDirectories'])

  let slotName
  let registration
  let Component
  const scope = {
    modelDirectories: { directoryFor() { return directory } },
    sessions: { subagentAddress() { return undefined } },
    effect(run) { return run() },
    slots: {
      inject(name, entries) {
        slotName = name
        Array.from(entries())
        return () => {}
      },
      register(options, component) {
        registration = options
        Component = component
        return () => {}
      },
    },
  }
  dependencyInjection.callback(scope)
  assert.equal(slotName, 'conversation.input.right')
  assert.equal(registration.id, 'vision-router-mode-toggle')

  const props = registration.inject('session-1')
  const translate = (key) => ({
    label: '识图',
    enable: '开启识图模式',
    disable: '关闭识图模式',
    unavailable: '不可用',
    switching: '切换中',
  })[key]

  const assertSelection = (selection, expected) => {
    assert.equal(selection?.provider, expected.provider)
    assert.equal(selection?.model, expected.model)
    assert.equal(selection?.reasoningEffort, expected.reasoningEffort)
  }

  const offButton = Component({ ...props, session: {}, t: translate })
  assert.equal(offButton.type, 'button')
  assert.equal(offButton.props['aria-pressed'], false)
  assert.equal(offButton.props.disabled, false)
  offButton.props.onClick()
  await Promise.resolve()
  assertSelection(selections.at(-1), {
    provider: 'opencode-go-vision',
    model: 'qwen3.6-plus',
    reasoningEffort: 'high',
  })

  const onButton = Component({ ...props, session: {}, t: translate })
  assert.equal(onButton.props['aria-pressed'], true)
  onButton.props.onClick()
  await Promise.resolve()
  assertSelection(selections.at(-1), {
    provider: 'opencode-go',
    model: 'qwen3.6-plus',
    reasoningEffort: 'high',
  })
})

test('issue #284 is explicit and persistent with no send/image auto-reset hook', () => {
  const source = readFileSync(new URL('../lib/client-presentation-boundary.js', import.meta.url), 'utf8')
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("ctx.inject(['slots', 'modelDirectories']"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("scope.slots.inject('conversation.input.right'"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("id: 'vision-router-mode-toggle'"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes('directory.select(pair.target)'), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes('resolveVisionModePair(state.groups, state.current)'), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("'aria-pressed': active"), true)
  assert.equal(source.includes('send-committed'), false)
  assert.equal(source.includes('conversation.input.attachments'), false)
  assert.equal(source.includes('imageIds'), false)
})
