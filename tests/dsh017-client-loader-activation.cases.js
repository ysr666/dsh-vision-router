import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'

import {
  SETTINGS_017_CLIENT_PRELUDE,
  injectSettings017ClientPrelude,
  installSettings017ClientCompatibility,
} from '../lib/settings-client-017-compat.js'
import { SETTINGS_CONFIG_FORMS_CLIENT_PRELUDE } from '../lib/web/remote-settings-client.js'
import { SETTINGS_RC8_CLIENT_PRELUDE } from '../lib/settings-client-rc8-lifecycle.js'

test('0.1.7 server-side client shim uses the structured injection table for Desktop and HTTP', () => {
  let dependencies
  let event
  let listener
  let taps = 0
  const ctx = {
    inject(received, callback) {
      dependencies = received
      callback({
        on(receivedEvent, receivedListener) {
          event = receivedEvent
          listener = receivedListener
          return () => {}
        },
        effect(factory) { factory() },
        webServer: {
          tapIndex() {
            taps += 1
            return () => {}
          },
        },
      })
      return () => {}
    },
  }

  installSettings017ClientCompatibility(ctx)
  assert.deepEqual(dependencies, ['configEditor', 'webServer'])
  assert.equal(event, 'webserver/index-inject')
  assert.equal(typeof listener, 'function')
  assert.equal(taps, 1, 'served HTML keeps tapIndex as a compatibility carrier')

  const table = []
  listener(table)
  assert.equal(table.length, 1)
  assert.deepEqual(
    { kind: table[0].kind, placement: table[0].placement },
    { kind: 'script', placement: 'head' },
  )
  assert.match(table[0].text, /data-vision-router-settings-017-compat/)
  assert.match(table[0].text, /__visionRouterSettings017Compat/)
  assert.doesNotMatch(table[0].text, /<\/script/i, 'inline structured scripts must not contain a literal closing script tag')

  const rendered = `<html><head><script>${table[0].text}</script></head><body></body></html>`
  assert.equal(
    injectSettings017ClientPrelude(rendered),
    rendered,
    'served HTML must not execute a duplicate prelude after structured rows render',
  )
})

test('0.1.7 server-side client shim keeps tapIndex as a transitional fallback', () => {
  let taps = 0
  const ctx = {
    inject(_received, callback) {
      callback({
        effect(factory) { factory() },
        webServer: {
          tapIndex(transform) {
            assert.equal(typeof transform, 'function')
            taps += 1
            return () => {}
          },
        },
      })
      return () => {}
    },
  }

  installSettings017ClientCompatibility(ctx)
  assert.equal(taps, 1)
})

test('0.1.7 prelude keeps configForms activation but binds DVR through the local ConfigEditor bridge', async () => {
  let loadedSpec
  let fetched = 0
  let requestedNamespace
  const form = {
    getSnapshot() { return { status: 'ready', value: { native: true }, revision: 0, writable: true, mode: 'host' } },
    subscribe() { return () => {} },
  }
  const configForms = {
    get(namespace) {
      requestedNamespace = namespace
      return form
    },
  }
  const loader = {
    mode: 'live',
    load(spec) {
      loadedSpec = spec
      return spec
    },
    create() { return this },
  }
  const window = { __ModuleLoader__: loader }
  const sandbox = {
    window,
    fetch: async () => {
      fetched += 1
      return {
        ok: true,
        async json() {
          return { ok: true, value: { value: { routing: false }, base: {}, user: {}, revision: 0, writable: true } }
        },
      }
    },
  }

  runInNewContext(SETTINGS_017_CLIENT_PRELUDE, sandbox)

  const observed = {}
  loader.load({
    id: 'dsh-vision-router',
    factory: () => ({
      inject: ['settingsScope', 'slots', 'locale', 'sessions', 'remote'],
      apply(ctx) {
        observed.ctx = ctx
        return 'applied'
      },
    }),
  })

  const plugin = loadedSpec.factory(() => undefined)
  assert.deepEqual(
    Array.from(plugin.inject),
    ['configForms', 'slots', 'locale', 'sessions', 'remote'],
  )
  assert.equal(plugin.apply({ configForms }), 'applied')
  assert.equal(typeof observed.ctx.settingsScope.bind, 'function')
  const scope = observed.ctx.settingsScope.bind({ namespace: 'vision-router' })
  assert.notEqual(scope, form, 'DVR must not depend on a native volatile form across the legacy Host window')
  await scope.load()
  assert.equal(scope.getSnapshot().status, 'ready')
  assert.equal(scope.getSnapshot().value.routing, false)
  assert.equal(requestedNamespace, undefined, 'DVR namespace must stay on the compatibility transport')
  assert.ok(fetched >= 1)
})

