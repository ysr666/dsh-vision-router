import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { CLIENT_HOST_COMPAT_PRELUDE } from '../lib/client-host-compat-prelude.js'
import { CLIENT_PRESENTATION_PRELUDE } from '../lib/client-presentation-boundary.js'

function fakeReact() {
  return {
    createElement() {},
    useState(initial) { return [initial, () => {}] },
    useEffect() {},
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    Fragment: Symbol('Fragment'),
  }
}

function loaderHarness(preludes = [CLIENT_HOST_COMPAT_PRELUDE]) {
  let registered
  const pending = []
  const loader = {
    mode: 'queue',
    load(spec) {
      if (this.mode === 'queue') pending.push(spec)
      else registered = spec
      return spec
    },
    create() {
      this.mode = 'live'
      this.load = (spec) => {
        registered = spec
        return spec
      }
      for (const spec of pending.splice(0)) this.load(spec)
      return this
    },
  }
  const window = { __ModuleLoader__: loader }
  const context = {
    window,
    Object,
    Promise,
    Array,
    String,
    Reflect,
    Proxy,
    Symbol,
    Map,
    Set,
    WeakMap,
    Math,
    console,
    setTimeout() { return 1 },
    clearTimeout() {},
  }
  for (const prelude of preludes) vm.runInNewContext(prelude, context)
  loader.create()
  return {
    loader,
    register(spec) { loader.load(spec); return registered },
  }
}

function targetPluginSpec(apply) {
  return {
    id: 'dsh-vision-router',
    factory() {
      return { apply }
    },
  }
}

function jsonValue(value) {
  return JSON.parse(JSON.stringify(value))
}

test('alpha Host catalog is projected into the legacy client connection facade', async () => {
  const catalog = { groups: [{ id: 'deepseek-official', models: [] }], failures: [] }
  const events = []
  const remote = {
    session: {
      modelCatalog: async () => ({ ok: true, value: catalog }),
    },
    $on(event) {
      events.push(event)
      return () => {}
    },
  }
  const rpc = { call() {} }
  const connection = { isLoopback: false, rpc }
  const localeRegistrations = []
  const ctx = {
    remote,
    locale: {
      register(namespace, dictionaries) {
        localeRegistrations.push([namespace, dictionaries])
        return () => {}
      },
    },
    get(name) {
      if (name === 'connection') return connection
      return undefined
    },
  }

  let observed
  const harness = loaderHarness()
  const registered = harness.register(targetPluginSpec(async (compatCtx) => {
    const compatConnection = compatCtx.get('connection')
    const result = await compatConnection.api.llm.models({})
    compatCtx.remote.$on('credentials/updated', () => {})
    compatCtx.locale.register('vision-router', {
      zh: {
        hintInstantDescribe: '旧文案',
        openPresentedImage: '原图',
        openNamedImage: '原图：{name}',
      },
      en: {
        hintInstantDescribe: 'old',
        openPresentedImage: 'original',
        openNamedImage: 'original: {name}',
      },
    })
    observed = { compatConnection, result }
  }))
  const plugin = registered.factory(() => ({}))
  await plugin.apply(ctx)

  assert.equal(observed.compatConnection.isLoopback, false)
  assert.equal(observed.compatConnection.rpc, rpc)
  assert.deepEqual(jsonValue(observed.result), { result: { ok: true, value: catalog } })
  assert.deepEqual(events, ['credentials/reference-updated'])
  assert.equal(localeRegistrations.length, 1)
  const [, dictionaries] = localeRegistrations[0]
  assert.match(dictionaries.zh.hintInstantDescribe, /Host 持久化/)
  assert.match(dictionaries.en.hintInstantDescribe, /Host-persisted/)
  assert.equal(dictionaries.zh.openPresentedImage, '点击查看图片')
  assert.equal(dictionaries.en.openPresentedImage, 'Open image')
})

