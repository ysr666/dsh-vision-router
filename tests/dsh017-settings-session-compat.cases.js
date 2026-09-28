import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DSH_017_SETTINGS_COMPAT_MARK,
  LOCAL_SETTINGS_PATH,
  installDsh017LocalSettingsTransport,
  installDsh017SettingsCompatibility,
} from '../lib/dsh-settings-017-compat.js'
import {
  SETTINGS_017_CLIENT_PRELUDE,
  injectSettings017ClientPrelude,
} from '../lib/settings-client-017-compat.js'
import {
  installVisionRouterMessageSourceBoundary,
  visionRouterMessageSource,
} from '../lib/session-message-source-compat.js'
import {
  WEB_ROUTE_REMOTE_CAPABILITY,
  webRouteRemoteCapability,
} from '../lib/web-capability-boundary.js'

let profileFixtureId = 0

function make017SettingsHarness({ traceableEditorViews = false } = {}) {
  const inherited = {
    routing: false,
    allowRemoteSettings: false,
    nested: { stable: true },
  }
  const baseConfig = {
    routing: false,
    allowRemoteSettings: false,
    tool: true,
    nested: { stable: true },
  }
  const entry = {
    options: {
      id: 'vision-router',
      config: structuredClone({ ...inherited, allowRemoteSettings: true }),
    },
  }
  const nativeSettings = { describe() { return [] } }
  let editor
  let editorListener
  let watchCalls = 0
  let configurationCalls = 0
  const editorView = () => {
    if (!editor || !traceableEditorViews) return editor
    return new Proxy(editor, {
      get(target, property, receiver) {
        if (property === Symbol.for('cordis.original')) return target
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  const ctx = {
    get(name) {
      if (name === 'settings') return nativeSettings
      if (name === 'configEditor') return editorView()
      return undefined
    },
    inject(dependencies, callback) {
      if (dependencies.length === 1 && dependencies[0] === 'configEditor') {
        editorListener = callback
        if (editor) callback({ configEditor: editorView() })
        return () => {}
      }
      callback(this)
      return () => {}
    },
  }
  const wrapped = installDsh017SettingsCompatibility(ctx, baseConfig)

  function mountEditor() {
    editor = {
      documentPath: `/tmp/dvr-settings-017-${++profileFixtureId}.yml`,
      configuration() {
        configurationCalls += 1
        return [{ entry, inherited: structuredClone(inherited), override: {} }]
      },
      async edit(received, change) {
        assert.equal(received, entry)
        entry.options.config = change(
          structuredClone(entry.options.config),
          structuredClone(inherited),
        )
      },
    }
    editorListener({ configEditor: editorView() })
    const settings = wrapped.get('settings')
    const scope = settings.register('vision-router')
    scope.watch(() => { watchCalls += 1 })
    return { settings, scope }
  }

  function reloadCompatibility() {
    return installDsh017SettingsCompatibility(ctx, baseConfig).get('settings')
  }

  return {
    ctx,
    wrapped,
    nativeSettings,
    entry,
    mountEditor,
    reloadCompatibility,
    watchCalls: () => watchCalls,
    configurationCalls: () => configurationCalls,
  }
}

test('DSH 0.1.7 settings compatibility snapshots repeated reads and refreshes at write boundaries', async () => {
  const harness = make017SettingsHarness()
  const { settings, scope } = harness.mountEditor()

  const first = scope.get()
  first.routing = true
  for (let index = 0; index < 1_000; index += 1) {
    assert.equal(scope.get().routing, false, 'callers cannot mutate the cached settings snapshot')
  }
  assert.equal(settings.writable, true)
  assert.equal(settings.describe()[0].value.routing, false)
  assert.equal(harness.configurationCalls(), 1, 'read amplification must not recompose the Host profile')

  const revision = settings.describe()[0].revision
  await settings.mutate(
    'vision-router',
    [{ op: 'set', path: ['routing'], value: true }],
    revision,
  )
  assert.equal(scope.get().routing, true)
  assert.equal(harness.configurationCalls(), 3, 'a write refreshes before and after ConfigEditor.edit()')
})

test('DSH 0.1.7 settings compatibility shares one snapshot and write queue across Cordis service proxy views', async () => {
  const harness = make017SettingsHarness({ traceableEditorViews: true })
  const { settings: first, scope } = harness.mountEditor()

  assert.equal(scope.get().routing, false)
  const second = harness.wrapped.get('settings')
  assert.notEqual(second, first, 'distinct Cordis traceable views may still produce distinct facades')
  for (let index = 0; index < 100; index += 1) {
    assert.equal(harness.wrapped.get('settings').get('vision-router').routing, false)
  }
  assert.equal(harness.configurationCalls(), 1, 'proxy churn must not rebuild the complete Host profile')

  const revision = first.describe()[0].revision
  const results = await Promise.allSettled([
    first.mutate('vision-router', [{ op: 'set', path: ['routing'], value: true }], revision),
    second.mutate('vision-router', [{ op: 'set', path: ['tool'], value: false }], revision),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  const rejected = results.find((result) => result.status === 'rejected')
  assert.equal(rejected?.reason?.code, 'SETTINGS_CONFLICT')
  assert.equal(harness.configurationCalls(), 4, 'shared write queue refreshes once before/after the winner and once for the loser conflict')
})

test('DSH 0.1.7 compatibility serializes concurrent writes against one revision', async () => {
  const harness = make017SettingsHarness()
  const { settings } = harness.mountEditor()
  const revision = settings.describe()[0].revision
  const results = await Promise.allSettled([
    settings.mutate('vision-router', [{ op: 'set', path: ['routing'], value: true }], revision),
    settings.mutate('vision-router', [{ op: 'set', path: ['tool'], value: false }], revision),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const rejected = results.find((result) => result.status === 'rejected')
  assert.equal(rejected?.reason?.code, 'SETTINGS_CONFLICT')
})

test('DSH 0.1.7 settings compatibility activates only after ConfigEditor mounts and persists through edit()', async () => {
  const harness = make017SettingsHarness()
  assert.equal(harness.wrapped.get('settings'), harness.nativeSettings, 'pre-mount settings stays host-native')

  const { settings, scope } = harness.mountEditor()
  assert.equal(settings[DSH_017_SETTINGS_COMPAT_MARK], true)
  assert.equal(typeof settings.register, 'function')
  assert.equal(scope.get().routing, false)
  assert.equal(scope.get().tool, true)

  const initial = settings.describe()[0]
  assert.equal(Number.isSafeInteger(initial.revision), true)
  assert.ok(initial.revision >= 0)
  assert.deepEqual(initial.user, { allowRemoteSettings: true })

  await settings.mutate(
    'vision-router',
    [{ op: 'set', path: ['routing'], value: true }],
    initial.revision,
  )
  const changed = settings.describe()[0]
  assert.notEqual(changed.revision, initial.revision)
  assert.equal(changed.value.routing, true)
  assert.equal(changed.user.routing, true)
  assert.equal(harness.entry.options.config.routing, true)
  assert.equal(harness.watchCalls(), 1)

  // Ordinary Config edits HMR DVR. A newly-created compatibility facade must
  // inherit the same process-level revision rather than resetting to zero.
  const afterHmr = harness.reloadCompatibility().describe()[0]
  assert.equal(afterHmr.revision, changed.revision)
  assert.equal(afterHmr.value.routing, true)

  await assert.rejects(
    () => settings.mutate(
      'vision-router',
      [{ op: 'set', path: ['routing'], value: false }],
      initial.revision,
    ),
    (error) => error?.code === 'SETTINGS_CONFLICT'
      && error.expected === initial.revision
      && error.actual === changed.revision,
  )

  await settings.mutate(
    'vision-router',
    [{ op: 'unset', path: ['routing'] }],
    changed.revision,
  )
  const reset = settings.describe()[0]
  assert.ok(reset.revision > changed.revision, 'ABA back to the original config must still advance revision')
  assert.equal(reset.value.routing, false)
  assert.equal(Object.hasOwn(reset.user, 'routing'), false)
  assert.equal(harness.watchCalls(), 2)

  const resetAfterHmr = harness.reloadCompatibility().describe()[0]
  assert.equal(resetAfterHmr.revision, reset.revision)
})

test('legacy SettingsProvider remains owned by the old Host generation', () => {
  const oldSettings = { register() {}, describe() { return [] } }
  const ctx = {
    get(name) { return name === 'settings' ? oldSettings : undefined },
    inject() { return () => {} },
  }
  const wrapped = installDsh017SettingsCompatibility(ctx, {})
  assert.equal(wrapped.get('settings'), oldSettings)
  assert.equal(wrapped.settings, oldSettings)
  assert.equal(oldSettings[DSH_017_SETTINGS_COMPAT_MARK], undefined)
})

test('0.1.7 local settings transport is installed only for the ConfigEditor compatibility facade', () => {
  for (const compatible of [false, true]) {
    const routes = []
    const settings = {
      ...(compatible ? { [DSH_017_SETTINGS_COMPAT_MARK]: true } : {}),
      writable: true,
      describe() { return [] },
      async mutate() {},
    }
    const ctx = {
      inject(dependencies, callback) {
        assert.deepEqual(dependencies, ['settings', 'webServer'])
        callback({
          settings,
          webServer: { register(route) { routes.push(route); return () => {} } },
          effect(factory) { factory() },
        })
      },
    }
    installDsh017LocalSettingsTransport(ctx)
    assert.equal(routes.length, compatible ? 1 : 0)
    if (compatible) assert.equal(routes[0].path, LOCAL_SETTINGS_PATH)
  }
})

test('0.1.7 local settings endpoint inherits the closed-world local-only web capability fence', () => {
  assert.equal(
    webRouteRemoteCapability(LOCAL_SETTINGS_PATH, 'GET'),
    WEB_ROUTE_REMOTE_CAPABILITY.LOCAL_ONLY,
  )
  assert.equal(
    webRouteRemoteCapability(LOCAL_SETTINGS_PATH, 'POST'),
    WEB_ROUTE_REMOTE_CAPABILITY.LOCAL_ONLY,
  )
})

test('0.1.7 browser compatibility prelude is idempotent and targets the local settings transport', () => {
  const input = '<html><head></head><body></body></html>'
  const once = injectSettings017ClientPrelude(input)
  const twice = injectSettings017ClientPrelude(once)
  assert.match(once, /data-vision-router-settings-017-compat/)
  assert.equal(once.includes(LOCAL_SETTINGS_PATH), true)
  assert.equal(twice, once)
  assert.match(SETTINGS_017_CLIENT_PRELUDE, /property === 'settingsScope'/)
  assert.match(SETTINGS_017_CLIENT_PRELUDE, /namespace === 'vision-router'/)
})

test('Vision Router message source follows the Session durable format version without DSH version guessing', () => {
  assert.deepEqual(visionRouterMessageSource({ header: { version: 3 } }), {
    kind: 'plugin', plugin: 'dsh-vision-router',
  })
  assert.deepEqual(visionRouterMessageSource({ header: { version: 4 } }), {
    kind: 'plugin:dsh-vision-router',
  })
  assert.deepEqual(visionRouterMessageSource({ header: { version: 5 } }), {
    kind: 'plugin:dsh-vision-router',
  })
  assert.deepEqual(visionRouterMessageSource({}), {
    kind: 'plugin', plugin: 'dsh-vision-router',
  })
})

test('Session source boundary normalizes final pre-step and post-execute DVR contexts but leaves foreign sources untouched', async () => {
  const handlers = new Map()
  const raw = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => {}
    },
  }
  const wrapped = installVisionRouterMessageSourceBoundary(raw)
  const foreign = { role: 'user', source: { kind: 'plugin', plugin: 'another-plugin' }, content: [] }
  const dvrLegacy = { role: 'user', source: { kind: 'plugin', plugin: 'dsh-vision-router' }, content: [] }
  const dvrV4 = { role: 'user', source: { kind: 'plugin:dsh-vision-router' }, content: [] }

  wrapped.on('agent/pre-step', async () => ({ messages: [dvrLegacy, foreign] }))
  const preStepV4 = await handlers.get('agent/pre-step')({ agent: { session: { header: { version: 4 } } } })
  assert.deepEqual(preStepV4.messages[0].source, { kind: 'plugin:dsh-vision-router' })
  assert.equal(preStepV4.messages[1], foreign)

  wrapped.on('agent/pre-step', () => ({ messages: [dvrV4] }))
  const preStepV3 = handlers.get('agent/pre-step')({ agent: { session: { header: { version: 3 } } } })
  assert.deepEqual(preStepV3.messages[0].source, { kind: 'plugin', plugin: 'dsh-vision-router' })

  wrapped.on('tools/post-execute', async () => ({ kind: 'accept', additionalContexts: [dvrLegacy, foreign] }))
  const postV4 = await handlers.get('tools/post-execute')({ agent: { session: { header: { version: 4 } } } }, {})
  assert.deepEqual(postV4.additionalContexts[0].source, { kind: 'plugin:dsh-vision-router' })
  assert.equal(postV4.additionalContexts[1], foreign)
})
