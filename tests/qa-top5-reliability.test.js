import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { installVisionAttachmentAdmissionPolicy } from '../lib/dsh-contract-compat.js'
import { ImageResourceGovernor } from '../lib/image-resource-governor.js'
import { SETTINGS_RC8_CLIENT_PRELUDE } from '../lib/settings-client-rc8-lifecycle.js'
import { installVisionToolRuntimeBoundary } from '../lib/vision-tool-runtime-boundary.js'

function runtimeHarness({ scopeValue = { cache: true } } = {}) {
  let registered
  const fsCalls = []
  const rawFs = {
    async resolve(value, options) {
      fsCalls.push(['resolve', value, options])
      return { targetKey: `${options?.cwd ?? '<default>'}/${value}`, displayPath: value }
    },
    async readBytes(target, signal, maxBytes) {
      fsCalls.push(['readBytes', target, signal, maxBytes])
      return new Uint8Array([1, 2, 3])
    },
  }
  const rawScope = {
    get() { return scopeValue },
    watch() { return () => {} },
  }
  const child = { settings: { register() { return rawScope } } }
  const ctx = {
    get(name) { return name === 'fs' ? rawFs : undefined },
    tools: { register(def) { registered = def; return () => {} } },
    inject(_deps, callback) { return callback(child) },
  }
  const wrapped = installVisionToolRuntimeBoundary(ctx)
  return { wrapped, fsCalls, rawScope, get registered() { return registered } }
}

test('vision tool runtime resolves relative paths from session cwd and forwards cancellation to fs', async () => {
  const harness = runtimeHarness()
  const controller = new AbortController()
  harness.wrapped.tools.register({
    name: 'vision_html_screenshot',
    async execute() {
      const fs = harness.wrapped.get('fs')
      const target = await fs.resolve('page.html')
      await fs.readBytes(target, undefined, 1024)
      return target.targetKey
    },
  })
  const result = await harness.registered.execute({}, {
    signal: controller.signal,
    agent: { session: { header: { cwd: '/workspace' } } },
  })
  assert.equal(result, '/workspace/page.html')
  assert.equal(harness.fsCalls[0][2].cwd, '/workspace')
  assert.equal(harness.fsCalls[0][2].signal, controller.signal)
  assert.equal(harness.fsCalls[1][2], controller.signal)
})

