import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {
  REMOTE_SETTINGS_AUTHORIZE_ENDPOINT,
  REMOTE_SETTINGS_CHANNEL,
  createVisionRouterRemoteSettingsHandler,
} from '../lib/remote-settings-bridge.js'
import { LOCAL_PERMISSION_CLIENT_PRELUDE } from '../lib/local-remote-settings-permission.js'
import { createRemoteSettingsRiskClientBoundary } from '../lib/remote-settings-risk-client-boundary.js'
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

test('remote enablement requires explicit risk acknowledgement and only enables the permission field', async () => {
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

test('shared remote-risk owner coalesces concurrent authorization and refreshes once', async () => {
  let enabled = false
  let confirms = 0
  const calls = []
  const rpc = {
    async call(channel, endpoint, payload) {
      calls.push([channel, endpoint, payload])
      if (endpoint === 'describe') {
        return {
          ok: true,
          value: enabled
            ? { enabled: true, reason: 'enabled', writable: true }
            : { enabled: false, reason: 'permission-disabled', writable: false },
        }
      }
      if (endpoint === REMOTE_SETTINGS_AUTHORIZE_ENDPOINT) {
        enabled = true
        return { ok: true, value: { enabled: true, reason: 'enabled', writable: true } }
      }
      throw new Error('unexpected endpoint ' + endpoint)
    },
  }
  const boundary = createRemoteSettingsRiskClientBoundary({
    confirmImpl(message) {
      confirms += 1
      assert.match(String(message), /trustedHosts/)
      return true
    },
    locale: 'en-US',
  })
  const raw = { get(name) { return name === 'connection' ? { rpc } : undefined } }
  const wrapped = boundary.wrapContext(raw)
  assert.equal(boundary.wrapContext(raw), wrapped)

  const results = await Promise.all([
    wrapped.get('connection').rpc.call(REMOTE_SETTINGS_CHANNEL, 'describe', {}),
    wrapped.get('connection').rpc.call(REMOTE_SETTINGS_CHANNEL, 'describe', {}),
  ])
  assert.equal(results[0].value.enabled, true)
  assert.equal(results[1].value.enabled, true)
  assert.equal(confirms, 1)
  assert.equal(calls.filter((entry) => entry[1] === REMOTE_SETTINGS_AUTHORIZE_ENDPOINT).length, 1)
  assert.equal(calls.filter((entry) => entry[1] === 'describe').length, 3)
  assert.deepEqual(
    calls.find((entry) => entry[1] === REMOTE_SETTINGS_AUTHORIZE_ENDPOINT)[2],
    { acceptedRisk: true },
  )
})

test('remote-risk authorization coalesces only within one RPC target', async () => {
  let releaseA
  const gateA = new Promise((resolve) => { releaseA = resolve })
  const calls = []
  let confirms = 0
  const makeRpc = (name) => {
    let enabled = false
    return {
      async call(_channel, endpoint) {
        calls.push([name, endpoint])
        if (endpoint === 'describe') {
          return {
            ok: true,
            value: enabled
              ? { enabled: true, owner: name }
              : { enabled: false, reason: 'permission-disabled', writable: false },
          }
        }
        if (endpoint === REMOTE_SETTINGS_AUTHORIZE_ENDPOINT) {
          if (name === 'A') await gateA
          enabled = true
          return { ok: true, value: { enabled: true, owner: name } }
        }
        throw new Error('unexpected endpoint ' + endpoint)
      },
    }
  }
  const rpcA = makeRpc('A')
  const rpcB = makeRpc('B')
  const boundary = createRemoteSettingsRiskClientBoundary({
    confirmImpl() {
      confirms += 1
      return true
    },
    locale: 'en-US',
  })
  const wrappedA = boundary.wrapContext({
    get(name) { return name === 'connection' ? { rpc: rpcA } : undefined },
  }).get('connection').rpc
  const wrappedB = boundary.wrapContext({
    get(name) { return name === 'connection' ? { rpc: rpcB } : undefined },
  }).get('connection').rpc

  const pendingA = wrappedA.call(REMOTE_SETTINGS_CHANNEL, 'describe', {})
  await Promise.resolve()
  const resultB = await wrappedB.call(REMOTE_SETTINGS_CHANNEL, 'describe', {})
  assert.equal(resultB.value.owner, 'B')
  assert.equal(calls.filter(([name, endpoint]) => name === 'B' && endpoint === 'authorize').length, 1)

  releaseA()
  const resultA = await pendingA
  assert.equal(resultA.value.owner, 'A')
  assert.equal(calls.filter(([name, endpoint]) => name === 'A' && endpoint === 'authorize').length, 1)
  assert.equal(confirms, 2)
})

test('shared remote-risk owner normalizes official loopback only when requested', () => {
  const connection = { isLoopback: false, rpc: { call() {} } }
  const context = { get(name) { return name === 'connection' ? connection : undefined } }

  const plain = createRemoteSettingsRiskClientBoundary({
    location: { protocol: 'dsh-app:', hostname: 'app' },
  })
  assert.equal(plain.wrapContext(context).get('connection').isLoopback, false)

  const desktop = createRemoteSettingsRiskClientBoundary({
    location: { protocol: 'dsh-app:', hostname: 'app' },
    normalizeLoopback: true,
  })
  assert.equal(desktop.wrapContext(context).get('connection').isLoopback, true)

  const remote = createRemoteSettingsRiskClientBoundary({
    location: { protocol: 'https:', hostname: 'example.test' },
    normalizeLoopback: true,
  })
  assert.equal(remote.wrapContext(context).get('connection').isLoopback, false)
})

function runRiskPrelude(confirmResult, { localPrelude = false } = {}) {
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
        assert.equal(payload?.acceptedRisk, true)
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
  const rawScope = {
    getSnapshot() {
      return { status: 'ready', writable: true, mode: 'remote', revision: 5, value: {}, user: {} }
    },
    async load() {},
    async set() {},
    async unset() {},
  }
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
    fetch: async () => ({ ok: false, status: 403, async json() { return {} } }),
    Proxy, Reflect, Object, Array, WeakMap, Promise, String, Error, TypeError, JSON, Number, console,
  }
  vm.runInNewContext(REMOTE_SETTINGS_RISK_CLIENT_PRELUDE, context)
  if (localPrelude) vm.runInNewContext(LOCAL_PERMISSION_CLIENT_PRELUDE, context)
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
    settingsScope: { bind() { return rawScope } },
  })
  return { appliedCtx, calls, rawScope, get confirms() { return confirms } }
}

