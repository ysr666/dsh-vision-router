import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REMOTE_SETTINGS_CHANNEL,
  REMOTE_SETTINGS_PERMISSION,
  REMOTE_SETTINGS_READABLE_FIELDS,
  createVisionRouterRemoteSettingsHandler,
  installVisionRouterRemoteSettingsBridge,
} from '../lib/remote-settings-bridge.js'

function makeSettings({ enabled = true, revision = 7, writable = true, registered = true } = {}) {
  const resolved = {
    [REMOTE_SETTINGS_PERMISSION]: enabled,
    providers: [{ provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: [] }],
    routing: false,
    proxy: 'http://127.0.0.1:1080',
    proxyHosts: ['secret.internal'],
    artifactsDir: '../../escape',
    desktopScreenshot: true,
    httpProviders: [{ name: 'evil', baseURL: 'https://attacker.invalid/v1', model: 'x', apiKeyEnv: 'OPENAI_API_KEY' }],
    localOllama: { enabled: true, baseURL: 'http://10.0.0.2:11434/v1', model: 'private' },
    localLmStudio: { enabled: true, baseURL: 'http://10.0.0.3:1234/v1', model: 'private' },
    stealth: true,
    wrapperRoute: 'secret-route',
    chainRoute: 'secret-chain',
  }
  const user = { [REMOTE_SETTINGS_PERMISSION]: enabled, routing: false, proxy: resolved.proxy }
  const calls = []
  const settings = {
    writable,
    get(ns) { assert.equal(ns, 'vision-router'); return registered ? resolved : undefined },
    describe(options) {
      calls.push(['describe', options])
      if (!registered) return []
      return [{
        ns: 'vision-router', value: structuredClone(resolved),
        base: { [REMOTE_SETTINGS_PERMISSION]: false, routing: false, proxy: '' },
        user: structuredClone(user), revision, applies: 'live', secrets: [],
      }]
    },
    async mutate(ns, ops, expectedRevision) {
      calls.push(['mutate', ns, structuredClone(ops), expectedRevision])
      assert.equal(ns, 'vision-router')
      assert.equal(expectedRevision, revision)
      const op = ops[0]
      if (op.op === 'set') { resolved[op.path[0]] = structuredClone(op.value); user[op.path[0]] = structuredClone(op.value) }
      else delete user[op.path[0]]
    },
  }
  return { settings, calls, resolved, user }
}

test('remote describe distinguishes disabled, initializing, and read-only states', async () => {
  const disabled = await createVisionRouterRemoteSettingsHandler(makeSettings({ enabled: false }).settings)('describe', {})
  assert.deepEqual(disabled.value, { enabled: false, reason: 'permission-disabled', writable: false })
  const initializing = await createVisionRouterRemoteSettingsHandler(makeSettings({ registered: false }).settings)('describe', {})
  assert.deepEqual(initializing.value, { enabled: false, reason: 'namespace-unavailable', writable: false })
  const readOnly = await createVisionRouterRemoteSettingsHandler(makeSettings({ writable: false }).settings)('describe', {})
  assert.equal(readOnly.value.enabled, true)
  assert.equal(readOnly.value.writable, false)
})

test('remote describe projects only the explicit safe capability allow-list', async () => {
  const { settings } = makeSettings()
  const result = await createVisionRouterRemoteSettingsHandler(settings)('describe', {})
  assert.equal(result.ok, true)
  assert.equal(result.value.writable, true)
  assert.equal(result.value.view.value.routing, false)
  for (const field of ['proxy', 'proxyHosts', 'artifactsDir', 'desktopScreenshot', 'httpProviders', 'localOllama', 'localLmStudio', 'stealth', 'wrapperRoute', 'chainRoute', REMOTE_SETTINGS_PERMISSION]) {
    assert.equal(Object.hasOwn(result.value.view.value, field), false, field)
    assert.equal(Object.hasOwn(result.value.view.user ?? {}, field), false, field)
  }
  assert.equal(REMOTE_SETTINGS_READABLE_FIELDS.includes('routing'), true)
})

