import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { VISION_CLIENT_ROOT_PRELUDE } from '../lib/vision-client-root-boundary.js'
import { HARDENED_CLIENT_PRESENTATION_PRELUDE } from '../lib/client-presentation-lifecycle.js'
import { VISION_MODEL_VISIBILITY_PRELUDE } from '../lib/vision-model-visibility-boundary.js'

const MODEL_TARGET = '@deepseek-ai/dsh-client-ui-model-selection'
const TOGGLE_TARGET = 'dsh-vision-router'

function model(id) {
  return { id, name: id }
}

function group(id, name, models) {
  return { id, name, models: models.map(model) }
}

function ownership(routes, available = true) {
  const snapshot = Object.freeze({
    available,
    revision: 1,
    routes: Object.freeze(routes.map((entry) => Object.freeze({ ...entry }))),
  })
  const recoveries = new WeakMap()
  return {
    getSnapshot() { return snapshot },
    subscribe() { return () => {} },
    refresh() { return Promise.resolve(snapshot) },
    sourceFor(provider) {
      return snapshot.routes.find((entry) => entry.provider === provider)?.source
    },
    recoveryFor(directory) {
      let state = recoveries.get(directory)
      if (state) return state
      let error = null
      const listeners = new Set()
      state = {
        getSnapshot() { return error },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        fail(value) {
          error = value instanceof Error ? value : new Error(String(value))
          for (const listener of listeners) listener()
        },
        clear() {
          error = null
          for (const listener of listeners) listener()
        },
      }
      recoveries.set(directory, state)
      return state
    },
  }
}

function vmContext(loader, ownershipApi) {
  const window = { __ModuleLoader__: loader }
  if (ownershipApi) window.__dshVisionRouterRouteOwnership = ownershipApi
  return {
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
    Error,
    console,
  }
}

function applyDirectoryPlugin({ target = MODEL_TARGET, ownershipApi, input, directoryOverrides = {} }) {
  let registered
  const loader = {
    load(spec) { registered = spec; return spec },
  }
  const context = vmContext(loader, ownershipApi)
  vm.runInNewContext(VISION_CLIENT_ROOT_PRELUDE, context)

  let raw = input
  const listeners = new Set()
  const directory = {
    store: {
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      getSnapshot() { return raw },
    },
    async load() { return raw },
    async select() {},
    ...directoryOverrides,
  }
  const models = { directoryFor() { return directory } }
  let visibleDirectory
  loader.load({
    id: target,
    factory() {
      return {
        inject: ['modelDirectories'],
        apply(ctx) {
          ctx.inject(['modelDirectories'], (scope) => {
            visibleDirectory = scope.modelDirectories.directoryFor('session-1')
          })
        },
      }
    },
  })
  const plugin = registered.factory(() => { throw new Error('unexpected require') })
  plugin.apply({
    modelDirectories: models,
    inject(_deps, callback) {
      callback({ modelDirectories: models })
    },
  })
  return {
    directory,
    visibleDirectory,
    get raw() { return raw },
    setRaw(next) {
      raw = next
      for (const listener of listeners) listener()
    },
  }
}

test('issue #284 exact wrapper spoof is removed from the Vision-toggle directory when Host ownership rejects it', () => {
  const input = {
    current: { provider: 'vendor', model: 'm' },
    status: 'ready',
    error: null,
    groups: [
      group('vendor', 'Vendor', ['m']),
      group('vendor-vision', 'Vendor + 自动识图', ['m']),
    ],
  }
  const { visibleDirectory } = applyDirectoryPlugin({
    target: TOGGLE_TARGET,
    ownershipApi: ownership([]),
    input,
  })

  assert.deepEqual(
    Array.from(visibleDirectory.store.getSnapshot().groups, (entry) => entry.id),
    ['vendor'],
  )
})

