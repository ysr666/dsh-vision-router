import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import {
  VISION_MODEL_VISIBILITY_PRELUDE,
  projectVisionModeDirectoryState,
} from '../lib/vision-model-visibility-boundary.js'

const MODEL_SELECTION_TARGET = '@deepseek-ai/dsh-client-ui-model-selection'

function model(id, name = id) {
  return { id, name }
}

function group(id, name, modelIds) {
  return { id, name, models: modelIds.map((id) => model(id)) }
}

function state({ current, groups, status = 'ready', error = null, failures = [], routable = true }) {
  return { current, groups, status, error, failures, routable }
}

function ids(groups) {
  return groups.map((entry) => entry.id)
}

test('issue #284 hides an intended generated twin while projecting active current back to the source model', () => {
  const input = state({
    current: { provider: 'opencode-go-vision', model: 'qwen3.6-plus', reasoningEffort: 'high' },
    groups: [
      group('opencode-go', 'OpenCode Go', ['qwen3.6-plus']),
      group('opencode-go-vision', 'OpenCode Go + 自动识图', ['qwen3.6-plus']),
    ],
  })
  const output = projectVisionModeDirectoryState(input, { autoWrapProviders: true, wrapperRoute: 'deepseek-vision' })

  assert.deepEqual(ids(output.groups), ['opencode-go'])
  assert.equal(output.current?.provider, 'opencode-go')
  assert.equal(output.current?.model, 'qwen3.6-plus')
  assert.equal(output.current?.reasoningEffort, 'high')
})

test('issue #284 hides the configured DeepSeek wrapper and projects it to deepseek-official', () => {
  const input = state({
    current: { provider: 'deepseek-vision', model: 'deepseek-v4-pro' },
    groups: [
      group('deepseek-official', 'DeepSeek', ['deepseek-v4-pro']),
      group('deepseek-vision', 'DeepSeek + 自动识图', ['deepseek-v4-pro']),
    ],
  })
  const output = projectVisionModeDirectoryState(input, { autoWrapProviders: true, wrapperRoute: 'deepseek-vision' })

  assert.deepEqual(ids(output.groups), ['deepseek-official'])
  assert.equal(output.current?.provider, 'deepseek-official')
  assert.equal(output.current?.model, 'deepseek-v4-pro')
})

test('issue #284 hides a custom configured wrapper route without requiring a -vision suffix', () => {
  const input = state({
    current: { provider: 'relay-auto-vision', model: 'deepseek-v4-flash' },
    groups: [
      group('deepseek-official', 'DeepSeek', ['deepseek-v4-flash']),
      group('relay-auto-vision', 'DeepSeek + 自动识图', ['deepseek-v4-flash']),
    ],
  })
  const output = projectVisionModeDirectoryState(input, { wrapperRoute: 'relay-auto-vision' })

  assert.deepEqual(ids(output.groups), ['deepseek-official'])
  assert.equal(output.current?.provider, 'deepseek-official')
})

test('issue #284 fails open when browser settings are unavailable', () => {
  const input = state({
    current: { provider: 'opencode-go-vision', model: 'qwen3.6-plus' },
    groups: [
      group('opencode-go', 'OpenCode Go', ['qwen3.6-plus']),
      group('opencode-go-vision', 'OpenCode Go + 自动识图', ['qwen3.6-plus']),
    ],
  })
  const output = projectVisionModeDirectoryState(input, undefined)

  assert.deepEqual(ids(output.groups), ['opencode-go', 'opencode-go-vision'])
  assert.equal(output.current?.provider, 'opencode-go-vision')
})

test('issue #284 never hides a third-party -vision lookalike that does not satisfy the exact generated-twin contract', () => {
  const input = state({
    current: { provider: 'vendor-vision', model: 'm' },
    groups: [
      group('vendor', 'Vendor', ['m']),
      group('vendor-vision', 'Vendor Vision Pro', ['m']),
    ],
  })
  const output = projectVisionModeDirectoryState(input, { autoWrapProviders: true })

  assert.deepEqual(ids(output.groups), ['vendor', 'vendor-vision'])
  assert.equal(output.current?.provider, 'vendor-vision')
})

test('issue #284 does not hide a generated-looking twin when auto wrapping is off and the source/model is not explicitly wrapped', () => {
  const input = state({
    current: { provider: 'vendor-vision', model: 'm' },
    groups: [
      group('vendor', 'Vendor', ['m']),
      group('vendor-vision', 'Vendor + 自动识图', ['m']),
    ],
  })
  const output = projectVisionModeDirectoryState(input, { autoWrapProviders: false, wrappedProviders: [] })

  assert.deepEqual(ids(output.groups), ['vendor', 'vendor-vision'])
  assert.equal(output.current?.provider, 'vendor-vision')
})

test('issue #284 fails open for a partially mirrored wrapper group instead of hiding unrelated catalog rows', () => {
  const input = state({
    current: { provider: 'vendor', model: 'safe' },
    groups: [
      group('vendor', 'Vendor', ['safe']),
      group('vendor-vision', 'Vendor + 自动识图', ['safe', 'foreign-only']),
    ],
  })
  const output = projectVisionModeDirectoryState(input, { autoWrapProviders: true })

  assert.deepEqual(ids(output.groups), ['vendor', 'vendor-vision'])
})

