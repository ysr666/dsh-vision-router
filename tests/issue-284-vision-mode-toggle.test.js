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
  const refs = []
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
    useRef(initial) {
      const at = cursor++
      if (!(at in refs)) refs[at] = { current: initial }
      return refs[at]
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
  returnSelectionFailure = false,
  deferSelection = false,
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
  let releaseSelection
  const selectionGate = deferSelection
    ? new Promise((resolve) => { releaseSelection = resolve })
    : undefined
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
      if (rejectSelection || returnSelectionFailure) {
        const failure = rejectSelection || returnSelectionFailure
        const message = typeof failure === 'string'
          ? failure
          : 'model-unavailable: Model "qwen3.6-plus" does not accept image input, but this session already contains images; select an image-capable model.'
        snapshot = { ...snapshot, status: 'error', error: message }
        if (rejectSelection) throw new Error(`session.selectModel failed: ${message}`)
        const separator = message.indexOf(': ')
        return {
          ok: false,
          error: {
            code: separator === -1 ? 'model-unavailable' : message.slice(0, separator),
            message: separator === -1 ? message : message.slice(separator + 2),
          },
        }
      }
      if (selectionGate) {
        snapshot = { ...snapshot, status: 'selecting', pending: selection, error: null }
        await selectionGate
      }
      snapshot = { ...snapshot, current: selection, status: 'ready', pending: null, error: null }
      return { ok: true, value: undefined }
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
    resolveSelection() { if (releaseSelection) releaseSelection() },
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
  assert.deepEqual(Array.from(harness.dependencyInjection.dependencies), ['slots', 'modelDirectories', 'sessions', 'remote'])
  assert.equal(harness.slotName, 'conversation.input.right')
  assert.equal(harness.registration.id, 'vision-router-mode-toggle')

  const offButton = buttonOf(harness.render())
  assert.equal(offButton.props['aria-pressed'], false)
  assert.equal(offButton.props.disabled, false)
  assert.equal(offButton.props['data-vision-router-mode-toggle'], 'true')
  // One fixed 14px leading slot carries the state icon, so both states render
  // identical geometry: appending a check only while active used to change the
  // chip width by ~18px and reflow the trailing composer row.
  assert.equal(offButton.children.length, 2)
  assert.equal(offButton.children[0]?.type, 'span')
  // The fixed 14px box lives in the chip stylesheet, which also owns the 460px collapse;
  // the markup carries the class both select.
  assert.equal(offButton.children[0]?.props.className, 'vr-vision-toggle-glyph')
  // One 14px slot, two glyphs: the Vision eye and the check that marks the enabled state.
  // The chip stylesheet shows the check only while the label is there to explain it.
  assert.equal(offButton.children[0]?.children.length, 2)
  assert.equal(offButton.children[0]?.children[0]?.props.className, 'vr-vision-toggle-glyph-part vr-vision-toggle-glyph-eye')
  assert.equal(offButton.children[0]?.children[0]?.children[0]?.type, 'svg')
  assert.equal(offButton.children[0]?.children[0]?.children[0]?.props.width, 14)
  assert.equal(offButton.children[0]?.children[0]?.children[0]?.props.height, 14)
  assert.equal(offButton.children[0]?.children[0]?.children[0]?.children[0]?.props.fill, 'currentColor')
  assert.equal(offButton.children[0]?.children[1]?.props.className, 'vr-vision-toggle-glyph-part vr-vision-toggle-glyph-check')
  assert.equal(offButton.children[0]?.children[1]?.children[0]?.children[0]?.props.stroke, 'currentColor')
  offButton.props.onClick()
  await Promise.resolve()
  assert.equal(harness.selections.at(-1)?.provider, 'opencode-go-vision')
  assert.equal(harness.selections.at(-1)?.reasoningEffort, 'high')

  const onButton = buttonOf(harness.render())
  assert.equal(onButton.props['aria-pressed'], true)
  assert.equal(onButton.children.length, 2)
  assert.equal(onButton.children[0]?.type, 'span')
  assert.equal(onButton.children[0]?.props.className, 'vr-vision-toggle-glyph')
  // Same slot in both states; the stylesheet is what swaps eye for check, and only while the
  // label is present (<=460px keeps the eye so a collapsed chip still says what it does).
  assert.equal(onButton.children[0]?.children.length, 2)
  assert.equal(onButton.children[0]?.children[0]?.props.className, 'vr-vision-toggle-glyph-part vr-vision-toggle-glyph-eye')
  assert.equal(onButton.children[0]?.children[0]?.children[0]?.props.width, 14)
  assert.equal(onButton.children[0]?.children[1]?.props.className, 'vr-vision-toggle-glyph-part vr-vision-toggle-glyph-check')
  // The selected treatment is the shipped ghost-active token pair, pinned by the chip
  // stylesheet instead of an inline brand shadow.
  assert.equal(onButton.props['data-active'], 'true')
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
  assert.equal(before.children[0]?.children.length, 2)
  assert.equal(before.children[0]?.children[0]?.children[0]?.type, 'svg')
  assert.equal(before.children[0]?.children[0]?.children[0]?.children[0]?.props.fill, 'currentColor')
  before.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(harness.getSnapshot().current.provider, 'opencode-go-vision')
  assert.equal(harness.getSnapshot().status, 'error')

  const rendered = harness.render()
  const button = buttonOf(rendered)
  const toast = firstChildOfType(rendered, harness.primitives.Toast)
  assert.equal(button.props['aria-pressed'], true)
  assert.equal(button.props.disabled, false)
  assert.equal(button.children[0]?.children[0]?.children[0]?.type, 'svg')
  assert.equal(button.children[0]?.children[0]?.children[0]?.children[0]?.props.fill, 'currentColor')
  assert.equal(button.children[1].children[0], '识图')
  assert.equal(button.children.length, 2)
  assert.equal(button.props.title, '关闭识图模式')
  assert.ok(toast)
  assert.equal(toast.props.text, `模型操作失败：${error}`)
  assert.equal(toast.props.anchor, null)

  button.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.selections.length, 2)
})

