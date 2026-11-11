import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import {
  DSH_017_SETTINGS_COMPAT_MARK,
  LOCAL_SETTINGS_PATH,
} from '../lib/dsh-settings-017-compat.js'
import { installDsh017RootLocalSettingsTransport } from '../lib/web/dsh-settings-017-root-transport.js'

function request(method, payload) {
  const source = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]
  const req = Readable.from(source)
  req.method = method
  return req
}

function response() {
  let status
  const headers = Object.create(null)
  let body = ''
  return {
    writeHead(code, values = {}) {
      status = code
      Object.assign(headers, values)
    },
    setHeader(name, value) {
      headers[name] = value
    },
    end(chunk = '') {
      body += String(chunk)
    },
    snapshot() {
      return {
        status,
        headers,
        body,
        json: body === '' ? undefined : JSON.parse(body),
      }
    },
  }
}

function descriptor(revision, value) {
  return {
    ns: 'vision-router',
    value,
    base: { structuredVisionBootstrap: false, visionDepth: 'standard' },
    user: value,
    revision,
    applies: true,
  }
}

function makeHarness({ browserAuth = (req) => req?.browserRejected, configForms } = {}) {
  const routes = []
  const rootDisposers = []
  const pendingFormCallbacks = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index !== -1) routes.splice(index, 1)
      }
    },
  }
  const root = {
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['webServer', 'connection'])
      callback({
        webServer,
        connection: typeof browserAuth === 'function' ? { requestRejection: browserAuth } : {},
        effect(factory) {
          const dispose = factory()
          rootDisposers.push(dispose)
          return dispose
        },
      })
      return () => {}
    },
  }

  function generation(settings) {
    let disposeGeneration = () => {}
    const ctx = {
      root,
      get(name) {
        return name === 'settings' ? settings : name === 'configForms' ? configForms : undefined
      },
      inject(dependencies, callback) {
        const scope = {
          settings,
          get(name) {
            return name === 'settings' ? settings : name === 'configForms' ? configForms : undefined
          },
          effect(factory) {
            disposeGeneration = factory()
            return disposeGeneration
          },
        }
        if (dependencies.join(',') === 'settings,configForms') {
          if (typeof configForms?.get !== 'function') {
            const slot = { callback, scope }
            pendingFormCallbacks.push(slot)
            return () => {
              const pos = pendingFormCallbacks.indexOf(slot)
              if (pos >= 0) pendingFormCallbacks.splice(pos, 1)
            }
          }
        } else assert.deepEqual(dependencies, ['settings'])
        callback(scope)
        return () => {}
      },
    }
    return {
      ctx,
      dispose() {
        disposeGeneration?.()
      },
    }
  }

  return {
    routes, rootDisposers, generation,
    startConfigForms(service) {
      configForms = service
      for (const { callback, scope } of pendingFormCallbacks.splice(0)) callback(scope)
    },
  }
}