test('issue #284 Vision toggle fails closed when ownership endpoint is unavailable', () => {
  const input = {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    status: 'ready',
    error: null,
    groups: [
      group('deepseek-official', 'DeepSeek', ['deepseek-v4-pro']),
      group('deepseek-vision', 'DeepSeek + 自动识图', ['deepseek-v4-pro']),
    ],
  }
  const { visibleDirectory } = applyDirectoryPlugin({
    target: TOGGLE_TARGET,
    ownershipApi: ownership([], false),
    input,
  })

  assert.deepEqual(
    Array.from(visibleDirectory.store.getSnapshot().groups, (entry) => entry.id),
    ['deepseek-official'],
  )
})

test('issue #284 stock model picker hides only Host-confirmed wrappers and projects current to the source', () => {
  const input = {
    current: { provider: 'vendor-vision', model: 'm', reasoningEffort: 'high' },
    status: 'ready',
    error: null,
    groups: [
      group('vendor', 'Vendor', ['m']),
      group('vendor-vision', 'Vendor + 自动识图', ['m']),
    ],
  }
  const { visibleDirectory } = applyDirectoryPlugin({
    ownershipApi: ownership([{ provider: 'vendor-vision', source: 'vendor' }]),
    input,
  })
  const visible = visibleDirectory.store.getSnapshot()

  assert.deepEqual(Array.from(visible.groups, (entry) => entry.id), ['vendor'])
  assert.equal(visible.current.provider, 'vendor')
  assert.equal(visible.current.model, 'm')
  assert.equal(visible.current.reasoningEffort, 'high')
})

test('issue #284 stock model picker fails open for an exact lookalike that Host ownership does not confirm', () => {
  const input = {
    current: { provider: 'vendor-vision', model: 'm' },
    status: 'ready',
    error: null,
    groups: [
      group('vendor', 'Vendor', ['m']),
      group('vendor-vision', 'Vendor + 自动识图', ['m']),
    ],
  }
  const { visibleDirectory } = applyDirectoryPlugin({ ownershipApi: ownership([]), input })

  assert.deepEqual(
    Array.from(visibleDirectory.store.getSnapshot().groups, (entry) => entry.id),
    ['vendor', 'vendor-vision'],
  )
  assert.equal(visibleDirectory.store.getSnapshot().current.provider, 'vendor-vision')
})

test('issue #284 transport-level select rejection becomes retryable without mutating the raw ModelDirectory store', async () => {
  let calls = 0
  let harness
  const input = {
    current: { provider: 'vendor', model: 'm' },
    status: 'ready',
    error: null,
    groups: [group('vendor', 'Vendor', ['m'])],
  }
  harness = applyDirectoryPlugin({
    ownershipApi: ownership([]),
    input,
    directoryOverrides: {
      select(selection) {
        calls += 1
        harness.setRaw({ ...harness.raw, status: 'selecting', error: null })
        if (calls === 1) return Promise.reject(new Error('connection reset'))
        harness.setRaw({ ...harness.raw, current: selection, status: 'ready', error: null })
        return Promise.resolve()
      },
    },
  })

  await assert.rejects(
    harness.visibleDirectory.select({ provider: 'vendor', model: 'm2' }),
    /connection reset/,
  )
  // Upstream remains stuck at selecting; the wrapper does not write into it.
  assert.equal(harness.raw.status, 'selecting')
  // Presentation recovers to a terminal retryable state with the real error.
  assert.equal(harness.visibleDirectory.store.getSnapshot().status, 'error')
  assert.match(harness.visibleDirectory.store.getSnapshot().error, /connection reset/)

  await harness.visibleDirectory.select({ provider: 'vendor', model: 'm2' })
  assert.equal(calls, 2)
  assert.equal(harness.visibleDirectory.store.getSnapshot().status, 'ready')
})