test('issue #284 treats resolved Host RemoteResult failures as rejected selections', async () => {
  const error = 'session/writer-held: Another writer temporarily owns this session.'
  const harness = createBrowserHarness({
    current: { provider: 'opencode-go', model: 'qwen3.6-plus', reasoningEffort: 'high' },
    returnSelectionFailure: error,
  })

  const before = buttonOf(harness.render())
  assert.equal(before.props['aria-pressed'], false)
  before.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(harness.getSnapshot().current.provider, 'opencode-go')
  assert.equal(harness.getSnapshot().status, 'error')

  const rendered = harness.render()
  const toast = firstChildOfType(rendered, harness.primitives.Toast)
  assert.ok(toast)
  assert.equal(toast.props.text, `模型操作失败：${error}`)
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
  assert.match(main.dictionaries.zh.quickStartBody, /它变成选中态（高亮底色）表示已开启/)
  assert.match(main.dictionaries.zh.onboardingStep1Title, /开启识图/)
  assert.match(main.dictionaries.zh.onboardingStep1Body, /模型选择器左侧的「识图」/)
  assert.match(main.dictionaries.zh.guideStep1Body, /^高亮的是聊天模型选择器/)
  assert.equal(main.dictionaries.zh.guideStep1Body.includes('和「识图」按钮已经被高亮'), false)
  assert.match(main.dictionaries.en.quickStartBody, /lights up in its selected state to mean it is on/)
})

test('issue #357 uses fixed SVG icons instead of platform-dependent text glyphs', () => {
  const harness = createBrowserHarness()
  const offButton = buttonOf(harness.render())
  assert.equal(offButton.children[0]?.type, 'span')
  assert.equal(offButton.children[0]?.children.length, 2)
  assert.equal(offButton.children[0]?.children[0]?.props.className, 'vr-vision-toggle-glyph-part vr-vision-toggle-glyph-eye')
  assert.equal(offButton.children[0]?.children[0]?.children[0]?.type, 'svg')
  assert.equal(offButton.children[0]?.children[0]?.children[0]?.props.viewBox, '0 0 14 14')
  assert.equal(offButton.children[0]?.children[0]?.children[0]?.children[0]?.props.fill, 'currentColor')
  assert.equal(offButton.children[0]?.children[1]?.props.className, 'vr-vision-toggle-glyph-part vr-vision-toggle-glyph-check')

  harness.setSnapshot({
    current: { provider: 'opencode-go-vision', model: 'qwen3.6-plus', reasoningEffort: 'high' },
    groups,
    status: 'ready',
    error: null,
  })
  const onButton = buttonOf(harness.render())
  assert.equal(onButton.children[0]?.children[0]?.children[0]?.type, 'svg')
  assert.equal(onButton.children[0]?.children[0]?.children[0]?.props.viewBox, '0 0 14 14')
  // Both states ship both glyphs; the stylesheet swaps them, and the negative form of each
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("}, '👁')"), false)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("}, '✓')"), false)
})