test('0.1.7 root settings route survives repeated ConfigEditor reconciliation across sequential writes', async () => {
  const harness = makeHarness()
  let firstGeneration
  let secondGeneration
  let thirdGeneration

  const thirdSettings = {
    [DSH_017_SETTINGS_COMPAT_MARK]: true,
    writable: true,
    describe() {
      return [descriptor(2, { structuredVisionBootstrap: true, visionDepth: 'fast' })]
    },
    async mutate() {
      throw new Error('third generation must not receive an already accepted mutation')
    },
  }
  thirdGeneration = harness.generation(thirdSettings)

  const secondSettings = {
    [DSH_017_SETTINGS_COMPAT_MARK]: true,
    writable: true,
    describe() {
      return [descriptor(1, { structuredVisionBootstrap: true, visionDepth: 'standard' })]
    },
    async mutate(namespace, ops, expectedRevision) {
      assert.equal(namespace, 'vision-router')
      assert.equal(expectedRevision, 1)
      assert.deepEqual(ops, [{ op: 'set', path: ['visionDepth'], value: 'fast' }])
      secondGeneration.dispose()
      installDsh017RootLocalSettingsTransport(thirdGeneration.ctx)
    },
  }
  secondGeneration = harness.generation(secondSettings)

  const firstSettings = {
    [DSH_017_SETTINGS_COMPAT_MARK]: true,
    writable: true,
    describe() {
      return [descriptor(0, { structuredVisionBootstrap: false, visionDepth: 'standard' })]
    },
    async mutate(namespace, ops, expectedRevision) {
      assert.equal(namespace, 'vision-router')
      assert.equal(expectedRevision, 0)
      assert.deepEqual(ops, [{ op: 'set', path: ['structuredVisionBootstrap'], value: true }])

      // ConfigEditor.edit() has committed and DSH now reconciles the plugin:
      // the generation that accepted this POST is disposed before mutate()
      // resolves, then the replacement generation mounts.
      firstGeneration.dispose()
      installDsh017RootLocalSettingsTransport(secondGeneration.ctx)
    },
  }
  firstGeneration = harness.generation(firstSettings)

  installDsh017RootLocalSettingsTransport(firstGeneration.ctx)
  assert.equal(harness.routes.length, 1, 'the root transport must register exactly one route')
  assert.equal(harness.routes[0].path, LOCAL_SETTINGS_PATH)
  assert.equal(harness.rootDisposers.length, 1, 'the route lifetime must be owned by a root child fiber')

  const firstPostRes = response()
  await harness.routes[0].handler(request('POST', {
    ops: [{ op: 'set', path: ['structuredVisionBootstrap'], value: true }],
    expectedRevision: 0,
  }), firstPostRes)

  const firstPost = firstPostRes.snapshot()
  assert.equal(firstPost.status, 200)
  assert.equal(firstPost.json.ok, true)
  assert.equal(firstPost.json.value.revision, 1)
  assert.equal(firstPost.json.value.value.structuredVisionBootstrap, true)
  assert.equal(firstPost.json.value.value.visionDepth, 'standard')
  assert.equal(harness.routes.length, 1, 'replacement generation must reuse the root-owned route')

  const secondPostRes = response()
  await harness.routes[0].handler(request('POST', {
    ops: [{ op: 'set', path: ['visionDepth'], value: 'fast' }],
    expectedRevision: 1,
  }), secondPostRes)

  const secondPost = secondPostRes.snapshot()
  assert.equal(secondPost.status, 200)
  assert.equal(secondPost.json.ok, true)
  assert.equal(secondPost.json.value.revision, 2)
  assert.equal(secondPost.json.value.value.structuredVisionBootstrap, true)
  assert.equal(secondPost.json.value.value.visionDepth, 'fast')
  assert.equal(harness.routes.length, 1, 'sequential HMR writes must not duplicate or lose the route')
  assert.equal(harness.rootDisposers.length, 1, 'one stable route owner must survive every DVR generation')

  const getRes = response()
  await harness.routes[0].handler(request('GET'), getRes)
  const get = getRes.snapshot()
  assert.equal(get.status, 200)
  assert.equal(get.json.value.revision, 2)
  assert.equal(get.json.value.value.visionDepth, 'fast')
})

test('root settings transport stays absent on legacy SettingsProvider hosts', () => {
  const harness = makeHarness()
  const legacySettings = {
    register() {},
    describe() { return [] },
    async mutate() {},
  }
  const legacy = harness.generation(legacySettings)
  installDsh017RootLocalSettingsTransport(legacy.ctx)
  assert.equal(harness.routes.length, 0)
  assert.equal(harness.rootDisposers.length, 0)
})

