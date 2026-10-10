import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { injectClientPresentationBoundary } from '../lib/client-presentation-boundary.js'
import { injectVisionModelVisibilityBoundary } from '../lib/vision-model-visibility-boundary.js'
import {
  createVisionToggleRootHardening,
  hardenVisionToggleHtml,
} from '../lib/vision-toggle-root-hardening.js'
import { contextWithVisionRoutingTopologyRefresh } from '../lib/vision-routing-topology-refresh.js'

function fakeHost(config, seeded = []) {
  const registry = new Map(seeded.map(({ route, adapter }) => [route, adapter]))
  const llm = {
    registration(route) {
      if (!registry.has(route)) throw new Error(`no adapter: ${route}`)
      return { adapter: registry.get(route) }
    },
    listProviders() {
      return [...registry].map(([route, adapter]) => {
        try { return adapter.providerInfo(route) } catch { return { id: route, name: route } }
      })
    },
    registerAdapter(routes, adapter) {
      for (const route of routes) {
        if (registry.has(route)) {
          const error = new Error(`duplicate adapter: ${route}`)
          error.code = 'DUPLICATE_ADAPTER'
          throw error
        }
      }
      let held = new Set(routes)
      for (const route of held) registry.set(route, adapter)
      const dispose = () => {
        for (const route of held) registry.delete(route)
        held = new Set()
      }
      dispose.replace = (next) => {
        for (const route of next) {
          if (!held.has(route) && registry.has(route)) {
            const error = new Error(`duplicate adapter: ${route}`)
            error.code = 'DUPLICATE_ADAPTER'
            throw error
          }
        }
        for (const route of held) registry.delete(route)
        held = new Set(next)
        for (const route of held) registry.set(route, adapter)
      }
      return dispose
    },
  }
  const settings = {
    get(namespace) { return namespace === 'vision-router' ? config : undefined },
    register(namespace) {
      return {
        get() { return namespace === 'vision-router' ? config : undefined },
        watch(callback) { callback(namespace === 'vision-router' ? config : undefined); return () => {} },
      }
    },
  }
  const ctx = {
    llm,
    settings,
    get(name) { return name === 'llm' ? llm : name === 'settings' ? settings : undefined },
  }
  return { ctx, registry }
}

test('root hardening makes duplicate wrapper adoption unreachable across base and live settings scopes', () => {
  const config = { wrapperRoute: 'deepseek-vision', chainRoute: 'vision-chain' }
  const spoof = {
    providerInfo(route) { return { id: route, name: 'DeepSeek + 自动识图' } },
  }
  const { ctx } = fakeHost(config, [{ route: 'deepseek-vision', adapter: spoof }])
  const hardening = createVisionToggleRootHardening(ctx, config)

  assert.equal(hardening.config.wrapperRoute, '')
  assert.equal(hardening.ctx.get('settings').get('vision-router').wrapperRoute, '')
  assert.equal(hardening.ctx.settings.register('vision-router').get().wrapperRoute, '')
  assert.equal(hardening.ctx.llm.listProviders().some((entry) => entry.id === 'deepseek-vision'), false)
  assert.equal(hardening.ownership.sourceFor('deepseek-vision'), undefined)

  const twin = {
    providerInfo(route) { return { id: route, name: 'Vendor + 自动识图' } },
  }
  const handle = hardening.ctx.llm.registerAdapter(['vendor-vision'], twin)
  assert.equal(hardening.ownership.sourceFor('vendor-vision'), 'vendor')
  handle()
  assert.equal(hardening.ownership.sourceFor('vendor-vision'), undefined)
})

test('routing projection replays the existing settings reconcile only when a foreign route is released', async () => {
  const config = { wrapperRoute: 'deepseek-vision', chainRoute: 'vision-chain' }
  const spoof = {
    providerInfo(route) { return { id: route, name: 'DeepSeek + 自动识图' } },
  }
  const { ctx, registry } = fakeHost(config, [{ route: 'deepseek-vision', adapter: spoof }])
  const listeners = new Map()
  ctx.on = (name, listener) => {
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name).add(listener)
    return () => listeners.get(name)?.delete(listener)
  }
  const emit = (name) => {
    for (const listener of listeners.get(name) ?? []) listener()
  }

  const hardening = createVisionToggleRootHardening(ctx, config)
  const runtimeCtx = contextWithVisionRoutingTopologyRefresh(hardening.ctx)
  const seen = []
  runtimeCtx.settings.register('vision-router').watch((value) => seen.push(value.wrapperRoute))
  assert.deepEqual(seen, [''])

  // An unrelated topology event while the conflict is unchanged must not
  // replay the settings watcher and cannot create a registration loop.
  emit('llm/adapters-updated')
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(seen, [''])

  registry.delete('deepseek-vision')
  emit('llm/adapters-updated')
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(seen, ['', 'deepseek-vision'])
})