test('0.1.7 prelude normalizes loopback page authority for lazy Connection reads', () => {
  let loadedSpec
  const connection = { isLoopback: false, rpc: { call() {} } }
  const form = {
    getSnapshot() { return { status: 'ready', value: {}, revision: 0, writable: true, mode: 'host' } },
    subscribe() { return () => {} },
  }
  const configForms = { get() { return form } }
  const services = new Map([
    ['connection', connection],
    ['configForms', configForms],
  ])
  const loader = {
    mode: 'live',
    load(spec) {
      loadedSpec = spec
      return spec
    },
    create() { return this },
  }
  const window = {
    __ModuleLoader__: loader,
    location: { hostname: '127.0.0.1' },
  }
  runInNewContext(SETTINGS_017_CLIENT_PRELUDE, {
    window,
    fetch: async () => { throw new Error('unexpected fetch') },
  })

  const observed = {}
  loader.load({
    id: 'dsh-vision-router',
    factory: () => ({
      inject: ['settingsScope', 'slots', 'locale', 'sessions', 'remote'],
      apply(ctx) {
        observed.connection = ctx.get('connection')
        observed.scope = ctx.settingsScope.bind({ namespace: 'vision-router' })
      },
    }),
  })

  const plugin = loadedSpec.factory(() => undefined)
  plugin.apply({
    configForms,
    get(name) { return services.get(name) },
  })

  assert.equal(connection.isLoopback, false, 'the underlying Host service must remain untouched')
  assert.equal(observed.connection.isLoopback, true, 'the DVR client must honor the loopback page authority')
  assert.equal(observed.connection.rpc, connection.rpc)
  assert.notEqual(observed.scope, form)
  assert.equal(typeof observed.scope.reload, 'function')
})

test('0.1.7 full settings wrapper stack preserves loopback authority and DVR local persistence', async () => {
  let loadedSpec
  let fetched = 0
  let formSets = 0
  let revision = 0
  let stored = {}
  const connection = { isLoopback: false, rpc: { call() {} } }
  const form = {
    getSnapshot() { return { status: 'ready', value: {}, revision: 0, writable: true, mode: 'host' } },
    subscribe() { return () => {} },
    async set() { formSets += 1; return true },
    async unset() { return true },
    async mutate() { return true },
  }
  const configForms = { get() { return form } }
  const loader = {
    mode: 'live',
    load(spec) {
      loadedSpec = spec
      return spec
    },
    create() { return this },
  }
  const window = {
    __ModuleLoader__: loader,
    location: { hostname: '127.0.0.1' },
    confirm() { return false },
    alert() {},
  }
  const sandbox = {
    window,
    fetch: async (_url, options = {}) => {
      fetched += 1
      const method = options.method || 'GET'
      if (method === 'POST') {
        const payload = JSON.parse(options.body)
        for (const op of payload.ops || []) {
          const field = op.path && op.path[0]
          if (!field) continue
          if (op.op === 'set') stored[field] = op.value
          else delete stored[field]
        }
        revision += 1
      }
      return {
        ok: true,
        async json() {
          return { ok: true, value: { value: { ...stored }, base: {}, user: { ...stored }, revision, writable: true } }
        },
      }
    },
    document: { documentElement: { lang: 'en' } },
    navigator: { language: 'en' },
  }

  runInNewContext(SETTINGS_017_CLIENT_PRELUDE, sandbox)
  runInNewContext(SETTINGS_CONFIG_FORMS_CLIENT_PRELUDE, sandbox)
  runInNewContext(SETTINGS_RC8_CLIENT_PRELUDE, sandbox)
  loader.create()

  const observed = {}
  loader.load({
    id: 'dsh-vision-router',
    factory: () => ({
      inject: ['settingsScope', 'slots', 'locale', 'sessions', 'remote'],
      apply(ctx) {
        observed.connection = ctx.get('connection')
        observed.scope = ctx.settingsScope.bind({ namespace: 'vision-router' })
      },
    }),
  })

  const plugin = loadedSpec.factory(() => undefined)
  assert.deepEqual(
    Array.from(plugin.inject),
    ['configForms', 'slots', 'locale', 'sessions', 'remote'],
  )
  plugin.apply({
    configForms,
    get(name) {
      if (name === 'connection') return connection
      if (name === 'configForms') return configForms
      return undefined
    },
  })

  assert.equal(connection.isLoopback, false)
  assert.equal(observed.connection.isLoopback, true)
  await observed.scope.load()
  assert.equal(observed.scope.getSnapshot().mode, 'host')
  const fetchedBeforeBatch = fetched
  await observed.scope.__visionRouterWritePlan([
    { key: 'structuredVisionBootstrap', run: { value: true } },
    { key: 'visionDepth', run: { value: 'fast' } },
  ])
  assert.equal(fetched, fetchedBeforeBatch + 1, 'one UI save must produce exactly one compatibility POST')
  assert.equal(observed.scope.getSnapshot().value.structuredVisionBootstrap, true)
  assert.equal(observed.scope.getSnapshot().value.visionDepth, 'fast')
  assert.equal(observed.scope.getSnapshot().user.structuredVisionBootstrap, true)
  assert.equal(observed.scope.getSnapshot().user.visionDepth, 'fast')
  assert.equal(formSets, 0, 'DVR writes must not require volatile Config semantics from native configForms')
  assert.ok(fetched >= 2, 'the composed DVR scope must read and write through the local-only bridge')
})

test('0.1.7 prelude restores configForms dependency when another loader shim stripped settingsScope first', () => {
  let loadedSpec
  const loader = {
    mode: 'live',
    load(spec) {
      loadedSpec = spec
      return spec
    },
    create() { return this },
  }
  const window = { __ModuleLoader__: loader }
  runInNewContext(SETTINGS_017_CLIENT_PRELUDE, { window, fetch: async () => { throw new Error('unexpected fetch') } })

  loader.load({
    id: 'dsh-vision-router',
    factory: () => ({
      inject: ['slots', 'locale', 'sessions', 'remote'],
      apply() {},
    }),
  })

  const plugin = loadedSpec.factory(() => undefined)
  assert.deepEqual(
    Array.from(plugin.inject),
    ['configForms', 'slots', 'locale', 'sessions', 'remote'],
  )
})