test('remote mutation allows safe fields and returns authoritative readback', async () => {
  const { settings, calls } = makeSettings()
  const result = await createVisionRouterRemoteSettingsHandler(settings)('mutate', {
    ops: [{ op: 'set', path: ['routing'], value: true }], expectedRevision: 7,
  })
  assert.equal(result.ok, true)
  assert.equal(result.value.view.value.routing, true)
  assert.equal(calls.filter((entry) => entry[0] === 'mutate').length, 1)
})

test('host/network/privacy/credential-bearing fields are always local-only remotely', async () => {
  const denied = [
    REMOTE_SETTINGS_PERMISSION, 'proxy', 'proxyHosts', 'artifactsDir', 'desktopScreenshot',
    'httpProviders', 'localOllama', 'localLmStudio', 'stealth', 'wrapperRoute', 'chainRoute',
  ]
  for (const field of denied) {
    const { settings, calls } = makeSettings()
    const result = await createVisionRouterRemoteSettingsHandler(settings)('mutate', {
      ops: [{ op: 'set', path: [field], value: field === 'desktopScreenshot' ? true : 'evil' }], expectedRevision: 7,
    })
    assert.equal(result.ok, false, field)
    assert.equal(result.error.code, 'bad-request', field)
    assert.equal(calls.some((entry) => entry[0] === 'mutate'), false, field)
  }
})

test('remote mutation rejects nested, unknown and prototype-polluting paths', async () => {
  for (const path of [['routing', 'nested'], ['doesNotExist'], ['__proto__'], ['constructor']]) {
    const { settings, calls } = makeSettings()
    const result = await createVisionRouterRemoteSettingsHandler(settings)('mutate', {
      ops: [{ op: 'set', path, value: true }], expectedRevision: 7,
    })
    assert.equal(result.ok, false, JSON.stringify(path))
    assert.equal(calls.some((entry) => entry[0] === 'mutate'), false)
  }
})

test('remote mutation requires a revision and preserves conflict revisions', async () => {
  const missing = makeSettings()
  const bad = await createVisionRouterRemoteSettingsHandler(missing.settings)('mutate', {
    ops: [{ op: 'set', path: ['routing'], value: true }],
  })
  assert.equal(bad.error.code, 'bad-request')

  const { settings } = makeSettings()
  settings.mutate = async () => {
    const error = new Error('stale settings revision')
    error.code = 'SETTINGS_CONFLICT'; error.expected = 7; error.actual = 8
    throw error
  }
  const result = await createVisionRouterRemoteSettingsHandler(settings)('mutate', {
    ops: [{ op: 'set', path: ['routing'], value: true }], expectedRevision: 7,
  })
  assert.deepEqual(result.error.details, { ns: 'vision-router', expected: 7, actual: 8 })
})

test('local revocation blocks the next mutation without restart', async () => {
  const { settings, resolved, calls } = makeSettings()
  const handler = createVisionRouterRemoteSettingsHandler(settings)
  assert.equal((await handler('describe', {})).value.enabled, true)
  resolved[REMOTE_SETTINGS_PERMISSION] = false
  calls.length = 0
  const result = await handler('mutate', {
    ops: [{ op: 'set', path: ['routing'], value: true }], expectedRevision: 7,
  })
  assert.equal(result.value.reason, 'permission-disabled')
  assert.equal(calls.some((entry) => entry[0] === 'mutate'), false)
})

test('bridge remains behind the DSH trusted-host carrier fence', () => {
  const registrations = []
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['settings', 'connection'])
      callback({
        settings: makeSettings().settings,
        connection: { rpc: { handle(channel, _handler, options) { registrations.push([channel, options]); return () => {} } } },
        effect(factory) { factory() },
      })
    },
  }
  installVisionRouterRemoteSettingsBridge(ctx)
  assert.deepEqual(registrations, [[REMOTE_SETTINGS_CHANNEL, { authority: 'trusted-host' }]])
})
