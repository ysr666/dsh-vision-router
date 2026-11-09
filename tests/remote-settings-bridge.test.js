import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REMOTE_SETTINGS_CHANNEL,
  REMOTE_SETTINGS_PERMISSION,
  registerVisionRouterRemoteSettingsChannel,
  createVisionRouterRemoteSettingsHandler,
  installVisionRouterRemoteSettingsBridge,
} from '../lib/remote-settings-bridge.js'

function makeSettings({ enabled = true, revision = 7, writable = true, registered = true } = {}) {
  const resolved = {
    [REMOTE_SETTINGS_PERMISSION]: enabled,
    providers: [{ provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: [] }],
    routing: false,
    visionDepth: 'standard',
    localOnlyVision: false,
    visionDepthMaxCalls: 0,
    visionTurnBudgetMs: 120000,
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
        base: { [REMOTE_SETTINGS_PERMISSION]: false, routing: false, visionDepth: 'standard', visionDepthMaxCalls: 0, visionTurnBudgetMs: 120000, proxy: '' },
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

test('authenticated remote describe exposes the complete Host-owned settings namespace without the permission control', async () => {
  const { settings, calls } = makeSettings()
  const result = await createVisionRouterRemoteSettingsHandler(settings)('describe', {})
  assert.equal(result.ok, true)
  assert.equal(result.value.writable, true)
  assert.equal(result.value.view.value.routing, false)
  for (const field of [
    'proxy', 'proxyHosts', 'artifactsDir', 'desktopScreenshot',
    'httpProviders', 'localOllama', 'localLmStudio', 'stealth', 'wrapperRoute',
    'chainRoute', 'visionDepthMaxCalls', 'visionTurnBudgetMs',
  ]) {
    assert.equal(Object.hasOwn(result.value.view.value, field), true, field)
  }
  assert.equal(result.value.view.value.localOllama.baseURL, 'http://10.0.0.2:11434/v1')
  assert.equal(Object.hasOwn(result.value.view.value, REMOTE_SETTINGS_PERMISSION), false)
  assert.deepEqual(calls[0], ['describe', { redactSecrets: true }])
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

test('remote mutation keeps custom depth, cap and turn budget on the same safe settings surface', async () => {
  const { settings } = makeSettings()
  const handler = createVisionRouterRemoteSettingsHandler(settings)
  const depth = await handler('mutate', {
    ops: [{ op: 'set', path: ['visionDepth'], value: 'custom' }], expectedRevision: 7,
  })
  assert.equal(depth.ok, true)
  assert.equal(depth.value.view.value.visionDepth, 'custom')
  const cap = await handler('mutate', {
    ops: [{ op: 'set', path: ['visionDepthMaxCalls'], value: 6 }], expectedRevision: 7,
  })
  assert.equal(cap.ok, true)
  assert.equal(cap.value.view.value.visionDepthMaxCalls, 6)
  const budget = await handler('mutate', {
    ops: [{ op: 'set', path: ['visionTurnBudgetMs'], value: 180000 }], expectedRevision: 7,
  })
  assert.equal(budget.ok, true)
  assert.equal(budget.value.view.value.visionTurnBudgetMs, 180000)
})

test('after opt-in, every ordinary Host schema field may be edited remotely', async () => {
  for (const [field, value] of [
    ['proxy', 'http://127.0.0.1:1080'],
    ['proxyHosts', ['localhost']],
    ['artifactsDir', '.dsh-vision-router/artifacts'],
    ['desktopScreenshot', false],
    ['httpProviders', [{ name: 'x', baseURL: 'https://example.org/v1', model: 'vision', apiKeyEnv: 'OPENAI_API_KEY' }]],
    ['localOllama', { enabled: true, baseURL: 'http://127.0.0.1:11434/v1', model: 'vision' }],
    ['localLmStudio', { enabled: true, baseURL: 'http://localhost:1234/v1', model: 'vision' }],
    ['stealth', false],
    ['wrapperRoute', 'dvr-twin'],
    ['chainRoute', 'dvr-chain'],
    ['localOnlyVision', true],
  ]) {
    const { settings, calls } = makeSettings()
    // A future Settings schema may add fields; admission is based on the
    // described Host namespace, not a DVR-maintained browser allow-list.
    const result = await createVisionRouterRemoteSettingsHandler(settings)('mutate', {
      ops: [{ op: 'set', path: [field], value }], expectedRevision: 7,
    })
    assert.equal(result.ok, true, field)
    assert.equal(calls.filter((entry) => entry[0] === 'mutate').length, 1, field)
    assert.deepEqual(result.value.view.value[field], value, field)
  }
})

function syntheticCredential(...parts) {
  // Runtime-only test fixture: never place a credential-shaped literal in
  // source, including a URL with userinfo or an API-key-shaped string.
  return parts.join('-')
}

function proxyUrlWithSyntheticCredentials(host, username, password, token) {
  const url = new URL('http://' + host + ':1080')
  url.username = username
  url.password = password
  if (token) url.searchParams.set('token', token)
  return url.toString()
}

test('remote settings redact stored URL credentials and nested secret-shaped fields', async () => {
  const { settings, resolved } = makeSettings()
  const password = syntheticCredential('fixture', 'password', 'one')
  const queryToken = syntheticCredential('fixture', 'query', 'token')
  const nestedSecret = syntheticCredential('fixture', 'nested', 'credential')
  resolved.proxy = proxyUrlWithSyntheticCredentials('127.0.0.1', 'synthetic-user', password, queryToken)
  resolved.httpProviders[0].apiKey = nestedSecret
  resolved.httpProviders[0].apiKeyEnv = 'OPENAI_API_KEY'
  const handler = createVisionRouterRemoteSettingsHandler(settings)
  const described = await handler('describe', {})
  const view = described.value.view.value
  assert.equal(JSON.stringify(described).includes(password), false)
  assert.equal(JSON.stringify(described).includes(queryToken), false)
  assert.equal(JSON.stringify(described).includes(nestedSecret), false)
  assert.equal(view.httpProviders[0].apiKeyEnv, 'OPENAI_API_KEY')
  assert.match(view.proxy, /REDACTED/)
})

test('a secret-bearing remote write validates authoritative readback without disclosing the old value', async () => {
  const { settings, resolved } = makeSettings()
  const previouslyStored = syntheticCredential('fixture', 'old', 'password')
  const justEntered = syntheticCredential('fixture', 'new', 'password')
  resolved.proxy = proxyUrlWithSyntheticCredentials('127.0.0.1', 'previous', previouslyStored)
  const handler = createVisionRouterRemoteSettingsHandler(settings)
  const requested = proxyUrlWithSyntheticCredentials('localhost', 'incoming', justEntered)
  const written = await handler('mutate', {
    ops: [{ op: 'set', path: ['proxy'], value: requested }], expectedRevision: 7,
  })
  assert.equal(written.ok, true)
  assert.equal(written.value.view.value.proxy, requested, 'only the value supplied by this caller may be echoed after verified persistence')
  const reloaded = await handler('describe', {})
  assert.equal(reloaded.value.view.value.proxy.includes(justEntered), false)
  assert.equal(reloaded.value.view.value.proxy.includes('REDACTED'), true)
  assert.equal(JSON.stringify(reloaded).includes(previouslyStored), false)
})

test('remote risk acknowledgement never grants an unauthenticated settings mutation by itself', async () => {
  const { settings, calls } = makeSettings({ enabled: false })
  const handler = createVisionRouterRemoteSettingsHandler(settings)
  const refused = await handler('mutate', { ops: [{ op: 'set', path: ['proxy'], value: 'http://x' }], expectedRevision: 7 })
  assert.equal(refused.value.reason, 'permission-disabled')
  assert.equal(calls.filter((entry) => entry[0] === 'mutate').length, 0)
  const special = await handler('mutate', { ops: [{ op: 'set', path: [REMOTE_SETTINGS_PERMISSION], value: true }], expectedRevision: 7 })
  assert.equal(special.value.reason, 'permission-disabled')
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


test('remote settings RPC registration follows the active DSH Connection trust contract', () => {
  const handler = async () => ({ ok: true, value: null })
  const legacyCalls = []
  const legacyDispose = registerVisionRouterRemoteSettingsChannel({
    rpc: {
      handle(...args) {
        legacyCalls.push(args)
        return 'legacy-dispose'
      },
    },
  }, handler)
  assert.equal(legacyDispose, 'legacy-dispose')
  assert.equal(legacyCalls.length, 1)
  assert.equal(legacyCalls[0].length, 3)
  assert.equal(legacyCalls[0][0], REMOTE_SETTINGS_CHANNEL)
  assert.equal(legacyCalls[0][1], handler)
  assert.deepEqual(legacyCalls[0][2], { authority: 'trusted-host' })

  const modernCalls = []
  const modernDispose = registerVisionRouterRemoteSettingsChannel({
    requestRejection() { return undefined },
    rpc: {
      handle(...args) {
        modernCalls.push(args)
        assert.equal(args.length, 2, 'modern Connection handle must not receive obsolete authority options')
        return 'modern-dispose'
      },
    },
  }, handler)
  assert.equal(modernDispose, 'modern-dispose')
  assert.deepEqual(modernCalls, [[REMOTE_SETTINGS_CHANNEL, handler]])
})

test('remote settings RPC registration rejects a missing Connection handle loudly', () => {
  assert.throws(
    () => registerVisionRouterRemoteSettingsChannel({ requestRejection() {} }, async () => ({ ok: true, value: null })),
    /requires DSH Connection RPC handle/,
  )
})

test('bridge remains behind the DSH trusted-host carrier fence', () => {
  const registrations = []
  const indexTaps = []
  const ctx = {
    inject(deps, callback) {
      if (deps[0] === 'settings' && deps[1] === 'connection') {
        // The caller still declares every service it directly consumes. The
        // DSH Connection provider's own webServer activation is a separate
        // bundle contract; do not fake Cordis Service shadow semantics here.
        assert.deepEqual(deps, ['settings', 'connection', 'webServer'])
        callback({
          settings: makeSettings().settings,
          webServer: { register() { return () => {} } },
          connection: {
            rpc: {
              handle(channel, _handler, options) {
                registrations.push([channel, options])
                return () => {}
              },
            },
          },
          effect(factory) { factory() },
        })
        return
      }
      if (deps.length === 1 && deps[0] === 'webServer') {
        callback({
          webServer: { tapIndex(transform) { indexTaps.push(transform); return () => {} } },
          effect(factory) { factory() },
        })
        return
      }
      assert.fail(`unexpected injection: ${JSON.stringify(deps)}`)
    },
  }
  installVisionRouterRemoteSettingsBridge(ctx)
  assert.deepEqual(registrations, [[REMOTE_SETTINGS_CHANNEL, { authority: 'trusted-host' }]])

  const sample = '<html><head></head><body></body></html>'
  const rendered = indexTaps.map((transform) => transform(sample))
  assert.equal(
    rendered.some((html) => html.includes('data-vision-router-remote-settings-risk-confirmation')),
    true,
    'remote risk confirmation prelude is installed',
  )
  assert.equal(
    rendered.some((html) => html.includes('data-vision-router-settings-ia')),
    true,
    'the consolidated settings IA prelude is installed',
  )
  assert.equal(
    rendered.some((html) => html.includes('data-vision-router-turn-budget')),
    false,
    'whole-turn budget no longer owns a duplicate presentation prelude',
  )
})