test('root hardening rewrites only the existing #284 seams and removes the official settingsScope hard dependency', () => {
  let html = '<html><head></head><body></body></html>'
  html = injectClientPresentationBoundary(html)
  html = injectVisionModelVisibilityBoundary(html)
  const hardened = hardenVisionToggleHtml(html)

  assert.match(hardened, /result && result !== loader/)
  assert.doesNotMatch(hardened, /plugin\.inject = plugin\.inject\.concat\('settingsScope'\)/)
  assert.match(hardened, /ownership\.sourceFor\(twinProvider\) !== sourceProvider/)
  assert.match(hardened, /ownership\.sourceFor\(wrapperRoute\) !== VISION_MODE_WRAPPER_SOURCE/)
  assert.match(hardened, /ownership\.sourceFor\(target\.id\)/)
  assert.match(hardened, /data-vision-router-root-ownership/)
  assert.match(hardened, /raw\.status === 'selecting' \|\| raw\.status === 'loading'/)
})

function scriptsOfInjectedFixture(html) {
  const scripts = []
  let cursor = 0
  while (cursor < html.length) {
    const open = html.indexOf('<script', cursor)
    if (open === -1) break
    const body = html.indexOf('>', open + '<script'.length)
    const close = body === -1 ? -1 : html.indexOf('</script>', body + 1)
    assert.notEqual(body, -1, 'generated fixture script tag must have an opening delimiter')
    assert.notEqual(close, -1, 'generated fixture script tag must have a closing delimiter')
    scripts.push(html.slice(body + 1, close))
    cursor = close + '</script>'.length
  }
  return scripts
}

test('root hardening patches a loader returned from create and every later global loader replacement', () => {
  let registered
  const returned = { load(spec) { registered = spec; return spec } }
  const initial = {
    load(spec) { registered = spec; return spec },
    create() { return returned },
  }
  const window = { __ModuleLoader__: initial, fetch: async () => ({ ok: true, json: async () => ({ revision: 0, routes: [] }) }) }
  let html = injectVisionModelVisibilityBoundary('<html><head></head></html>')
  html = hardenVisionToggleHtml(html)
  const context = {
    window,
    Object,
    Promise,
    Array,
    String,
    Map,
    Set,
    WeakMap,
    Proxy,
    Reflect,
    JSON,
    Date,
    Number,
    Error,
    console,
  }
  for (const source of scriptsOfInjectedFixture(html)) vm.runInNewContext(source, context)

  const created = initial.create()
  assert.equal(created, returned)
  assert.equal(returned.load.__visionRouterModelVisibility, true)

  const replacement = { load(spec) { registered = spec; return spec } }
  window.__ModuleLoader__ = replacement
  assert.equal(replacement.load.__visionRouterModelVisibility, true)
})

test('resolved Host RemoteResult failures remain failures and populate recovery diagnostics', async () => {
  const window = { fetch: async () => ({ ok: true, json: async () => ({ revision: 0, routes: [] }) }) }
  const html = hardenVisionToggleHtml('<html><head></head></html>')
  const source = scriptsOfInjectedFixture(html).find((script) => script.includes('__dshVisionRouterRootHardening'))
  assert.ok(source)
  vm.runInNewContext(source, {
    window,
    Object,
    Promise,
    Array,
    String,
    Map,
    Set,
    WeakMap,
    JSON,
    Date,
    Number,
    Error,
  })
  const api = window.__dshVisionRouterRootHardening
  let shouldFail = true
  const directory = {
    select() {
      return shouldFail
        ? Promise.resolve({
            ok: false,
            error: { code: 'session/writer-held', message: 'Another writer temporarily owns this session.' },
          })
        : Promise.resolve({ ok: true, value: undefined })
    },
  }
  const selection = { provider: 'vendor-vision', model: 'm' }

  const rejected = await api.select(directory, selection)
  assert.equal(rejected.ok, false)
  assert.match(api.recoveryFor(directory).getSnapshot().message, /session\/writer-held: Another writer/)

  shouldFail = false
  const accepted = await api.select(directory, selection)
  assert.equal(accepted.ok, true)
  assert.equal(api.recoveryFor(directory).getSnapshot(), null)
})

