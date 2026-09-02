import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { CLIENT_HOST_COMPAT_PRELUDE } from '../lib/client-host-compat-prelude.js'
import { CLIENT_PRESENTATION_PRELUDE } from '../lib/client-presentation-boundary.js'
import { LIVE_MODEL_CLIENT_PRELUDE } from '../lib/live-model-client-prelude.js'
import { SETTINGS_FACTORY_LIFECYCLE_PRELUDE } from '../lib/settings-factory-lifecycle.js'
import { SETTINGS_NUMBER_META } from '../lib/settings-number-contract.js'
import { VISION_MODEL_VISIBILITY_PRELUDE } from '../lib/vision-model-visibility-boundary-main.js'
import { V2_SETTINGS_IA_CLIENT } from '../lib/v2-settings-ia-integration.js'
import { VISION_TURN_BUDGET_CLIENT_PRELUDE } from '../lib/vision-turn-budget-client-prelude.js'

function childrenOf(value) {
  if (value === undefined || value === null || value === false) return []
  return Array.isArray(value) ? value.flatMap(childrenOf) : [value]
}

function fakeReact() {
  let cardsOpen = {}
  let stateIndex = 0
  const Fragment = Symbol('Fragment')
  const React = {
    Fragment,
    createElement(type, props, ...children) {
      const next = { ...(props || {}) }
      if (children.length === 1) next.children = children[0]
      else if (children.length > 1) next.children = children
      return { type, props: next }
    },
    cloneElement(node, props) {
      return { type: node.type, props: { ...(node.props || {}), ...(props || {}) } }
    },
    isValidElement(node) {
      return !!node && typeof node === 'object' && 'type' in node && 'props' in node
    },
    Children: {
      forEach(value, fn) { childrenOf(value).forEach(fn) },
      map(value, fn) { return childrenOf(value).map(fn) },
      toArray(value) { return childrenOf(value) },
    },
    useState(initial) {
      const index = stateIndex
      stateIndex += 1
      const value = typeof initial === 'function' ? initial() : initial
      if (index === 0) {
        return [
          cardsOpen,
          (next) => {
            cardsOpen = typeof next === 'function' ? next(cardsOpen) : next
          },
        ]
      }
      return [value, () => {}]
    },
    useMemo(fn) { return fn() },
    useEffect() {},
    useRef(value) { return { current: value } },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    memo(component) { return component },
  }
  React.setSettingsCardsOpen = (next) => {
    cardsOpen = typeof next === 'function' ? next(cardsOpen) : next
  }
  React.renderSettings = (component, props) => {
    stateIndex = 0
    return component(props)
  }
  return React
}

function walk(node, visit) {
  if (node === undefined || node === null || node === false) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  if (node.props) walk(node.props.children, visit)
}

function findNode(tree, predicate) {
  let found
  walk(tree, (node) => {
    if (found === undefined && predicate(node)) found = node
  })
  return found
}

function textOf(tree) {
  const parts = []
  function visit(value) {
    if (value === undefined || value === null || value === false) return
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(String(value))
      return
    }
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value === 'object' && value.props) visit(value.props.children)
  }
  visit(tree)
  return parts.join(' ')
}

function alphaHarness() {
  const pending = []
  const live = new Map()
  const loader = {
    mode: 'queue',
    load(spec) {
      if (this.mode === 'queue') pending.push(spec)
      else live.set(spec.id, spec)
      return spec
    },
    create() {
      assert.equal(this.mode, 'queue')
      this.mode = 'live'
      this.load = (spec) => {
        live.set(spec.id, spec)
        return spec
      }
      for (const spec of pending.splice(0)) this.load(spec)
      return this
    },
  }
  const window = {
    __ModuleLoader__: loader,
    location: { hostname: 'localhost' },
  }
  const context = {
    window,
    Object,
    Promise,
    Array,
    String,
    Number,
    Boolean,
    Reflect,
    Proxy,
    Symbol,
    Map,
    Set,
    WeakMap,
    Math,
    JSON,
    Error,
    TypeError,
    console,
    setTimeout() { return 1 },
    clearTimeout() {},
  }
  for (const prelude of [
    CLIENT_HOST_COMPAT_PRELUDE,
    CLIENT_PRESENTATION_PRELUDE,
    LIVE_MODEL_CLIENT_PRELUDE,
    VISION_MODEL_VISIBILITY_PRELUDE,
    SETTINGS_FACTORY_LIFECYCLE_PRELUDE,
    VISION_TURN_BUDGET_CLIENT_PRELUDE,
  ]) {
    vm.runInNewContext(prelude, context)
  }
  loader.create()
  return { loader, live, context }
}