test('pre-alpha Host keeps its exact Connection/Remote surfaces and credential event', async () => {
  const events = []
  const oldCatalog = { rpcId: 'old', result: { ok: true, value: { groups: [], failures: [] } } }
  const remote = {
    $on(event) {
      events.push(event)
      return () => {}
    },
  }
  const connection = {
    isLoopback: true,
    rpc: { call() {} },
    api: { llm: { models: async () => oldCatalog } },
  }
  const ctx = {
    remote,
    locale: { register() { return () => {} } },
    get(name) { return name === 'connection' ? connection : undefined },
  }

  let seenConnection
  let seenRemote
  let catalog
  const harness = loaderHarness()
  const registered = harness.register(targetPluginSpec(async (compatCtx) => {
    seenConnection = compatCtx.get('connection')
    seenRemote = compatCtx.remote
    catalog = await seenConnection.api.llm.models({})
    seenRemote.$on('credentials/updated', () => {})
  }))
  await registered.factory(() => ({})).apply(ctx)

  assert.equal(seenConnection, connection)
  assert.equal(seenRemote, remote)
  assert.equal(catalog, oldCatalog)
  assert.deepEqual(events, ['credentials/updated'])
})

test('Host compatibility prelude survives queue-to-live loader replacement', () => {
  const harness = loaderHarness([CLIENT_HOST_COMPAT_PRELUDE])
  const registered = harness.register(targetPluginSpec(() => {}))
  const plugin = registered.factory(() => ({}))
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.apply.__visionRouterHostCompat, true)
})

test('Host compatibility and presentation boundaries compose in either order', async () => {
  for (const preludes of [
    [CLIENT_HOST_COMPAT_PRELUDE, CLIENT_PRESENTATION_PRELUDE],
    [CLIENT_PRESENTATION_PRELUDE, CLIENT_HOST_COMPAT_PRELUDE],
  ]) {
    const catalog = { groups: [{ id: 'deepseek-official', models: [] }], failures: [] }
    const events = []
    const remote = {
      session: {
        modelCatalog: async () => ({ ok: true, value: catalog }),
      },
      $on(event) {
        events.push(event)
        return () => {}
      },
    }
    const connection = { isLoopback: false, rpc: { call() {} } }
    const ctx = {
      remote,
      locale: { register() { return () => {} } },
      get(name) { return name === 'connection' ? connection : undefined },
    }

    let observedCatalog
    let observedConnection
    const harness = loaderHarness(preludes)
    const registered = harness.register({
      id: 'dsh-vision-router',
      factory(require) {
        const attachment = require('@deepseek-ai/dsh-client-ui-attachment')
        return {
          ImageGallery: attachment.ImageGallery,
          async apply(compatCtx) {
            observedConnection = compatCtx.get('connection')
            observedCatalog = await observedConnection.api.llm.models({})
            compatCtx.remote.$on('credentials/updated', () => {})
          },
        }
      },
    })
    const React = fakeReact()
    const requested = []
    const plugin = registered.factory((id) => {
      requested.push(id)
      if (id === 'react') return React
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error(`unexpected value request: ${id}`)
    })

    assert.equal(typeof plugin.ImageGallery, 'function')
    assert.equal(typeof plugin.apply, 'function')
    assert.ok(!requested.includes('@deepseek-ai/dsh-client-ui-attachment'))

    await plugin.apply(ctx)
    assert.equal(observedConnection.isLoopback, false)
    assert.equal(observedConnection.rpc, connection.rpc)
    assert.deepEqual(jsonValue(observedCatalog), { result: { ok: true, value: catalog } })
    assert.deepEqual(events, ['credentials/reference-updated'])
  }
})

test('Host compatibility prelude ignores other client plugins', () => {
  const harness = loaderHarness()
  const apply = () => {}
  const registered = harness.register({ id: 'other-plugin', factory: () => ({ apply }) })
  const plugin = registered.factory(() => ({}))
  assert.equal(plugin.apply, apply)
})