test('stale selection completions never overwrite the newest recovery state', async () => {
  const window = { fetch: async () => ({ ok: true, json: async () => ({ revision: 0, routes: [] }) }) }
  const html = hardenVisionToggleHtml('<html><head></head></html>')
  const source = scriptsOfInjectedFixture(html).find((script) => script.includes('__dshVisionRouterRootHardening'))
  assert.ok(source)
  vm.runInNewContext(source, {
    window,
    Object,
    Promise,
    Array,
    String,
    Map,
    Set,
    WeakMap,
    JSON,
    Date,
    Number,
    Error,
  })
  const api = window.__dshVisionRouterRootHardening

  const pending = []
  const directory = {
    select(selection) {
      return new Promise((resolve) => pending.push({ selection, resolve }))
    },
  }
  const old = api.select(directory, { provider: 'p', model: 'on' })
  const newest = api.select(directory, { provider: 'p', model: 'off' })
  await Promise.resolve()
  assert.equal(pending.length, 2)

  pending[1].resolve({ ok: true, value: undefined })
  await newest
  assert.equal(api.recoveryFor(directory).getSnapshot(), null)

  pending[0].resolve({ ok: false, error: { code: 'stale', message: 'old failure' } })
  const oldResult = await old
  assert.equal(oldResult.ok, false)
  assert.equal(api.recoveryFor(directory).getSnapshot(), null)

  const pending2 = []
  const directory2 = {
    select(selection) {
      return new Promise((resolve) => pending2.push({ selection, resolve }))
    },
  }
  const oldSuccess = api.select(directory2, { provider: 'p', model: 'on' })
  const newFailure = api.select(directory2, { provider: 'p', model: 'off' })
  await Promise.resolve()

  pending2[1].resolve({ ok: false, error: { code: 'latest', message: 'new failure' } })
  await newFailure
  assert.match(api.recoveryFor(directory2).getSnapshot().message, /latest: new failure/)

  pending2[0].resolve({ ok: true, value: undefined })
  await oldSuccess
  assert.match(api.recoveryFor(directory2).getSnapshot().message, /latest: new failure/)
})

test('selection transport rejection is recoverable without mutating the Host directory store and identical double-clicks coalesce', async () => {
  const window = { fetch: async () => ({ ok: true, json: async () => ({ revision: 0, routes: [] }) }) }
  const html = hardenVisionToggleHtml('<html><head></head></html>')
  const source = scriptsOfInjectedFixture(html).find((script) => script.includes('__dshVisionRouterRootHardening'))
  assert.ok(source)
  vm.runInNewContext(source, {
    window,
    Object,
    Promise,
    Array,
    String,
    Map,
    Set,
    WeakMap,
    JSON,
    Date,
    Number,
    Error,
  })
  const api = window.__dshVisionRouterRootHardening
  let calls = 0
  let shouldFail = true
  const directory = {
    store: { getSnapshot() { return { status: 'selecting', error: null } } },
    select() {
      calls += 1
      return shouldFail ? Promise.reject(new Error('connection reset')) : Promise.resolve()
    },
  }
  const selection = { provider: 'vendor-vision', model: 'm' }
  const first = api.select(directory, selection)
  const second = api.select(directory, selection)
  assert.equal(first, second)
  await assert.rejects(first, /connection reset/)
  assert.equal(calls, 1)
  assert.match(api.recoveryFor(directory).getSnapshot().message, /connection reset/)
  assert.equal(directory.store.getSnapshot().status, 'selecting')

  shouldFail = false
  await api.select(directory, selection)
  assert.equal(calls, 2)
  assert.equal(api.recoveryFor(directory).getSnapshot(), null)
})