test('root settings transport binds generation ownership before admitting the root route', () => {
  let rootInjectCalls = 0
  const settings = {
    [DSH_017_SETTINGS_COMPAT_MARK]: true,
    describe() { return [descriptor(0, { visionDepth: 'standard' })] },
    async mutate() {},
  }
  const root = {
    inject() {
      rootInjectCalls += 1
      throw new Error('root route must not be reached')
    },
  }
  const ctx = {
    root,
    get(name) { return name === 'settings' ? settings : undefined },
    inject(_dependencies, callback) {
      callback({
        settings,
        get(name) { return name === 'settings' ? settings : undefined },
        effect() { throw new Error('inactive fiber') },
      })
    },
  }

  assert.throws(() => installDsh017RootLocalSettingsTransport(ctx), /inactive fiber/)
  assert.equal(rootInjectCalls, 0)
})

test('root settings transport rejects a compatible Settings generation without lifecycle ownership', () => {
  let rootInjectCalls = 0
  const settings = {
    [DSH_017_SETTINGS_COMPAT_MARK]: true,
    describe() { return [descriptor(0, { visionDepth: 'standard' })] },
    async mutate() {},
  }
  const ctx = {
    root: { inject() { rootInjectCalls += 1 } },
    get(name) { return name === 'settings' ? settings : undefined },
    inject(_dependencies, callback) {
      callback({
        settings,
        get(name) { return name === 'settings' ? settings : undefined },
      })
    },
  }

  assert.throws(
    () => installDsh017RootLocalSettingsTransport(ctx),
    /requires lifecycle ownership/,
  )
  assert.equal(rootInjectCalls, 0)
})

test('root settings transport rejects remote, proxied and unauthenticated reads and writes', async () => {
  const harness = makeHarness()
  let mutations = 0
  const settings = {
    [DSH_017_SETTINGS_COMPAT_MARK]: true,
    writable: true,
    describe() { return [descriptor(0, { localOnlyVision: true, proxy: 'http://localhost:8888' })] },
    async mutate() { mutations += 1 },
  }
  installDsh017RootLocalSettingsTransport(harness.generation(settings).ctx)
  const handler = harness.routes[0].handler

  function networkRequest(method, remoteAddress, host, { forwarded, rejected } = {}) {
    const req = request(method, method === 'POST'
      ? { ops: [{ op: 'set', path: ['localOnlyVision'], value: false }], expectedRevision: 0 }
      : undefined)
    req.socket = { remoteAddress }
    req.headers = { host }
    if (forwarded) req.headers['x-forwarded-for'] = '203.0.113.7'
    if (rejected) req.browserRejected = rejected
    return req
  }

  for (const method of ['GET', 'POST']) {
    for (const req of [
      networkRequest(method, '203.0.113.7', 'dvr.example.org'),
      networkRequest(method, '127.0.0.1', 'dvr.example.org'),
      networkRequest(method, '127.0.0.1', 'localhost:3080', { forwarded: true }),
      networkRequest(method, '127.0.0.1', 'localhost:3080', { rejected: 401 }),
    ]) {
      const res = response()
      await handler(req, res)
      assert.ok([401, 403].includes(res.snapshot().status), method)
      assert.equal(res.snapshot().json.error.code, 'access-denied')
    }
  }
  assert.equal(mutations, 0, 'no untrusted request may reach the ConfigEditor settings facade')
  const localRes = response()
  await handler(networkRequest('GET', '127.0.0.1', 'localhost:3080'), localRes)
  assert.equal(localRes.snapshot().status, 200)
  assert.equal(localRes.snapshot().json.value.value.localOnlyVision, true)
})

test('root settings transport fails closed when browser-auth service is absent or throws', async () => {
  for (const browserAuth of [null, () => { throw new Error('auth not ready') }]) {
    const harness = makeHarness({ browserAuth })
    let reads = 0
    const settings = {
      [DSH_017_SETTINGS_COMPAT_MARK]: true,
      writable: true,
      describe() { reads += 1; return [descriptor(0, { localOnlyVision: true })] },
      async mutate() { assert.fail('must not mutate without Host browser auth') },
    }
    installDsh017RootLocalSettingsTransport(harness.generation(settings).ctx)
    const req = request('GET')
    req.socket = { remoteAddress: '127.0.0.1' }
    req.headers = { host: 'localhost:3080' }
    const res = response()
    await harness.routes[0].handler(req, res)
    assert.equal(res.snapshot().status, 403)
    assert.equal(reads, 0)
  }
})