function slotContext({ React, events, catalogCalls }) {
  const ledger = []
  const snapshot = {
    status: 'ready',
    writable: true,
    value: {
      settingsContractRevision: 3,
      providers: [],
      freeFallback: true,
      visionTaskTimeoutMs: 45000,
      visionTurnBudgetMs: 0,
      structuredVisionBootstrap: true,
      visionDepth: 'standard',
      visionDepthMaxCalls: 0,
    },
    base: {},
    user: {},
  }
  const settingsScope = {
    subscribe() { return () => {} },
    getSnapshot() { return snapshot },
    async set(key, value) { snapshot.user[key] = value; snapshot.value[key] = value },
    async unset(key) { delete snapshot.user[key]; delete snapshot.value[key] },
    async load() {},
  }
  const catalog = {
    groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }] }],
    failures: [],
  }
  const remote = {
    session: {
      async modelCatalog() {
        catalogCalls.push('remote.session.modelCatalog')
        return { ok: true, value: catalog }
      },
    },
    $on(event) {
      events.push(event)
      return () => {}
    },
  }
  const connection = { isLoopback: true, rpc: { call() {} } }
  const ctx = {
    settingsScope: { bind() { return settingsScope } },
    slots: {
      register(options, component) {
        const entry = { options, component }
        ledger.push(entry)
        return () => {
          const index = ledger.indexOf(entry)
          if (index !== -1) ledger.splice(index, 1)
        }
      },
      inject(_name, producer) {
        const iterator = producer()
        if (iterator && typeof iterator[Symbol.iterator] === 'function') {
          for (const _value of iterator) void _value
        }
        return () => {}
      },
      entries(name) {
        return ledger.filter((entry) => entry.options && entry.options.name === name)
      },
    },
    locale: {
      register() { return () => {} },
      define() { return () => {} },
      bind() { return (key) => key },
      subscribe() { return () => {} },
      getSnapshot() { return 'en' },
    },
    sessions: { binding() { return undefined } },
    remote,
    get(name) { return name === 'connection' ? connection : undefined },
    on() { return () => {} },
    effect(effect) {
      const cleanup = effect()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
  }
  return { ctx, ledger, catalog }
}

