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

function makeHarness() {
  const routes = []
  const rootDisposers = []
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
      assert.deepEqual(dependencies, ['webServer'])
      callback({
        webServer,
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
        return name === 'settings' ? settings : undefined
      },
      inject(dependencies, callback) {
        assert.deepEqual(dependencies, ['settings'])
        callback({
          settings,
          get(name) {
            return name === 'settings' ? settings : undefined
          },
          effect(factory) {
            disposeGeneration = factory()
            return disposeGeneration
          },
        })
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

  return { routes, rootDisposers, generation }
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