test('issue #284 smooths only the directory reload owned by this Vision toggle', async () => {
  const harness = createBrowserHarness({ deferSelection: true })
  const offButton = buttonOf(harness.render())
  assert.equal(offButton.props.disabled, false)

  offButton.props.onClick()
  const target = harness.selections.at(-1)
  assert.equal(target?.provider, 'opencode-go-vision')
  assert.equal(target?.model, 'qwen3.6-plus')
  assert.equal(target?.reasoningEffort, 'high')

  // The official directory owns the transaction. Once its pending selection
  // matches our target, remember only the settled presentation while that same
  // transaction moves through an incomplete generation.
  harness.setSnapshot({
    current: target,
    groups,
    status: 'selecting',
    pending: target,
    error: null,
  })
  const selecting = buttonOf(harness.render())
  assert.equal(selecting.props['aria-pressed'], true)
  assert.equal(selecting.props.disabled, true)
  assert.equal(selecting.props['aria-busy'], true)

  harness.setSnapshot({
    current: target,
    groups: [groups[1]],
    status: 'loading',
    pending: target,
    error: null,
  })
  const partial = buttonOf(harness.render())
  assert.equal(partial.props['aria-pressed'], true)
  assert.equal(partial.props.disabled, true)
  assert.equal(partial.props['aria-busy'], true)
  assert.equal(partial.props.title, '切换中')
  // Waiting on this toggle's own selection must not grey the chip: only the
  // unavailable/loading states set the dimming attribute.
  assert.equal(partial.props['data-dimmed'], 'false')
  assert.equal(partial.children[0]?.props.className, 'vr-vision-toggle-glyph')

  harness.setSnapshot({ current: null, groups: [], status: 'idle', pending: target, error: null })
  const empty = buttonOf(harness.render())
  assert.equal(empty.props['aria-pressed'], true)
  assert.equal(empty.props.disabled, true)
  assert.equal(empty.props['data-dimmed'], 'false')

  harness.resolveSelection()
  await new Promise((resolve) => setImmediate(resolve))
  harness.setSnapshot({ current: target, groups, status: 'ready', pending: null, error: null })
  const ready = buttonOf(harness.render())
  assert.equal(ready.props['aria-pressed'], true)
  assert.equal(ready.props.disabled, false)
  assert.equal(ready.props['aria-busy'], false)

  // The same directory object is also reloaded by connection, adapter,
  // settings and credential updates. Without an owned toggle transaction,
  // incomplete generations stay authoritative instead of reusing stale ON.
  harness.setSnapshot({
    current: target,
    groups: [groups[1]],
    status: 'loading',
    pending: null,
    error: null,
  })
  const externalPartial = buttonOf(harness.render())
  assert.equal(externalPartial.props['aria-pressed'], false)
  assert.equal(externalPartial.props.disabled, true)
  assert.equal(externalPartial.props['aria-busy'], true)
  assert.equal(externalPartial.props.title, '加载中')
  assert.equal(externalPartial.props['data-dimmed'], 'true')

  harness.setSnapshot({ current: null, groups: [], status: 'loading', pending: null, error: null })
  const resetLoading = buttonOf(harness.render())
  assert.equal(resetLoading.props['aria-pressed'], false)
  assert.equal(resetLoading.props.disabled, true)
  assert.equal(resetLoading.props['data-dimmed'], 'true')
})

test('issue #284 remains explicit and persistent with no send/image auto-reset hook', () => {
  const source = readFileSync(new URL('../lib/client-presentation-boundary.js', import.meta.url), 'utf8')
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("ctx.inject(['slots', 'modelDirectories', 'sessions', 'remote']"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("scope.slots.inject('conversation.input.right'"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("id: 'vision-router-mode-toggle'"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("'data-vision-router-mode-toggle': 'true'"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("require('@deepseek-ai/dsh-client-ui-primitives')"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("failed: '模型操作失败：{message}'"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("fill: 'currentColor'"), true)
  // Both glyphs ship as fixed SVG: the filled eye and the stroked check.
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("stroke: 'currentColor'"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes(".vr-vision-toggle-glyph-check{display:none}"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("@container (min-width:460.01px)"), true)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("}, '👁')"), false)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes("}, '✓')"), false)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes('failedShort'), false)
  assert.equal(source.includes('send-committed'), false)
  assert.equal(source.includes('conversation.input.attachments'), false)
  assert.equal(source.includes('imageIds'), false)
})
