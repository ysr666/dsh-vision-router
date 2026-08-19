import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {
  LOCAL_PERMISSION_CLIENT_PRELUDE,
  LOCAL_REMOTE_SETTINGS_PERMISSION_PATH,
  REMOTE_SETTINGS_PERMISSION,
  injectLocalPermissionClientPrelude,
  mutateLocalRemoteSettingsPermission,
} from '../lib/remote-settings-bridge.js'

function settingsFixture() {
  const resolved = { [REMOTE_SETTINGS_PERMISSION]: false, routing: false }
  const user = {}
  let revision = 7
  const calls = []
  const settings = {
    writable: true,
    describe() {
      return [{
        ns: 'vision-router',
        value: structuredClone(resolved),
        base: { [REMOTE_SETTINGS_PERMISSION]: false, routing: false },
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
        resolved[op.path[0]] = structuredClone(op.value)
        user[op.path[0]] = structuredClone(op.value)
      } else {
        delete user[op.path[0]]
        resolved[op.path[0]] = false
      }
      revision += 1
    },
  }
  return { settings, resolved, user, calls, revision: () => revision }
}

test('loopback permission mutation verifies the Host user layer before reporting success', async () => {
  const fixture = settingsFixture()
  const enabled = await mutateLocalRemoteSettingsPermission(fixture.settings, {
    operation: 'set', value: true, expectedRevision: 7,
  })
  assert.equal(enabled.ok, true)
  assert.deepEqual(enabled.value, { operation: 'set', present: true, value: true, revision: 8 })
  assert.equal(fixture.user.allowRemoteSettings, true)
  assert.deepEqual(fixture.calls[0], [
    'vision-router',
    [{ op: 'set', path: ['allowRemoteSettings'], value: true }],
    7,
  ])

  const disabled = await mutateLocalRemoteSettingsPermission(fixture.settings, {
    operation: 'unset', expectedRevision: 8,
  })
  assert.equal(disabled.ok, true)
  assert.deepEqual(disabled.value, { operation: 'unset', present: false, revision: 9 })
  assert.equal(Object.hasOwn(fixture.user, 'allowRemoteSettings'), false)
})

test('loopback permission mutation refuses malformed values and surfaces a real Host rejection', async () => {
  const fixture = settingsFixture()
  const malformed = await mutateLocalRemoteSettingsPermission(fixture.settings, {
    operation: 'set', value: 'yes', expectedRevision: 7,
  })
  assert.equal(malformed.ok, false)
  assert.equal(malformed.error.code, 'bad-request')
  assert.equal(fixture.calls.length, 0)

  fixture.settings.mutate = async () => { throw new Error('schema rejected allowRemoteSettings') }
  const rejected = await mutateLocalRemoteSettingsPermission(fixture.settings, {
    operation: 'set', value: true, expectedRevision: 7,
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'settings-rejected')
  assert.match(rejected.error.message, /schema rejected/)
})

test('local permission prelude is ordered after the existing live-model prelude', () => {
  const html = '<html><head><script data-vision-router-live-models>/* live */</script></head><body></body></html>'
  const next = injectLocalPermissionClientPrelude(html)
  assert.ok(next.indexOf('data-vision-router-live-models') < next.indexOf('data-vision-router-local-settings-permission'))
  assert.equal(injectLocalPermissionClientPrelude(next), next)
  assert.match(next, new RegExp(LOCAL_REMOTE_SETTINGS_PERMISSION_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('client shim bypasses stock rc6 SettingsScope only for the local permission field', async () => {
  const loaded = []
  const loader = { load(spec) { loaded.push(spec) } }
  const fetchCalls = []
  const context = {
    window: { __ModuleLoader__: loader },
    fetch: async (url, options) => {
      fetchCalls.push([url, options])
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, value: { operation: 'set', present: true, value: true, revision: 8 } }
        },
      }
    },
    Proxy,
    Reflect,
    Object,
    Array,
    WeakMap,
    TypeError,
    Error,
    JSON,
    Number,
    console,
  }
  vm.runInNewContext(LOCAL_PERMISSION_CLIENT_PRELUDE, context)

  let appliedCtx
  loader.load({
    id: 'dsh-vision-router',
    factory() {
      return { apply(ctx) { appliedCtx = ctx } }
    },
  })
  assert.equal(loaded.length, 1)
  const exports = loaded[0].factory(() => undefined)

  const snapshot = {
    status: 'ready', writable: true, mode: 'host', revision: 7,
    value: { allowRemoteSettings: false, routing: false }, user: {},
  }
  const normalWrites = []
  let loads = 0
  const rawScope = {
    getSnapshot() { return snapshot },
    async load() { loads += 1 },
    async set(field, value) { normalWrites.push(['set', field, value]); snapshot.user[field] = value },
    async unset(field) { normalWrites.push(['unset', field]); delete snapshot.user[field] },
  }
  const rawBinder = { bind(spec) { assert.equal(spec.namespace, 'vision-router'); return rawScope } }
  exports.apply({ settingsScope: rawBinder })
  const scope = appliedCtx.settingsScope.bind({ namespace: 'vision-router' })

  await scope.set('allowRemoteSettings', true)
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0][0], LOCAL_REMOTE_SETTINGS_PERMISSION_PATH)
  assert.equal(normalWrites.length, 0)
  assert.equal(loads, 1)
  assert.equal(scope.getSnapshot().user.allowRemoteSettings, true)

  await scope.set('routing', true)
  assert.deepEqual(normalWrites, [['set', 'routing', true]])

  snapshot.mode = 'remote'
  await scope.set('allowRemoteSettings', false)
  assert.equal(fetchCalls.length, 1, 'remote scopes must never use the local elevation path')
  assert.deepEqual(normalWrites.at(-1), ['set', 'allowRemoteSettings', false])
})