test('remote client confirmation enables once and refreshes the disabled describe', async () => {
  const harness = runRiskPrelude(true)
  const connection = harness.appliedCtx.get('connection')
  const result = await connection.rpc.call(REMOTE_SETTINGS_CHANNEL, 'describe', {})

  assert.equal(result.ok, true)
  assert.equal(result.value.enabled, true)
  assert.equal(harness.confirms, 1)
  assert.deepEqual(harness.calls.map((entry) => entry[1]), ['describe', 'authorize', 'describe'])
})

test('canceling the risk prompt leaves remote settings disabled and performs no enablement', async () => {
  const harness = runRiskPrelude(false)
  const connection = harness.appliedCtx.get('connection')
  const result = await connection.rpc.call(REMOTE_SETTINGS_CHANNEL, 'describe', {})

  assert.equal(result.ok, true)
  assert.equal(result.value.enabled, false)
  assert.equal(result.value.reason, 'permission-disabled')
  assert.equal(harness.confirms, 1)
  assert.deepEqual(harness.calls.map((entry) => entry[1]), ['describe'])
})

test('remote risk confirmation composes with the existing local permission client shim', async () => {
  const harness = runRiskPrelude(true, { localPrelude: true })
  const connection = harness.appliedCtx.get('connection')
  assert.ok(connection)
  const scope = harness.appliedCtx.settingsScope.bind({ namespace: 'vision-router' })
  assert.equal(scope.getSnapshot().mode, 'remote')

  const result = await connection.rpc.call(REMOTE_SETTINGS_CHANNEL, 'describe', {})
  assert.equal(result.value.enabled, true)
  assert.equal(harness.confirms, 1)
  assert.deepEqual(harness.calls.map((entry) => entry[1]), ['describe', 'authorize', 'describe'])
})

test('risk confirmation prelude injection is idempotent', () => {
  const html = '<html><head></head><body></body></html>'
  const once = injectRemoteSettingsRiskConfirmationPrelude(html)
  assert.match(once, /data-vision-router-remote-settings-risk-confirmation/)
  assert.equal(injectRemoteSettingsRiskConfirmationPrelude(once), once)
})
