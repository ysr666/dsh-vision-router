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

const deepseekGroups = (wrapperRoute = 'deepseek-vision') => [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    ],
  },
  {
    id: wrapperRoute,
    name: 'DeepSeek + 自动识图',
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    ],
  },
]

function translate(key, params) {
  const copy = {
    label: '识图',
    enable: '开启识图模式',
    disable: '关闭识图模式',
    unavailable: '不可用',
    loading: '加载中',
    switching: '切换中',
    failed: '模型操作失败：{message}',
    failedUnknown: '未知错误',
  }
  const template = copy[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match)
}

function createHookReact() {
  const states = []
  let cursor = 0
  return {
    Fragment: Symbol('Fragment'),
    begin() { cursor = 0 },
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) {
      const at = cursor++
      if (!(at in states)) states[at] = initial
      return [states[at], (next) => {
        states[at] = typeof next === 'function' ? next(states[at]) : next
      }]
    },
    useEffect() {},
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  }
}

function firstChildOfType(node, type) {
  if (!node) return undefined
  if (node.type === type) return node
  if (!Array.isArray(node.children)) return undefined
  return node.children.find((child) => child && child.type === type)
}

function buttonOf(rendered) {
  return firstChildOfType(rendered, 'button')
}

function createBrowserHarness({
  modelGroups = groups,
  current = { provider: 'opencode-go', model: 'qwen3.6-plus', reasoningEffort: 'high' },
  wrapperRoute = 'deepseek-vision',
  rejectSelection = false,
} = {}) {
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

  const selections = []
  let snapshot = {
    current,
    groups: modelGroups,
    status: 'ready',
    error: null,
  }
  let settingsSnapshot = {
    status: 'ready',
    value: { wrapperRoute },
  }
  const store = {
    subscribe() { return () => {} },
    getSnapshot() { return snapshot },
  }
  const directory = {
    store,
    async select(selection) {
      selections.push(selection)
      if (rejectSelection) {
        const message = typeof rejectSelection === 'string'
          ? rejectSelection
          : 'model-unavailable: Model "qwen3.6-plus" does not accept image input, but this session already contains images; select an image-capable model.'
        snapshot = { ...snapshot, status: 'error', error: message }
        throw new Error(`session.selectModel failed: ${message}`)
      }
      snapshot = { ...snapshot, current: selection, status: 'ready', error: null }
    },
  }

  const React = createHookReact()
  function NativeToast() {}
  function WarningIcon() {}
  const primitives = { Toast: NativeToast, IconWarningOutline16: WarningIcon }

  loader.load({
    id: 'dsh-vision-router',
    factory(require) {
      require('@deepseek-ai/dsh-client-ui-attachment')
      return {
        apply(ctx) {
          ctx.locale.register('vision-router', {
            zh: {
              quickStartTitle: '旧标题',
              quickStartBody: '旧快速开始',
              onboardingStep1Title: '旧步骤标题',
              onboardingStep1Body: '旧引导',
              guideStep1Title: '旧高亮标题',
              guideStep1Body: '旧步骤',
            },
            en: {
              quickStartTitle: 'old title',
              quickStartBody: 'old quick start',
              onboardingStep1Title: 'old step title',
              onboardingStep1Body: 'old onboarding',
              guideStep1Title: 'old guide title',
              guideStep1Body: 'old guide',
            },
          })
        },
      }
    },
  })
  const plugin = registered.factory((id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected host value request: ${id}`)
  })

  let dependencyInjection
  const localeRegistrations = []
  const settingsScope = {
    subscribe() { return () => {} },
    getSnapshot() { return settingsSnapshot },
  }
  const ctx = {
    locale: {
      register(namespace, dictionaries) {
        localeRegistrations.push({ namespace, dictionaries })
        return () => {}
      },
    },
    settingsScope: {
      bind(spec) {
        assert.equal(spec.namespace, 'vision-router')
        return settingsScope
      },
    },
    effect(run) { return run() },
    inject(dependencies, callback) { dependencyInjection = { dependencies, callback } },
  }
  plugin.apply(ctx)

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
  const props = registration.inject('session-1')

  return {
    React,
    primitives,
    dependencyInjection,
    selections,
    store,
    directory,
    props,
    Component,
    registration,
    slotName,
    localeRegistrations,
    setSnapshot(next) { snapshot = next },
    getSnapshot() { return snapshot },
    setSettings(next) { settingsSnapshot = next },
    render(extra = {}) {
      React.begin()
      return Component({ ...props, session: {}, t: translate, ...extra })
    },
  }
}

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
    target: { provider: 'opencode-go', model: 'minimax-m2.7' },
  })
})

test('issue #284 maps default DeepSeek through the built-in deepseek-vision wrapper', () => {
  assert.deepEqual(resolveVisionModePair(deepseekGroups(), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  }), {
    mode: 'off',
    target: {
      provider: 'deepseek-vision',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    },
  })
  assert.deepEqual(resolveVisionModePair(deepseekGroups(), {
    provider: 'deepseek-vision',
    model: 'deepseek-v4-pro',
  }), {
    mode: 'on',
    target: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  })
})

test('issue #284 follows a custom configured DeepSeek wrapper route in both directions', () => {
  const wrapperRoute = 'relay-auto-vision'
  const config = { wrapperRoute }
  assert.deepEqual(resolveVisionModePair(deepseekGroups(wrapperRoute), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  }, config), {
    mode: 'off',
    target: { provider: wrapperRoute, model: 'deepseek-v4-flash' },
  })
  assert.deepEqual(resolveVisionModePair(deepseekGroups(wrapperRoute), {
    provider: wrapperRoute,
    model: 'deepseek-v4-flash',
  }, config), {
    mode: 'on',
    target: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  })
})

test('issue #284 rejects lookalikes and exact-model mismatches', () => {
  const lookalike = [
    { id: 'third-party', name: 'Third Party', models: [{ id: 'm', name: 'M' }] },
    { id: 'third-party-vision', name: 'Third Party Vision Native', models: [{ id: 'm', name: 'M' }] },
  ]
  assert.deepEqual(resolveVisionModePair(lookalike, {
    provider: 'third-party',
    model: 'm',
  }), { mode: 'unavailable' })

  assert.deepEqual(resolveVisionModePair([
    { id: 'provider', name: 'Provider', models: [{ id: 'a', name: 'A' }] },
    { id: 'provider-vision', name: 'Provider + 自动识图', models: [{ id: 'b', name: 'B' }] },
  ], {
    provider: 'provider',
    model: 'a',
  }), { mode: 'unavailable' })
})

test('issue #284 browser prelude wires the right-slot toggle to shared directory and settings scopes', async () => {
  const harness = createBrowserHarness()
  assert.deepEqual(Array.from(harness.dependencyInjection.dependencies), ['slots', 'modelDirectories'])
  assert.equal(harness.slotName, 'conversation.input.right')
  assert.equal(harness.registration.id, 'vision-router-mode-toggle')

  const offButton = buttonOf(harness.render())
  assert.equal(offButton.props['aria-pressed'], false)
  assert.equal(offButton.props.disabled, false)
  assert.equal(offButton.props['data-vision-router-mode-toggle'], 'true')
  assert.equal(offButton.children[2], null)
  offButton.props.onClick()
  await Promise.resolve()
  assert.equal(harness.selections.at(-1)?.provider, 'opencode-go-vision')
  assert.equal(harness.selections.at(-1)?.reasoningEffort, 'high')

  const onButton = buttonOf(harness.render())
  assert.equal(onButton.props['aria-pressed'], true)
  assert.equal(onButton.children[2]?.children[0], '✓')
  assert.match(onButton.props.style.boxShadow, /brand-primary/)
  onButton.props.onClick()
  await Promise.resolve()
  assert.equal(harness.selections.at(-1)?.provider, 'opencode-go')
  assert.equal(harness.selections.at(-1)?.reasoningEffort, 'high')
})

test('issue #284 browser toggle follows the live configured DeepSeek wrapper route', async () => {
  const wrapperRoute = 'relay-auto-vision'
  const harness = createBrowserHarness({
    modelGroups: deepseekGroups(wrapperRoute),
    current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    wrapperRoute,
  })
  const button = buttonOf(harness.render())
  assert.equal(button.props.disabled, false)
  button.props.onClick()
  await Promise.resolve()
  assert.equal(harness.selections.at(-1)?.provider, wrapperRoute)

  harness.setSettings({ status: 'ready', value: { wrapperRoute: 'next-auto-vision' } })
  harness.setSnapshot({
    current: { provider: wrapperRoute, model: 'deepseek-v4-pro' },
    groups: deepseekGroups(wrapperRoute),
    status: 'ready',
    error: null,
  })
  assert.equal(buttonOf(harness.render()).props.disabled, true)
})

test('issue #284 image-session rejection uses transient toast and keeps the real ON state usable', async () => {
  const error = 'model-unavailable: Model "qwen3.6-plus" does not accept image input, but this session already contains images; select an image-capable model.'
  const harness = createBrowserHarness({
    current: { provider: 'opencode-go-vision', model: 'qwen3.6-plus', reasoningEffort: 'high' },
    rejectSelection: error,
  })

  const before = buttonOf(harness.render())
  assert.equal(before.props['aria-pressed'], true)
  assert.equal(before.children[2]?.children[0], '✓')
  before.props.onClick()
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(harness.getSnapshot().current.provider, 'opencode-go-vision')
  assert.equal(harness.getSnapshot().status, 'error')

  const rendered = harness.render()
  const button = buttonOf(rendered)
  const toast = firstChildOfType(rendered, harness.primitives.Toast)
  assert.equal(button.props['aria-pressed'], true)
  assert.equal(button.props.disabled, false)
  assert.equal(button.children[1].children[0], '识图')
  assert.equal(button.children[2]?.children[0], '✓')
  assert.equal(button.props.title, '关闭识图模式')
  assert.ok(toast)
  assert.equal(toast.props.text, `模型操作失败：${error}`)
  assert.equal(toast.props.anchor, null)

  button.props.onClick()
  await Promise.resolve()
  assert.equal(harness.selections.length, 2)
})

test('issue #284 distinguishes initial model loading from a genuinely unavailable pair', () => {
  const harness = createBrowserHarness()
  harness.setSnapshot({ current: null, groups: [], status: 'loading', error: null })
  const button = buttonOf(harness.render())
  assert.equal(button.props.disabled, true)
  assert.equal(button.props.title, '加载中')
})

test('issue #284 patches onboarding copy and accurately explains the guide spotlight', () => {
  const harness = createBrowserHarness()
  const main = harness.localeRegistrations.find((entry) => entry.namespace === 'vision-router')
  assert.ok(main)
  assert.equal(main.dictionaries.zh.quickStartTitle, '聊天模型 + 识图模式')
  assert.match(main.dictionaries.zh.quickStartBody, /出现 ✓ 表示已开启/)
  assert.match(main.dictionaries.zh.onboardingStep1Title, /开启识图/)
  assert.match(main.dictionaries.zh.onboardingStep1Body, /模型选择器左侧的「识图」/)
  assert.match(main.dictionaries.zh.guideStep1Body, /^高亮的是聊天模型选择器/)
  assert.equal(main.dictionaries.zh.guideStep1Body.includes('和「识图」按钮已经被高亮'), false)
  assert.match(main.dictionaries.en.quickStartBody, /a ✓ means it is on/)
})

test('issue #284 remains explicit and persistent with no send/image auto-reset hook', () => {
  const source = readFileSync(new URL('../lib/client-presentation-boundary.js', import.meta.url), 'utf8')
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("ctx.inject(['slots', 'modelDirectories']"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("scope.slots.inject('conversation.input.right'"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("id: 'vision-router-mode-toggle'"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("'data-vision-router-mode-toggle': 'true'"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("require('@deepseek-ai/dsh-client-ui-primitives')"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("failed: '模型操作失败：{message}'"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("}, '✓')"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes('failedShort'), false)
  assert.equal(source.includes('send-committed'), false)
  assert.equal(source.includes('conversation.input.attachments'), false)
  assert.equal(source.includes('imageIds'), false)
})