test('cancelled vision work leaves the image resource queue before a slot becomes available', async () => {
  const harness = runtimeHarness()
  const governor = new ImageResourceGovernor({ maxBytes: 1, maxConcurrent: 1 })
  const releaseFirst = await governor.acquire(1)
  const controller = new AbortController()
  let started = false
  harness.wrapped.tools.register({
    name: 'vision_crop',
    async execute() {
      const release = await governor.acquire(1)
      started = true
      release()
      return 'started'
    },
  })
  const pending = harness.registered.execute({}, {
    signal: controller.signal,
    agent: { session: { header: { cwd: '/workspace' } } },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(governor.stats().queued, 1)
  controller.abort()
  await assert.rejects(pending, /aborted/i)
  assert.equal(governor.stats().queued, 0)
  releaseFirst()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started, false)
})

test('vision_describe delegates all caching to the live order-sensitive cache without mutating settings', async () => {
  const harness = runtimeHarness({ scopeValue: { cache: true, cacheMaxEntries: 200, cacheTtlSeconds: 3600 } })
  let scope
  harness.wrapped.inject(['settings'], (child) => { scope = child.settings.register('vision-router') })
  harness.wrapped.tools.register({
    name: 'vision_describe',
    async execute() { return scope.get() },
  })
  const exec = { agent: { session: { header: { cwd: '/workspace' } } } }
  const single = await harness.registered.execute({ attachmentIds: ['A'] }, exec)
  const multi = await harness.registered.execute({ attachmentIds: ['A', 'B'] }, exec)
  assert.equal(single.cache, false)
  assert.equal(multi.cache, false)
  assert.equal(single.cacheMaxEntries, 200)
  assert.equal(scope.get().cache, true, 'cache suppression must remain invocation-local')
})

function legacyLimits() {
  return Object.freeze({
    maxImageBytes: 20 * 1024 * 1024,
    maxImagePixels: 100_000_000,
    maxImageDimension: 2000,
  })
}

test('attachment admission migration re-applies to replacement attachment services', () => {
  const first = { imageLimits: legacyLimits() }
  let replacementCallback
  const ctx = {
    get(name) { return name === 'attachments' ? first : undefined },
    inject(deps, callback) {
      assert.deepEqual(deps, ['attachments'])
      replacementCallback = callback
    },
  }
  const initial = installVisionAttachmentAdmissionPolicy(ctx)
  assert.equal(initial.changed, true)
  assert.equal(first.imageLimits.maxImageDimension, 10_000)
  const second = { imageLimits: legacyLimits() }
  replacementCallback({ get(name) { return name === 'attachments' ? second : undefined } })
  assert.equal(second.imageLimits.maxImageDimension, 10_000)
})

function rc8ClientHarness() {
  const queued = []
  let registered
  const loader = {
    mode: 'queue',
    load(spec) { queued.push(spec); return spec },
    create() {
      const pending = queued.splice(0)
      this.mode = 'live'
      this.load = (spec) => { registered = spec; return spec }
      for (const spec of pending) this.load(spec)
    },
  }
  let revision = 7
  const permissionFetches = []
  let remoteEnabled = false
  const rpcCalls = []
  let confirms = 0
  const rpc = {
    async call(channel, endpoint, payload) {
      rpcCalls.push([channel, endpoint, payload])
      if (endpoint === 'describe') {
        return { ok: true, value: remoteEnabled
          ? { enabled: true, reason: 'enabled', writable: true, view: { value: {}, user: {}, revision } }
          : { enabled: false, reason: 'permission-disabled', writable: false } }
      }
      if (endpoint === 'authorize') {
        remoteEnabled = true
        return { ok: true, value: { enabled: true, reason: 'enabled', writable: true, view: { value: {}, user: {}, revision } } }
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    },
  }
  const context = {
    window: { __ModuleLoader__: loader, confirm() { confirms += 1; return true }, alert() {} },
    document: { documentElement: { lang: 'zh-CN' } },
    navigator: { language: 'zh-CN' },
    fetch: async (url, options) => {
      const payload = JSON.parse(options.body)
      permissionFetches.push([url, payload])
      revision += 1
      return { ok: true, status: 200, async json() {
        return { ok: true, value: { operation: payload.operation, present: payload.operation === 'set', value: payload.value, revision } }
      } }
    },
    Proxy, Reflect, Object, Array, WeakMap, Promise, String, Error, TypeError, JSON, Number, console,
  }
  vm.runInNewContext(SETTINGS_RC8_CLIENT_PRELUDE, context)
  loader.create()
  let appliedCtx
  loader.load({ id: 'dsh-vision-router', factory() { return { apply(ctx) { appliedCtx = ctx } } } })
  const exports = registered.factory(() => undefined)
  const snapshot = { status: 'ready', writable: true, mode: 'host', revision: 7, value: { allowRemoteSettings: false }, user: {} }
  const rawScope = {
    getSnapshot() { return snapshot }, async load() {},
    async set(field, value) { snapshot.user[field] = value },
    async unset(field) { delete snapshot.user[field] },
  }
  exports.apply({
    get(name) { return name === 'connection' ? { rpc } : undefined },
    settingsScope: { bind() { return rawScope } },
  })
  return { appliedCtx, permissionFetches, rpcCalls, get confirms() { return confirms } }
}

test('rc8 queue-to-live transition preserves local permission and remote risk wrappers', async () => {
  const harness = rc8ClientHarness()
  const scope = harness.appliedCtx.settingsScope.bind({ namespace: 'vision-router' })
  await scope.set('allowRemoteSettings', 'true')
  assert.equal(harness.permissionFetches.length, 1)
  assert.equal(harness.permissionFetches[0][1].value, true)
  const result = await harness.appliedCtx.get('connection').rpc.call('/vision-router-settings', 'describe', {})
  assert.equal(result.value.enabled, true)
  assert.equal(harness.confirms, 1)
  assert.deepEqual(harness.rpcCalls.map((entry) => entry[1]), ['describe', 'authorize', 'describe'])
})