test('issue #284 preserves directory lifecycle and error surfaces while filtering presentation-only groups', () => {
  const failures = [{ id: 'broken', name: 'Broken provider', message: 'catalog failed' }]
  const input = state({
    current: { provider: 'vendor', model: 'm' },
    groups: [
      group('vendor', 'Vendor', ['m']),
      group('vendor-vision', 'Vendor + 自动识图', ['m']),
    ],
    status: 'error',
    error: 'network down',
    failures,
    routable: false,
  })
  const output = projectVisionModeDirectoryState(input, { autoWrapProviders: true })

  assert.equal(output.status, 'error')
  assert.equal(output.error, 'network down')
  assert.equal(output.routable, false)
  assert.equal(output.failures, failures)
})

function visibilityPluginHarness(input, config) {
  const selected = []
  const listeners = new Set()
  const directory = {
    store: {
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      getSnapshot() { return input },
    },
    async load() { return input },
    async select(selection) { selected.push(selection) },
  }
  const models = { directoryFor() { return directory } }
  const settings = {
    subscribe() { return () => {} },
    getSnapshot() { return { value: config } },
  }

  let registered
  const loader = {
    load(spec) { registered = spec; return spec },
  }
  const context = {
    window: { __ModuleLoader__: loader },
    Object,
    Promise,
    Array,
    String,
    Map,
    Set,
    WeakMap,
    Math,
    JSON,
    setTimeout() { return 1 },
    clearTimeout() {},
  }
  vm.runInNewContext(VISION_MODEL_VISIBILITY_PRELUDE, context)

  let visibleDirectory
  loader.load({
    id: MODEL_SELECTION_TARGET,
    factory() {
      return {
        apply(ctx) {
          ctx.inject(['modelDirectories'], (scope) => {
            visibleDirectory = scope.modelDirectories.directoryFor('session-1')
          })
        },
      }
    },
  })

  assert.equal(typeof registered?.factory, 'function')
  const plugin = registered.factory(() => { throw new Error('model-selection projection should not require host values') })
  const ctx = {
    settingsScope: { bind() { return settings } },
    inject(_deps, callback) {
      callback({
        modelDirectories: models,
        get(name) { return name === 'modelDirectories' ? models : undefined },
      })
    },
  }
  plugin.apply(ctx)
  return { visibleDirectory, selected }
}

test('issue #284 model-selection plugin receives the filtered presentation directory, not the raw Vision Router route', () => {
  const input = state({
    current: { provider: 'opencode-go-vision', model: 'qwen3.6-plus', reasoningEffort: 'high' },
    groups: [
      group('opencode-go', 'OpenCode Go', ['qwen3.6-plus']),
      group('opencode-go-vision', 'OpenCode Go + 自动识图', ['qwen3.6-plus']),
    ],
  })
  const { visibleDirectory } = visibilityPluginHarness(input, {
    autoWrapProviders: true,
    wrapperRoute: 'deepseek-vision',
  })
  const visible = visibleDirectory.store.getSnapshot()

  assert.deepEqual(ids(visible.groups), ['opencode-go'])
  assert.equal(visible.current?.provider, 'opencode-go')
  assert.equal(visible.current?.reasoningEffort, 'high')
})

test('issue #284 changing only reasoning effort while Vision is on keeps the hidden wrapper route active', async () => {
  const input = state({
    current: { provider: 'opencode-go-vision', model: 'qwen3.6-plus', reasoningEffort: 'high' },
    groups: [
      group('opencode-go', 'OpenCode Go', ['qwen3.6-plus', 'other-model']),
      group('opencode-go-vision', 'OpenCode Go + 自动识图', ['qwen3.6-plus', 'other-model']),
    ],
  })
  const { visibleDirectory, selected } = visibilityPluginHarness(input, {
    autoWrapProviders: true,
    wrapperRoute: 'deepseek-vision',
  })

  await visibleDirectory.select({
    provider: 'opencode-go',
    model: 'qwen3.6-plus',
    reasoningEffort: 'low',
  })
  assert.equal(selected.length, 1)
  assert.equal(selected[0].provider, 'opencode-go-vision')
  assert.equal(selected[0].model, 'qwen3.6-plus')
  assert.equal(selected[0].reasoningEffort, 'low')
})

test('issue #284 selecting a different ordinary model while Vision is on leaves the wrapper and turns Vision off', async () => {
  const input = state({
    current: { provider: 'opencode-go-vision', model: 'qwen3.6-plus', reasoningEffort: 'high' },
    groups: [
      group('opencode-go', 'OpenCode Go', ['qwen3.6-plus', 'other-model']),
      group('opencode-go-vision', 'OpenCode Go + 自动识图', ['qwen3.6-plus', 'other-model']),
    ],
  })
  const { visibleDirectory, selected } = visibilityPluginHarness(input, {
    autoWrapProviders: true,
    wrapperRoute: 'deepseek-vision',
  })

  await visibleDirectory.select({ provider: 'opencode-go', model: 'other-model' })
  assert.equal(selected.length, 1)
  assert.equal(selected[0].provider, 'opencode-go')
  assert.equal(selected[0].model, 'other-model')
})
