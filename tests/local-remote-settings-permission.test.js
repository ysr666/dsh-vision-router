import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { Readable } from 'node:stream'
import { REMOTE_SETTINGS_PERMISSION } from '../lib/remote-settings-bridge.js'
import {
  LOCAL_PERMISSION_CLIENT_PRELUDE,
  LOCAL_REMOTE_SETTINGS_PERMISSION_PATH,
  createVisionRouterLocalPermissionHttpHandler,
  injectLocalPermissionClientPrelude,
  mutateLocalRemoteSettingsPermission,
} from '../lib/local-remote-settings-permission.js'

function settingsFixture() {
  const resolved = { [REMOTE_SETTINGS_PERMISSION]: false, routing: false }
  const user = {}
  let revision = 7
  const calls = []
  const settings = {
    writable: true,
    describe() {
      return [{ ns: 'vision-router', value: structuredClone(resolved), base: { [REMOTE_SETTINGS_PERMISSION]: false, routing: false }, user: structuredClone(user), revision, applies: 'live', secrets: [] }]
    },
    async mutate(ns, ops, expectedRevision) {
      calls.push([ns, structuredClone(ops), expectedRevision])
      assert.equal(ns, 'vision-router')
      assert.equal(expectedRevision, revision)
      const op = ops[0]
      if (op.op === 'set') {
        resolved[op.path[0]] = structuredClone(op.value)
        user[op.path[0]] = structuredClone(op.value)
      } else {
        delete user[op.path[0]]
        resolved[op.path[0]] = false
      }
      revision += 1
    },
  }
  return { settings, user, calls }
}

function request(body, { remoteAddress = '127.0.0.1', host = 'localhost:3000', origin = 'http://localhost:3000' } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.headers = { host, origin, 'content-type': 'application/json' }
  req.socket = { remoteAddress }
  return req
}

function response() {
  let body = ''
  return { get body() { return body }, setHeader() {}, end(value = '') { body += String(value) } }
}

test('Host mutation reports success only after raw user-layer readback', async () => {
  const fixture = settingsFixture()
  const enabled = await mutateLocalRemoteSettingsPermission(fixture.settings, { operation: 'set', value: true, expectedRevision: 7 })
  assert.deepEqual(enabled, { ok: true, value: { operation: 'set', present: true, value: true, revision: 8 } })
  assert.equal(fixture.user.allowRemoteSettings, true)
  assert.deepEqual(fixture.calls[0], ['vision-router', [{ op: 'set', path: ['allowRemoteSettings'], value: true }], 7])

  const disabled = await mutateLocalRemoteSettingsPermission(fixture.settings, { operation: 'unset', expectedRevision: 8 })
  assert.deepEqual(disabled, { ok: true, value: { operation: 'unset', present: false, revision: 9 } })
  assert.equal(Object.hasOwn(fixture.user, 'allowRemoteSettings'), false)
})

test('Host mutation surfaces actual rejection instead of rc6 readback mismatch', async () => {
  const fixture = settingsFixture()
  fixture.settings.mutate = async () => { throw new Error('schema rejected allowRemoteSettings') }
  const rejected = await mutateLocalRemoteSettingsPermission(fixture.settings, { operation: 'set', value: true, expectedRevision: 7 })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'settings-rejected')
  assert.match(rejected.error.message, /schema rejected/)
})

test('bootstrap HTTP endpoint requires loopback, localhost Host and same origin', async () => {
  for (const options of [
    { remoteAddress: '203.0.113.8' },
    { host: 'example.com:3000', origin: 'http://example.com:3000' },
    { origin: 'http://evil.example' },
  ]) {
    const fixture = settingsFixture()
    const res = response()
    await createVisionRouterLocalPermissionHttpHandler(fixture.settings)(request({ operation: 'set', value: true, expectedRevision: 7 }, options), res)
    assert.equal(res.statusCode, 403)
    assert.equal(fixture.calls.length, 0)
  }

  const fixture = settingsFixture()
  const res = response()
  await createVisionRouterLocalPermissionHttpHandler(fixture.settings)(request({ operation: 'set', value: true, expectedRevision: 7 }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).value.value, true)
  assert.equal(fixture.user.allowRemoteSettings, true)
})