test('issue #684 rejected selection reporter survives current Client source without bound recovery variables', () => {
  // Real alpha.2 Desktop rejection on Windows Node24 used to reach this exact
  // source-rewritten function and throw ReferenceError: recovery is not defined.
  // Other unit fixtures only exercised the independent recovery store API.
  const html = hardenVisionToggleHtml(
    injectClientPresentationBoundary('<html><head></head><body></body></html>'),
  )
  const client = scriptsOfInjectedFixture(html)
    .find((source) => source.includes('function announceRejectedSelection()'))
  assert.ok(client, 'must exercise the actual composed Client script')
  const start = client.indexOf('        function announceRejectedSelection() {')
  const end = client.indexOf('\n\n        var button = React.createElement', start)
  assert.ok(start >= 0 && end > start, 'failed selection reporter must have a parseable boundary')
  const functionSource = client.slice(start, end)
  assert.match(functionSource, /typeof recovery === 'undefined'/)
  assert.doesNotMatch(functionSource, /recoveryError\s*;/)

  const directory = { store: { getSnapshot: () => ({ error: null }) } }
  const captured = []
  const translations = (key, params) =>
    key === 'failedUnknown' ? 'Unknown failure'
      : key === 'failed' ? 'Switch failed: ' + params.message : key
  function run({ hostError, recoveredError, inheritedRecovery } = {}) {
    const store = { getSnapshot: () => ({ error: hostError ?? null }) }
    const window = {
      __dshVisionRouterRootHardening: recoveredError === undefined ? undefined : {
        recoveryFor(candidate) {
          assert.equal(candidate, directory, 'recovery must belong to the same Host ModelDirectory')
          return { getSnapshot: () => new Error(recoveredError) }
        },
      },
    }
    const context = {
      store, window, directory, Number,
      t: translations,
      setToast(update) { captured.push(update(null)) },
      ...(inheritedRecovery ? {
        recovery: { getSnapshot: () => new Error(inheritedRecovery) },
      } : {}),
    }
    assert.doesNotThrow(() => vm.runInNewContext(functionSource + '\nannounceRejectedSelection()', context))
    return captured.at(-1).text
  }

  assert.match(run({ recoveredError: 'session/model-unavailable: injected Host rejection' }),
    /session\/model-unavailable: injected Host rejection/)
  assert.match(run({ hostError: 'session/model-unavailable: real Host error', recoveredError: 'stale' }),
    /session\/model-unavailable: real Host error/)
  assert.match(run({}), /Unknown failure/)
  assert.match(run({ inheritedRecovery: 'existing older Host recovery' }),
    /existing older Host recovery/)
})


test('issue #684 recovered selecting/loading snapshot is referentially stable for native React model seat', () => {
  const html = hardenVisionToggleHtml(
    injectVisionModelVisibilityBoundary(
      injectClientPresentationBoundary('<html><head></head><body></body></html>'),
    ),
  )
  const source = scriptsOfInjectedFixture(html).find(script => script.includes('function wrapStore('))
  assert.ok(source, 'exercise the generated visibility wrapper, not an independent mock')
  const start = source.indexOf('  function wrapStore(')
  const end = source.indexOf('\n  function wrapDirectory(', start)
  assert.ok(start >= 0 && end > start, 'extract the actual post-hardening wrapper function')
  const context = {
    currentVisionConfig: () => ({}),
    configKey: () => '{}',
    projectVisionModeDirectoryState: (state) => state,
    window: {},
  }
  const wrapStore = vm.runInNewContext(source.slice(start, end) + '\nwrapStore', context)
  let raw = { status: 'loading', current: { provider: 'vendor-vision' } }
  let recoveryError = new Error('session/model-unavailable: rejected')
  const wrapped = wrapStore(
    { getSnapshot: () => raw, subscribe: () => () => {} },
    { getSnapshot: () => ({}) },
    { getSnapshot: () => recoveryError, subscribe: () => () => {} },
  )
  const first = wrapped.getSnapshot()
  assert.equal(first.status, 'error')
  assert.match(first.error, /session\/model-unavailable/)
  assert.notStrictEqual(first, raw, 'never overwrite the Host-owned source snapshot')
  assert.strictEqual(wrapped.getSnapshot(), first,
    'React useSyncExternalStore must see the same object across unchanged reads')

  raw = { ...raw, status: 'selecting' }
  const selecting = wrapped.getSnapshot()
  assert.notStrictEqual(selecting, first)
  assert.strictEqual(wrapped.getSnapshot(), selecting)

  recoveryError = new Error('session/model-unavailable: another rejection')
  const changedError = wrapped.getSnapshot()
  assert.notStrictEqual(changedError, selecting)
  assert.match(changedError.error, /another rejection/)
  assert.strictEqual(wrapped.getSnapshot(), changedError)

  recoveryError = null
  const recovered = wrapped.getSnapshot()
  assert.strictEqual(recovered, raw)
  assert.strictEqual(wrapped.getSnapshot(), recovered)

  raw = { ...raw, status: 'ready' }
  assert.strictEqual(wrapped.getSnapshot(), raw)
  assert.strictEqual(wrapped.getSnapshot(), raw)
})
