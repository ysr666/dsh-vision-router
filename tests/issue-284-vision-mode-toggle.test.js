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
    failedShort: '识图切换失败',
    failed: '识图模式切换失败：{message}',
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
        snapshot = { ...snapshot, status: 'error', error: 'session.selectModel failed: route disappeared' }
        throw new Error('session.selectModel failed: route disappeared')
      }
      snapshot = { ...snapshot, current: selection, status: 'ready', error: null }
    },
  }

  const React = createHookReact()
  loader.load({
    id: 'dsh-vision-router',
    factory(require) {
      require('@deepseek-ai/dsh-client-ui-attachment')
      return {
        apply(ctx) {
          ctx.locale.register('vision-router', {
            zh: {
              quickStartBody: '旧快速开始',
              onboardingStep1Body: '旧引导',
              guideStep1Body: '旧步骤',
            },
            en: {
              quickStartBody: 'old quick start',
              onboardingStep1Body: 'old onboarding',
              guideStep1Body: 'old guide',
            },
          })
        },
      }
    },
  })
  const plugin = registered.factory((id) => {
    if (id === 'react') return React
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
    target: {
      provider: 'opencode-go',
      model: 'minimax-m2.7',
    },
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
    target: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    },
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

test('issue #284 refuses a configured wrapper without the exact mirrored model', () => {
  const wrapperRoute = 'relay-auto-vision'
  assert.deepEqual(resolveVisionModePair([
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-pro', name: 'Pro' }] },
    { id: wrapperRoute, name: 'DeepSeek + 自动识图', models: [{ id: 'other', name: 'Other' }] },
  ], {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  }, { wrapperRoute }), { mode: 'unavailable' })
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

test('issue #284 browser prelude wires the right-slot toggle to shared directory and settings scopes', async () => {
  const harness = createBrowserHarness()
  assert.deepEqual(Array.from(harness.registration ? ['slots', 'modelDirectories'] : []), ['slots', 'modelDirectories'])
  assert.equal(harness.slotName, 'conversation.input.right')
  assert.equal(harness.registration.id, 'vision-router-mode-toggle')

  const offButton = harness.render()
  assert.equal(offButton.type, 'button')
  assert.equal(offButton.props['aria-pressed'], false)
  assert.equal(offButton.props.disabled, false)
  offButton.props.onClick()
  await Promise.resolve()
  assert.equal(harness.selections.at(-1)?.provider, 'opencode-go-vision')
  assert.equal(harness.selections.at(-1)?.model, 'qwen3.6-plus')
  assert.equal(harness.selections.at(-1)?.reasoningEffort, 'high')

  const onButton = harness.render()
  assert.equal(onButton.props['aria-pressed'], true)
  onButton.props.onClick()
  await Promise.resolve()
  assert.equal(harness.selections.at(-1)?.provider, 'opencode-go')
  assert.equal(harness.selections.at(-1)?.model, 'qwen3.6-plus')
  assert.equal(harness.selections.at(-1)?.reasoningEffort, 'high')
})

test('issue #284 browser toggle follows the live configured DeepSeek wrapper route', async () => {
  const wrapperRoute = 'relay-auto-vision'
  const harness = createBrowserHarness({
    modelGroups: deepseekGroups(wrapperRoute),
    current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    wrapperRoute,
  })
  const button = harness.render()
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
  const staleButton = harness.render()
  assert.equal(staleButton.props.disabled, true)
})

test('issue #284 reports a rejected model switch instead of swallowing it', async () => {
  const harness = createBrowserHarness({ rejectSelection: true })
  const button = harness.render()
  button.props.onClick()
  await Promise.resolve()
  await Promise.resolve()

  const failed = harness.render()
  assert.equal(failed.props.disabled, false)
  assert.match(failed.props.title, /route disappeared/)
  assert.equal(failed.children[0].children[0], '⚠')
  assert.equal(failed.children[1].children[0], '识图切换失败')
})

test('issue #284 distinguishes initial model loading from a genuinely unavailable pair', () => {
  const harness = createBrowserHarness()
  harness.setSnapshot({ current: null, groups: [], status: 'loading', error: null })
  const button = harness.render()
  assert.equal(button.props.disabled, true)
  assert.equal(button.props.title, '加载中')
})

test('issue #284 patches onboarding copy to teach the explicit composer toggle', () => {
  const harness = createBrowserHarness()
  const main = harness.localeRegistrations.find((entry) => entry.namespace === 'vision-router')
  assert.ok(main)
  assert.match(main.dictionaries.zh.quickStartBody, /主动开启「识图」/)
  assert.match(main.dictionaries.zh.onboardingStep1Body, /输入框旁主动开启「识图」/)
  assert.match(main.dictionaries.zh.guideStep1Body, /持续生效/)
  assert.match(main.dictionaries.en.quickStartBody, /Turn on “Vision” beside the composer/)
  assert.equal(main.dictionaries.zh.quickStartBody.includes('请选择带「+ 自动识图」'), false)
})

test('issue #284 is explicit and persistent with no send/image auto-reset hook', () => {
  const source = readFileSync(new URL('../lib/client-presentation-boundary.js', import.meta.url), 'utf8')
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("ctx.inject(['slots', 'modelDirectories']"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("scope.slots.inject('conversation.input.right'"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("id: 'vision-router-mode-toggle'"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes('directory.select(pair.target)'), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes('resolveVisionModePair(state.groups, state.current, visionConfig)'), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("'aria-pressed': active"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("wrapperRoute: 'deepseek-vision'"), false)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("failedShort: '识图切换失败'"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes('catch(function(){})'), false)
  assert.equal(source.includes('send-committed'), false)
  assert.equal(source.includes('conversation.input.attachments'), false)
  assert.equal(source.includes('imageIds'), false)
})