test('alpha.1 real DVR browser lifecycle keeps one Settings IA surface and all client boundaries', async () => {
  const harness = alphaHarness()
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  vm.runInNewContext(source, harness.context)

  const spec = harness.live.get('dsh-vision-router')
  assert.ok(spec, 'real dsh-vision-router client bundle must reach the live loader')

  const React = fakeReact()
  const requested = []
  const plugin = spec.factory((id) => {
    requested.push(id)
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`unexpected browser module request: ${id}`)
  })

  const events = []
  const catalogCalls = []
  const { ctx, ledger, catalog } = slotContext({ React, events, catalogCalls })
  await plugin.apply(ctx)

  const settingsSections = ledger.filter((entry) =>
    entry.options?.name === 'settings.section' && entry.options?.id === 'vision-router')
  assert.equal(settingsSections.length, 1, 'Vision Router must expose exactly one first-class settings section')
  assert.equal(
    ledger.some((entry) => entry.options?.name === 'settings.plugin.item' &&
      (entry.options?.id === 'vision-router' || entry.options?.key === 'vision-router')),
    false,
    'Vision Router must not register the legacy Settings > Plugins compatibility entry',
  )

  const section = settingsSections[0]
  const props = section.options.inject()

  React.setSettingsCardsOpen({ general: true })
  const generalTree = React.renderSettings(section.component, props)
  assert.ok(findNode(generalTree, (node) => String(node.props?.className || '').split(/\s+/).includes('vr-settings-ia-root')))
  assert.ok(findNode(generalTree, (node) => node.props?.id === 'vr-vision-backend-chain'))

  React.setSettingsCardsOpen({ strategy: true })
  const strategyTree = React.renderSettings(section.component, props)
  const depthSelect = findNode(strategyTree, (node) => node.props?.['data-vr-depth-strategy'] === '1')
  assert.ok(depthSelect, 'final Settings IA must own the depth strategy selector')
  assert.equal(depthSelect.props.value, 'standard')
  assert.deepEqual(
    childrenOf(depthSelect.props.children).map((option) => option.props?.value),
    ['fast', 'standard', 'deep'],
  )
  const depthCap = findNode(strategyTree, (node) => node.props?.['data-vr-depth-cap'] === '1')
  assert.ok(depthCap, 'final Settings IA must own the independent depth-call cap')
  const depthCapToggle = findNode(depthCap, (node) => node.props?.['data-vr-depth-cap-toggle'] === '1')
  assert.ok(depthCapToggle)
  assert.equal(depthCapToggle.props.checked, false)
  assert.equal(findNode(depthCap, (node) => node.props?.['data-vr-depth-cap-value'] === '1'), undefined)
  assert.match(V2_SETTINGS_IA_CLIENT, /var ROOT='\.vr-settings-ia-root'/)
  assert.match(V2_SETTINGS_IA_CLIENT, /var CHAIN='#vr-vision-backend-chain'/)

  React.setSettingsCardsOpen({ advanced: true })
  const advancedTree = React.renderSettings(section.component, props)
  const taskMeta = SETTINGS_NUMBER_META.visionTaskTimeoutMs
  const taskInput = findNode(advancedTree, (node) =>
    node.type === 'input' && node.props?.type === 'number' &&
    Number(node.props?.min) === taskMeta.min && Number(node.props?.max) === taskMeta.max)
  assert.ok(taskInput, 'advanced IA must render the vision task timeout numeric field')
  assert.equal(Number(taskInput.props.step), taskMeta.step, 'numeric hardening must survive the final IA replacement')

  React.setSettingsCardsOpen({ diagnostics: true })
  const diagnosticsTree = React.renderSettings(section.component, props)
  assert.match(textOf(diagnosticsTree), /Settings contract|设置协议/)
  assert.ok(findNode(diagnosticsTree, (node) => node.props?.['data-vr-limit-diagnostics'] === '1'))

  const compatConnection = props.getConnection()
  const modelCatalog = await compatConnection.api.llm.models({})
  assert.deepEqual(JSON.parse(JSON.stringify(modelCatalog)), { result: { ok: true, value: catalog } })
  assert.deepEqual(catalogCalls, ['remote.session.modelCatalog'])
  props.remote.$on('credentials/updated', () => {})
  assert.ok(events.includes('credentials/reference-updated'))

  assert.equal(requested.includes('@deepseek-ai/dsh-client-ui-attachment'), false)
  assert.ok(ledger.some((entry) => entry.options?.name === 'tool.call.toolview' && entry.options?.key === 'vision_present'))
})

test('alpha.1 live transition keeps stock model selector visibility projection', () => {
  const harness = alphaHarness()
  harness.loader.load({
    id: '@deepseek-ai/dsh-client-ui-model-selection',
    factory() {
      return {
        apply(ctx) {
          const directory = ctx.modelDirectories.directoryFor('chat')
          ctx.observed = directory.store.getSnapshot()
        },
      }
    },
  })
  const spec = harness.live.get('@deepseek-ai/dsh-client-ui-model-selection')
  const plugin = spec.factory(() => ({}))
  const raw = {
    groups: [
      { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4' }] },
      { id: 'deepseek-vision', name: 'DeepSeek + 自动识图', models: [{ id: 'deepseek-v4' }] },
    ],
    current: { provider: 'deepseek-vision', model: 'deepseek-v4' },
  }
  const observedCtx = {
    settingsScope: {
      bind() {
        return {
          subscribe() { return () => {} },
          getSnapshot() { return { value: { wrapperRoute: 'deepseek-vision', autoWrapProviders: true } } },
        }
      },
    },
    modelDirectories: {
      directoryFor() {
        return {
          store: {
            subscribe() { return () => {} },
            getSnapshot() { return raw },
          },
        }
      },
    },
  }
  plugin.apply(observedCtx)
  assert.deepEqual(observedCtx.observed.groups.map((group) => group.id), ['deepseek-official'])
  assert.equal(observedCtx.observed.current.provider, 'deepseek-official')
})