test('#827: native SettingsProvider plus configForms mounts an authenticated local bridge with readback', async () => {
  const harness = makeHarness({ configForms: { get() {} } })
  let revision = 0
  let depth = 'standard'
  let mutations = 0
  const nativeSettings = {
    register() {},
    writable: true,
    describe() { return [descriptor(revision, { visionDepth: depth })] },
    async mutate(namespace, ops, expectedRevision) {
      assert.equal(namespace, 'vision-router')
      assert.equal(expectedRevision, revision)
      assert.deepEqual(ops, [{ op: 'set', path: ['visionDepth'], value: 'fast' }])
      depth = 'fast'
      revision += 1
      mutations += 1
    },
  }
  installDsh017RootLocalSettingsTransport(harness.generation(nativeSettings).ctx)
  assert.equal(harness.routes.length, 1, 'native SettingsProvider must not be rejected for missing the facade marker')

  function localRequest(method, payload, remoteAddress = '127.0.0.1') {
    const req = request(method, payload)
    req.socket = { remoteAddress }
    req.headers = { host: remoteAddress === '127.0.0.1' ? 'localhost:3080' : 'dvr.example.org' }
    return req
  }

  const denied = response()
  await harness.routes[0].handler(localRequest('POST', {
    ops: [{ op: 'set', path: ['visionDepth'], value: 'fast' }],
    expectedRevision: 0,
  }, '203.0.113.7'), denied)
  assert.equal(denied.snapshot().status, 403)
  assert.equal(mutations, 0, 'remote requests must not mutate native SettingsProvider')

  const initial = response()
  await harness.routes[0].handler(localRequest('GET'), initial)
  assert.equal(initial.snapshot().status, 200)
  assert.equal(initial.snapshot().json.value.revision, 0)

  const saved = response()
  await harness.routes[0].handler(localRequest('POST', {
    ops: [{ op: 'set', path: ['visionDepth'], value: 'fast' }],
    expectedRevision: 0,
  }), saved)
  assert.equal(saved.snapshot().status, 200)
  assert.equal(saved.snapshot().json.value.revision, 1)
  assert.equal(saved.snapshot().json.value.value.visionDepth, 'fast')

  const readback = response()
  await harness.routes[0].handler(localRequest('GET'), readback)
  assert.equal(readback.snapshot().json.value.revision, 1)
  assert.equal(readback.snapshot().json.value.value.visionDepth, 'fast')
  assert.equal(mutations, 1)
})


test('native SettingsProvider waits for delayed configForms without permanent 404', async () => {
  const harness = makeHarness()
  const native = {
    register() {},
    describe() { return [descriptor(3, { visionDepth: 'standard' })] },
    async mutate(namespace, ops, revision) {
      assert.equal(namespace, 'vision-router')
      assert.equal(revision, 3)
      assert.deepEqual(ops, [{ op: 'set', path: ['visionDepth'], value: 'fast' }])
    },
  }
  const generation = harness.generation(native)
  installDsh017RootLocalSettingsTransport(generation.ctx)
  assert.equal(harness.routes.length, 0, 'before configForms, do not bind native route')
  harness.startConfigForms({ get(namespace) { assert.equal(namespace, 'vision-router'); return {} } })
  assert.equal(harness.routes.length, 1, 'Cordis multi-service injection must mount after configForms arrives')
  const out = response()
  await harness.routes[0].handler(request('GET'), out)
  assert.equal(out.snapshot().status, 200)
  assert.equal(out.snapshot().json.value.value.visionDepth, 'standard')
  const post = response()
  await harness.routes[0].handler(request('POST', {
    ops: [{ op: 'set', path: ['visionDepth'], value: 'fast' }],
    expectedRevision: 3,
  }), post)
  assert.equal(post.snapshot().status, 200)
  assert.equal(harness.routes.length, 1, 'do not duplicate root route')
})
