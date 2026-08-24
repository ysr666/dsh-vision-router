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

function scriptsOf(html) {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1])
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
  for (const source of scriptsOf(html)) vm.runInNewContext(source, context)

  const created = initial.create()
  assert.equal(created, returned)
  assert.equal(returned.load.__visionRouterModelVisibility, true)

  const replacement = { load(spec) { registered = spec; return spec } }
  window.__ModuleLoader__ = replacement
  assert.equal(replacement.load.__visionRouterModelVisibility, true)
})

test('selection transport rejection is recoverable without mutating the Host directory store and identical double-clicks coalesce', async () => {
  const window = { fetch: async () => ({ ok: true, json: async () => ({ revision: 0, routes: [] }) }) }
  const html = hardenVisionToggleHtml('<html><head></head></html>')
  const source = scriptsOf(html).find((script) => script.includes('__dshVisionRouterRootHardening'))
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
