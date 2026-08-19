import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {
  REMOTE_SETTINGS_AUTHORIZE_ENDPOINT,
  REMOTE_SETTINGS_CHANNEL,
  createVisionRouterRemoteSettingsHandler,
} from '../lib/remote-settings-bridge.js'
import {
  REMOTE_SETTINGS_RISK_CLIENT_PRELUDE,
  injectRemoteSettingsRiskConfirmationPrelude,
} from '../lib/remote-settings-risk-confirmation.js'

function settingsFixture() {
  let revision = 4
  const value = { allowRemoteSettings: false, routing: false, proxy: 'http://127.0.0.1:1080' }
  const user = {}
  const calls = []
  const settings = {
    writable: true,
    describe() {
      return [{
        ns: 'vision-router',
        value: structuredClone(value),
        base: { allowRemoteSettings: false, routing: false, proxy: '' },
        user: structuredClone(user),
        revision,
        applies: 'live',
        secrets: [],
      }]
    },
    async mutate(ns, ops, expectedRevision) {
      calls.push([ns, structuredClone(ops), expectedRevision])
      assert.equal(ns, 'vision-router')
      assert.equal(expectedRevision, revision)
      const op = ops[0]
      if (op.op === 'set') {
        value[op.path[0]] = structuredClone(op.value)
        user[op.path[0]] = structuredClone(op.value)
      } else {
        delete user[op.path[0]]
      }
      revision += 1
    },
  }
  return { settings, value, user, calls }
}

test('remote authorization requires explicit risk acceptance and only enables the permission field', async () => {
  const fixture = settingsFixture()
  const handler = createVisionRouterRemoteSettingsHandler(fixture.settings)

  const before = await handler('describe', {})
  assert.deepEqual(before.value, { enabled: false, reason: 'permission-disabled', writable: false })

  const rejected = await handler(REMOTE_SETTINGS_AUTHORIZE_ENDPOINT, { acceptedRisk: false })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'bad-request')
  assert.equal(fixture.calls.length, 0)

  const enabled = await handler(REMOTE_SETTINGS_AUTHORIZE_ENDPOINT, { acceptedRisk: true })
  assert.equal(enabled.ok, true)
  assert.equal(enabled.value.enabled, true)
  assert.equal(enabled.value.writable, true)
  assert.equal(fixture.user.allowRemoteSettings, true)
  assert.deepEqual(fixture.calls[0], [
    'vision-router',
    [{ op: 'set', path: ['allowRemoteSettings'], value: true }],
    4,
  ])
  assert.equal(Object.hasOwn(enabled.value.view.value, 'allowRemoteSettings'), false)
  assert.equal(Object.hasOwn(enabled.value.view.value, 'proxy'), false)
  assert.equal(enabled.value.view.value.routing, false)
})

function runRiskPrelude(confirmResult) {
  const loaded = []
  const loader = { load(spec) { loaded.push(spec) } }
  const calls = []
  let enabled = false
  let appliedCtx
  let confirms = 0
  const rpc = {
    async call(channel, endpoint, payload) {
      calls.push([channel, endpoint, payload])
      assert.equal(channel, REMOTE_SETTINGS_CHANNEL)
      if (endpoint === 'describe') {
        return {
          ok: true,
          value: enabled
            ? { enabled: true, reason: 'enabled', writable: true, view: { value: { routing: false }, user: {}, revision: 5 } }
            : { enabled: false, reason: 'permission-disabled', writable: false },
        }
      }
      if (endpoint === REMOTE_SETTINGS_AUTHORIZE_ENDPOINT) {
        assert.deepEqual(payload, { acceptedRisk: true })
        enabled = true
        return {
          ok: true,
          value: { enabled: true, reason: 'enabled', writable: true, view: { value: { routing: false }, user: {}, revision: 5 } },
        }
      }
      throw new Error('unexpected endpoint ' + endpoint)
    },
  }
  const connection = { rpc }
  const window = {
    __ModuleLoader__: loader,
    confirm(message) {
      confirms += 1
      assert.match(String(message), /trustedHosts/)
      return confirmResult
    },
    alert() {},
  }
  const context = {
    window,
    document: { documentElement: { lang: 'zh-CN' } },
    navigator: { language: 'zh-CN' },
    Proxy, Reflect, Object, Array, WeakMap, Promise, String, Error, TypeError, console,
  }
  vm.runInNewContext(REMOTE_SETTINGS_RISK_CLIENT_PRELUDE, context)
  loader.load({
    id: 'dsh-vision-router',
    factory() {
      return {
        apply(ctx) { appliedCtx = ctx },
      }
    },
  })
  const exports = loaded[0].factory(() => undefined)
  exports.apply({
    get(name) { return name === 'connection' ? connection : undefined },
  })
  return { appliedCtx, calls, get confirms() { return confirms } }
}

test('remote client confirmation authorizes once and refreshes the disabled describe', async () => {
  const harness = runRiskPrelude(true)
  const connection = harness.appliedCtx.get('connection')
  const result = await connection.rpc.call(REMOTE_SETTINGS_CHANNEL, 'describe', {})

  assert.equal(result.ok, true)
  assert.equal(result.value.enabled, true)
  assert.equal(harness.confirms, 1)
  assert.deepEqual(harness.calls.map((entry) => entry[1]), ['describe', 'authorize', 'describe'])
})

test('canceling the risk prompt leaves remote settings disabled and performs no authorization', async () => {
  const harness = runRiskPrelude(false)
  const connection = harness.appliedCtx.get('connection')
  const result = await connection.rpc.call(REMOTE_SETTINGS_CHANNEL, 'describe', {})

  assert.equal(result.ok, true)
  assert.equal(result.value.enabled, false)
  assert.equal(result.value.reason, 'permission-disabled')
  assert.equal(harness.confirms, 1)
  assert.deepEqual(harness.calls.map((entry) => entry[1]), ['describe'])
})

test('risk confirmation prelude injection is idempotent', () => {
  const html = '<html><head></head><body></body></html>'
  const once = injectRemoteSettingsRiskConfirmationPrelude(html)
  assert.match(once, /data-vision-router-remote-settings-risk-confirmation/)
  assert.equal(injectRemoteSettingsRiskConfirmationPrelude(once), once)
})