test('local permission prelude is ordered after existing live-model prelude', () => {
  const html = '<html><head><script data-vision-router-live-models>/* live */</script></head><body></body></html>'
  const next = injectLocalPermissionClientPrelude(html)
  assert.ok(next.indexOf('data-vision-router-live-models') < next.indexOf('data-vision-router-local-settings-permission'))
  assert.equal(injectLocalPermissionClientPrelude(next), next)
  assert.ok(next.includes(LOCAL_REMOTE_SETTINGS_PERMISSION_PATH))
})

test('client shim normalizes the v1.6.4 stringified toggle while Host storage stays boolean', async () => {
  const loaded = []
  const loader = { load(spec) { loaded.push(spec) } }
  const fetchCalls = []
  let revision = 7
  const context = {
    window: { __ModuleLoader__: loader },
    fetch: async (url, options) => {
      const payload = JSON.parse(options.body)
      fetchCalls.push([url, options, payload])
      revision += 1
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, value: { operation: payload.operation, present: payload.operation === 'set', ...(payload.operation === 'set' ? { value: payload.value } : {}), revision } }
        },
      }
    },
    Proxy, Reflect, Object, Array, WeakMap, TypeError, Error, JSON, Number, console,
  }
  vm.runInNewContext(LOCAL_PERMISSION_CLIENT_PRELUDE, context)

  let appliedCtx
  loader.load({ id: 'dsh-vision-router', factory() { return { apply(ctx) { appliedCtx = ctx } } } })
  const exports = loaded[0].factory(() => undefined)
  const snapshot = { status: 'ready', writable: true, mode: 'host', revision: 7, value: { allowRemoteSettings: false, routing: false }, user: {} }
  const normalWrites = []
  let loads = 0
  const rawScope = {
    getSnapshot() { return snapshot },
    async load() { loads += 1 },
    async set(field, value) { normalWrites.push(['set', field, value]); snapshot.user[field] = value },
    async unset(field) { normalWrites.push(['unset', field]); delete snapshot.user[field] },
  }
  exports.apply({ settingsScope: { bind() { return rawScope } } })
  const scope = appliedCtx.settingsScope.bind({ namespace: 'vision-router' })

  // v1.6.4's generic parser turns the checkbox draft true into the string "true".
  await scope.set('allowRemoteSettings', 'true')
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0][0], LOCAL_REMOTE_SETTINGS_PERMISSION_PATH)
  assert.equal(fetchCalls[0][2].value, true, 'Host endpoint must receive a real boolean')
  assert.equal(normalWrites.length, 0)
  assert.equal(loads, 1)
  assert.equal(scope.getSnapshot().user.allowRemoteSettings, 'true', 'client readback must match the stringified save plan')
  assert.equal(scope.getSnapshot().value.allowRemoteSettings, 'true', 'legacy formatter must render the enabled checkbox as checked')

  await scope.set('allowRemoteSettings', 'false')
  assert.equal(fetchCalls.length, 2)
  assert.equal(fetchCalls[1][2].value, false, 'Host endpoint must receive boolean false')
  assert.equal(scope.getSnapshot().user.allowRemoteSettings, 'false', 'readback must match the stringified false save plan')
  assert.equal(scope.getSnapshot().value.allowRemoteSettings, '', 'legacy formatter must render false as unchecked')

  await scope.set('routing', true)
  assert.deepEqual(normalWrites, [['set', 'routing', true]])

  snapshot.mode = 'remote'
  await scope.set('allowRemoteSettings', false)
  assert.equal(fetchCalls.length, 2)
  assert.deepEqual(normalWrites.at(-1), ['set', 'allowRemoteSettings', false])
})
