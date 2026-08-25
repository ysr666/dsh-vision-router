import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import {
  SETTINGS_NUMBER_META,
  parseSettingsNumber,
} from '../lib/settings-number-contract.js'
import {
  SETTINGS_LIMIT_CLIENT_PRELUDE,
  injectSettingsLimitClientPrelude,
} from '../lib/settings-limit-client-prelude.js'
import {
  formatVisionTurnGuard,
  installVisionLimitDiagnostics,
  resolveVisionLimitDiagnostics,
} from '../lib/vision-limit-diagnostics.js'
import {
  formatDoctorVisionLimits,
  parseVisionLimitLog,
} from '../lib/doctor-vision-limits.js'

function reactStub() {
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { $$react: true, type, props: { ...(props ?? {}), children } }
    },
    isValidElement(value) { return Boolean(value?.$$react) },
    cloneElement(node, props) {
      return { ...node, props: { ...node.props, ...(props ?? {}) } }
    },
    Children: {
      map(children, fn) { return (Array.isArray(children) ? children : [children]).map(fn) },
      forEach(children, fn) { (Array.isArray(children) ? children : [children]).forEach(fn) },
      toArray(children) { return Array.isArray(children) ? [...children] : children === undefined ? [] : [children] },
    },
  }
  return React
}

function textOf(React, node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!React.isValidElement(node)) return ''
  return React.Children.toArray(node.props?.children).map((child) => textOf(React, child)).join(' ')
}

test('issue 307: numeric client contract matches the final public timeout steps', () => {
  assert.deepEqual(SETTINGS_NUMBER_META.visionTaskTimeoutMs, { min: 1000, max: 180000, step: 1000 })
  assert.deepEqual(parseSettingsNumber('visionTaskTimeoutMs', 180000), { value: 180000 })
  assert.equal(parseSettingsNumber('visionTaskTimeoutMs', 181000), undefined)
  assert.equal(parseSettingsNumber('visionTaskTimeoutMs', 120500), undefined)

  // Core timeout/OCR schemas intentionally remain step(1); issue #307 must not
  // accidentally widen the 1000ms step requirement beyond the public task cap.
  assert.deepEqual(parseSettingsNumber('timeoutMs', 120500), { value: 120500 })
  assert.deepEqual(parseSettingsNumber('ocrTimeoutMs', 30500), { value: 30500 })
  assert.deepEqual(parseSettingsNumber('visionTurnBudgetMs', 180000), { value: 180000 })
  assert.equal(parseSettingsNumber('visionTurnBudgetMs', 180500), undefined)
})

test('issue 307: settings prelude rejects invalid task values before the Host and rewrites the confusing copy', async () => {
  const React = reactStub()
  let capturedSpec
  const loader = { load(spec) { capturedSpec = spec } }
  const sandbox = {
    window: { __ModuleLoader__: loader },
    document: { documentElement: { lang: 'zh-CN' } },
    Object, Promise, Array, String, Number, Map, Set, WeakMap, Reflect, JSON,
  }
  vm.runInNewContext(SETTINGS_LIMIT_CLIENT_PRELUDE, sandbox)

  let registered
  let seenScope
  loader.load({
    id: 'dsh-vision-router',
    factory() {
      return {
        apply(ctx) {
          ctx.slots.register(
            { name: 'settings.section', id: 'vision-router' },
            function Original(props) {
              seenScope = props.scope
              return React.createElement('div', null,
                React.createElement('span', null, '单个视觉任务'),
                React.createElement('span', null, '整轮视觉工具上限'),
                React.createElement('span', null, '部分配置没有写入，未写入的修改已保留。'),
              )
            },
          )
        },
      }
    },
  })
  const plugin = capturedSpec.factory((id) => {
    assert.equal(id, 'react')
    return React
  })
  plugin.apply({ slots: { register(_options, component) { registered = component } } })

  const calls = []
  const snapshot = {
    value: { visionTaskTimeoutMs: 120000, visionTurnBudgetMs: 0 },
    user: {},
    base: {},
  }
  const scope = {
    getSnapshot() { return snapshot },
    async set(key, value) { calls.push([key, value]) },
  }
  const tree = registered({ scope })
  const text = textOf(React, tree)
  assert.match(text, /单次识图任务超时/)
  assert.match(text, /首次识图后的整轮时间上限/)
  assert.match(text, /Host 未接受或未持久化/)

  await assert.rejects(() => seenScope.set('visionTaskTimeoutMs', 120500), /steps of 1000/)
  await assert.rejects(() => seenScope.set('visionTaskTimeoutMs', 181000), /between 1000 and 180000/)
  assert.deepEqual(calls, [])
  await seenScope.set('visionTaskTimeoutMs', 180000)
  assert.deepEqual(calls, [['visionTaskTimeoutMs', 180000]])
})

