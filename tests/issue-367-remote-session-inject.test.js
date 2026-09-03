import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { CLIENT_HOST_COMPAT_PRELUDE } from '../lib/client-host-compat-prelude.js'

function loaderHarness() {
  let registered
  const loader = {
    load(spec) {
      registered = spec
      return spec
    },
  }
  const context = {
    window: { __ModuleLoader__: loader },
    Object,
    Promise,
    Array,
    String,
    Reflect,
    Proxy,
    console,
  }
  vm.runInNewContext(CLIENT_HOST_COMPAT_PRELUDE, context)
  return {
    register(spec) {
      loader.load(spec)
      return registered
    },
  }
}

test('issue #367: alpha Host remote.session is resolved through ctx.get without touching the traceable remote proxy', async () => {
  const catalog = {
    groups: [{ id: 'deepseek-official', models: [{ id: 'deepseek-v4' }] }],
    failures: [],
  }
  const hostSession = {
    async modelCatalog() {
      return { ok: true, value: catalog }
    },
  }
  const events = []
  let forbiddenSessionReads = 0
  const remoteTarget = {
    $on(event) {
      events.push(event)
      return () => {}
    },
  }
  const remote = new Proxy(remoteTarget, {
    get(target, property, receiver) {
      if (property === 'session') {
        forbiddenSessionReads += 1
        throw new Error('cannot get property "remote.session" without inject')
      }
      return Reflect.get(target, property, receiver)
    },
  })
  const connection = { isLoopback: false, rpc: { call() {} } }
  const ctx = {
    remote,
    locale: { register() { return () => {} } },
    get(name) {
      if (name === 'remote.session') return hostSession
      if (name === 'connection') return connection
      return undefined
    },
  }

  let result
  const harness = loaderHarness()
  const registered = harness.register({
    id: 'dsh-vision-router',
    factory() {
      return {
        async apply(compatCtx) {
          result = await compatCtx.get('connection').api.llm.models({})
          compatCtx.remote.$on('credentials/updated', () => {})
        },
      }
    },
  })

  await registered.factory(() => ({})).apply(ctx)

  assert.equal(forbiddenSessionReads, 0)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { result: { ok: true, value: catalog } })
  assert.deepEqual(events, ['credentials/reference-updated'])
})

test('issue #367: optional remote.session probe still fails closed on older Hosts', async () => {
  const events = []
  let forbiddenSessionReads = 0
  const remoteTarget = {
    $on(event) {
      events.push(event)
      return () => {}
    },
  }
  const remote = new Proxy(remoteTarget, {
    get(target, property, receiver) {
      if (property === 'session') {
        forbiddenSessionReads += 1
        throw new Error('cannot get property "remote.session" without inject')
      }
      return Reflect.get(target, property, receiver)
    },
  })
  const legacyCatalog = { result: { ok: true, value: { groups: [], failures: [] } } }
  const connection = {
    api: { llm: { async models() { return legacyCatalog } } },
  }
  const ctx = {
    remote,
    locale: { register() { return () => {} } },
    get(name) {
      if (name === 'connection') return connection
      return undefined
    },
  }

  let seenRemote
  let seenConnection
  let result
  const harness = loaderHarness()
  const registered = harness.register({
    id: 'dsh-vision-router',
    factory() {
      return {
        async apply(compatCtx) {
          seenRemote = compatCtx.remote
          seenConnection = compatCtx.get('connection')
          result = await seenConnection.api.llm.models({})
          seenRemote.$on('credentials/updated', () => {})
        },
      }
    },
  })

  await registered.factory(() => ({})).apply(ctx)

  assert.equal(forbiddenSessionReads, 1, 'fallback probe may touch an old Host once, but must swallow the trace error')
  assert.equal(seenRemote, remote)
  assert.equal(seenConnection, connection)
  assert.equal(result, legacyCatalog)
  assert.deepEqual(events, ['credentials/updated'])
})