test('issue #284 identical same-frame selections share one in-flight RPC while different selections remain independent', async () => {
  const pending = []
  let calls = 0
  const input = {
    current: { provider: 'vendor', model: 'm' },
    status: 'ready',
    error: null,
    groups: [group('vendor', 'Vendor', ['m', 'a', 'b'])],
  }
  const harness = applyDirectoryPlugin({
    ownershipApi: ownership([]),
    input,
    directoryOverrides: {
      select(selection) {
        calls += 1
        return new Promise((resolve) => pending.push({ selection, resolve }))
      },
    },
  })

  const same = { provider: 'vendor', model: 'a' }
  const first = harness.visibleDirectory.select(same)
  const duplicate = harness.visibleDirectory.select({ ...same })
  await Promise.resolve()
  assert.equal(calls, 1)
  assert.equal(first, duplicate)

  const other = harness.visibleDirectory.select({ provider: 'vendor', model: 'b' })
  await Promise.resolve()
  assert.equal(calls, 2)
  pending[0].resolve()
  pending[1].resolve()
  await Promise.all([first, duplicate, other])
})

test('issue #284 reasoning-effort changes map back to the owned hidden wrapper, while a different model exits Vision mode', async () => {
  const selected = []
  const input = {
    current: { provider: 'vendor-vision', model: 'm', reasoningEffort: 'high' },
    status: 'ready',
    error: null,
    groups: [
      group('vendor', 'Vendor', ['m', 'other']),
      group('vendor-vision', 'Vendor + 自动识图', ['m', 'other']),
    ],
  }
  const harness = applyDirectoryPlugin({
    ownershipApi: ownership([{ provider: 'vendor-vision', source: 'vendor' }]),
    input,
    directoryOverrides: {
      select(selection) { selected.push(selection); return Promise.resolve() },
    },
  })

  await harness.visibleDirectory.select({ provider: 'vendor', model: 'm', reasoningEffort: 'low' })
  assert.equal(selected[0].provider, 'vendor-vision')
  assert.equal(selected[0].reasoningEffort, 'low')

  await harness.visibleDirectory.select({ provider: 'vendor', model: 'other' })
  assert.equal(selected[1].provider, 'vendor')
  assert.equal(selected[1].model, 'other')
})

test('issue #284 root boundary removes the legacy settingsScope hard dependency from the stock model-selection plugin', () => {
  let registered
  const loader = { load(spec) { registered = spec; return spec } }
  const context = vmContext(loader, ownership([]))
  vm.runInNewContext(VISION_CLIENT_ROOT_PRELUDE, context)
  vm.runInNewContext(VISION_MODEL_VISIBILITY_PRELUDE, context)

  loader.load({
    id: MODEL_TARGET,
    factory() {
      return { inject: ['modelDirectories'], apply() {} }
    },
  })
  const plugin = registered.factory(() => { throw new Error('unexpected require') })
  assert.deepEqual(Array.from(plugin.inject), ['modelDirectories'])
})

test('issue #284 hardened presentation patch reaches a brand-new loader returned by create()', () => {
  let registered
  const liveLoader = {
    load(spec) { registered = spec; return spec },
  }
  const queueLoader = {
    load(spec) { registered = spec; return spec },
    create() { return liveLoader },
  }
  const context = vmContext(queueLoader, ownership([]))
  vm.runInNewContext(VISION_CLIENT_ROOT_PRELUDE, context)
  vm.runInNewContext(HARDENED_CLIENT_PRESENTATION_PRELUDE, context)

  const result = context.window.__ModuleLoader__.create()
  assert.equal(result, liveLoader)
  assert.equal(result.load.__visionRouterPresentationBoundary, true)
  assert.equal(result.load.__visionRouterRootHardening, true)
})

test('issue #284 full global ModuleLoader replacement receives every registered client patch', () => {
  const initial = { load(spec) { return spec } }
  const context = vmContext(initial, ownership([]))
  vm.runInNewContext(VISION_CLIENT_ROOT_PRELUDE, context)
  vm.runInNewContext(HARDENED_CLIENT_PRESENTATION_PRELUDE, context)

  const replacement = { load(spec) { return spec } }
  context.window.__ModuleLoader__ = replacement
  assert.equal(replacement.load.__visionRouterRootHardening, true)
  assert.equal(replacement.load.__visionRouterPresentationBoundary, true)
})