test('issue 307: diagnostics surface shows effective timeout, deadline and override source', () => {
  const React = reactStub()
  let capturedSpec
  const loader = { load(spec) { capturedSpec = spec } }
  const sandbox = {
    window: { __ModuleLoader__: loader },
    document: { documentElement: { lang: 'zh-CN' } },
    Object, Promise, Array, String, Number, Map, Set, WeakMap, Reflect, JSON,
  }
  vm.runInNewContext(SETTINGS_LIMIT_CLIENT_PRELUDE, sandbox)
  let registered
  loader.load({
    id: 'dsh-vision-router',
    factory() {
      return {
        apply(ctx) {
          ctx.slots.register(
            { name: 'settings.section', id: 'vision-router' },
            () => React.createElement('div', null, '设置协议'),
          )
        },
      }
    },
  })
  const plugin = capturedSpec.factory(() => React)
  plugin.apply({ slots: { register(_options, component) { registered = component } } })
  const scope = {
    getSnapshot() {
      return {
        value: { visionTaskTimeoutMs: 120000, visionTurnBudgetMs: 180000 },
        user: { visionTurnBudgetMs: 180000 },
        base: {},
      }
    },
    async set() {},
  }
  const text = textOf(React, registered({ scope }))
  assert.match(text, /120 秒 · 默认/)
  assert.match(text, /180 秒 · 用户设置/)
  assert.match(text, /v2 默认是不限制/)
})

test('issue 307: runtime diagnostics preserve budget semantics while exposing limit and source', async () => {
  const settings = {
    get(ns) {
      assert.equal(ns, 'vision-router')
      return { visionTaskTimeoutMs: 120000, visionTurnBudgetMs: 180000 }
    },
    describe() {
      return [{
        ns: 'vision-router',
        value: { visionTaskTimeoutMs: 120000, visionTurnBudgetMs: 180000 },
        base: {},
        user: { visionTurnBudgetMs: 180000 },
      }]
    },
  }
  let registeredTool
  let preStep
  const warnings = []
  const ctx = {
    get(name) { return name === 'settings' ? settings : undefined },
    tools: { register(def) { registeredTool = def } },
    on(event, handler) { if (event === 'agent/pre-step') preStep = handler },
  }
  const resolved = resolveVisionLimitDiagnostics(ctx, {})
  assert.deepEqual(resolved, {
    taskTimeoutMs: 120000,
    turnBudgetMs: 180000,
    taskSource: 'default',
    turnSource: 'user',
  })

  const wrapped = installVisionLimitDiagnostics(ctx, {}, { warn(...args) { warnings.push(args) } })
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() { return JSON.stringify({ ok: false, code: 'VISION_TURN_BUDGET_EXCEEDED' }) },
  })
  const session = {}
  await registeredTool.execute({}, { agent: { session, turn: 7 } })
  await registeredTool.execute({}, { agent: { session, turn: 7 } })
  assert.equal(warnings.length, 1, 'exhaustion is logged once per turn')
  assert.equal(warnings[0].includes(180000), true)

  wrapped.on('agent/pre-step', async () => ({
    messages: [{
      id: 'vision-router-structured-guard-stop-7',
      content: [{ type: 'text', text: '本轮视觉总时间预算已耗尽。不要再调用视觉工具。' }],
    }],
  }))
  const decision = await preStep({ turn: 7 }, undefined)
  const guard = decision.messages[0].content[0].text
  assert.match(guard, /180 秒上限/)
  assert.match(guard, /默认配置为“不限制”/)
  assert.match(formatVisionTurnGuard(180000), /180 秒上限/)
})

test('issue 307: doctor parses the effective limit line and warns only for explicit positive turn caps', () => {
  const limits = parseVisionLimitLog([
    '[INFO] vision-router: effective vision limits taskTimeoutMs=120000 taskSource=default turnBudgetMs=180000 turnSource=user',
    '[WARN] vision-router: vision turn deadline exhausted turn=9 budgetMs=180000 elapsedMs=180143',
  ].join('\n'))
  assert.equal(limits.taskTimeoutMs, 120000)
  assert.equal(limits.turnBudgetMs, 180000)
  assert.equal(limits.turnSource, 'user')
  assert.equal(limits.explicitTurnLimit, true)
  assert.deepEqual(limits.latestExhaustion, { turn: '9', budgetMs: 180000, elapsedMs: 180143 })
  const lines = formatDoctorVisionLimits(limits)
  assert.equal(lines.some((line) => line === 'Vision task timeout: 120s (default)'), true)
  assert.equal(lines.some((line) => line === 'Vision turn deadline: 180s (user)'), true)
  assert.equal(lines.some((line) => line.startsWith('WARN:')), true)

  const unlimited = parseVisionLimitLog('[INFO] vision-router: effective vision limits taskTimeoutMs=120000 taskSource=default turnBudgetMs=0 turnSource=default')
  assert.equal(unlimited.explicitTurnLimit, false)
  assert.equal(formatDoctorVisionLimits(unlimited).some((line) => line.startsWith('WARN:')), false)
})

test('issue 307: settings limit prelude injection is idempotent', () => {
  const html = '<html><head></head><body></body></html>'
  const once = injectSettingsLimitClientPrelude(html)
  assert.match(once, /data-vision-router-settings-limit-hardening/)
  assert.equal(injectSettingsLimitClientPrelude(once), once)
})
