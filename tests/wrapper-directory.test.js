import test from 'node:test'
import assert from 'node:assert/strict'

import {
  installWrapperDirectoryAlias,
  resolveWrapperDirectoryEntry,
} from '../lib/wrapper-directory.js'

function fakeContext({
  visionConfig = {},
  liveProviders = [
    { id: 'deepseek-official', name: 'DeepSeek' },
    { id: 'deepseek-vision', name: 'DeepSeek + 自动识图' },
  ],
  configurableProviders = [
    {
      provider: 'deepseek-official',
      displayName: 'DeepSeek',
      settingsNs: 'llm-deepseek',
      settingsPath: [],
    },
  ],
  registerError,
} = {}) {
  const listeners = new Map()
  const disposals = []
  const warns = []
  const state = {
    visionConfig,
    liveProviders: [...liveProviders],
    sourceDirectory: configurableProviders.map((entry) => ({ ...entry })),
    ownedDirectory: [],
    registerCalls: 0,
    replaceCalls: 0,
  }

  const emit = (name, ...args) => {
    for (const listener of listeners.get(name) ?? []) listener(...args)
  }

  const llm = {
    listProviders() {
      return state.liveProviders.map((entry) => ({ ...entry }))
    },
    listConfigurableProviders() {
      return [
        ...state.sourceDirectory.map((entry) => ({ ...entry })),
        ...state.ownedDirectory.map((entry) => ({ ...entry })),
      ]
    },
    registerConfigurableProviders(entries) {
      state.registerCalls += 1
      if (registerError) throw registerError
      state.ownedDirectory = entries.map((entry) => ({ ...entry, settingsPath: [...entry.settingsPath] }))
      // rc.7 emits this notification from the directory commit itself. The
      // helper must not recurse into a second registration.
      emit('llm/adapters-updated')
      const handle = () => {
        state.ownedDirectory = []
        emit('llm/adapters-updated')
      }
      handle.replace = (next) => {
        state.replaceCalls += 1
        state.ownedDirectory = next.map((entry) => ({ ...entry, settingsPath: [...entry.settingsPath] }))
        emit('llm/adapters-updated')
      }
      return handle
    },
  }

  const ctx = {
    llm,
    get(name) {
      if (name !== 'settings') return undefined
      return {
        get(ns) {
          return ns === 'vision-router' ? state.visionConfig : undefined
        },
      }
    },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
    },
    effect(factory) {
      const cleanup = factory()
      disposals.push(cleanup)
      return () => {}
    },
    logger: { warn(message) { warns.push(message) } },
  }

  return {
    ctx,
    state,
    emit,
    warns,
    dispose() {
      for (const cleanup of disposals.splice(0)) cleanup()
    },
  }
}

test('resolves DeepSeek + auto-vision as an alias of the official provider settings', () => {
  const { ctx } = fakeContext()
  assert.deepEqual(resolveWrapperDirectoryEntry(ctx), {
    provider: 'deepseek-vision',
    displayName: 'DeepSeek + 自动识图',
    settingsNs: 'llm-deepseek',
    settingsPath: [],
  })
})

test('publishes the wrapper into the rc.7 configurable-provider directory exactly once', () => {
  const { ctx, state } = fakeContext()
  installWrapperDirectoryAlias(ctx)

  assert.equal(state.registerCalls, 1)
  assert.equal(state.replaceCalls, 0)
  assert.deepEqual(state.ownedDirectory, [
    {
      provider: 'deepseek-vision',
      displayName: 'DeepSeek + 自动识图',
      settingsNs: 'llm-deepseek',
      settingsPath: [],
    },
  ])
})

test('tracks a custom wrapper route but never aliases arbitrary textProvider settings', () => {
  const { ctx, state, emit } = fakeContext()
  installWrapperDirectoryAlias(ctx)

  state.visionConfig = {
    wrapperRoute: 'relay-auto-vision',
    textProvider: { provider: 'openrouter' },
  }
  state.liveProviders = [
    { id: 'deepseek-official', name: 'DeepSeek' },
    { id: 'openrouter', name: 'OpenRouter' },
    { id: 'relay-auto-vision', name: 'DeepSeek + 自动识图' },
  ]
  state.sourceDirectory.push({
    provider: 'openrouter',
    displayName: 'OpenRouter',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'openrouter'],
  })

  emit('settings/updated', 'vision-router', state.visionConfig, {}, 'update')

  assert.equal(state.registerCalls, 1)
  assert.equal(state.replaceCalls, 1)
  assert.deepEqual(state.ownedDirectory, [
    {
      provider: 'relay-auto-vision',
      displayName: 'DeepSeek + 自动识图',
      settingsNs: 'llm-deepseek',
      settingsPath: [],
    },
  ])
})

test('does not publish the DeepSeek-labelled wrapper when official DeepSeek has no settings address', () => {
  const { ctx, state } = fakeContext({
    visionConfig: { textProvider: { provider: 'openrouter' } },
    configurableProviders: [
      {
        provider: 'openrouter',
        displayName: 'OpenRouter',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'openrouter'],
      },
    ],
  })
  installWrapperDirectoryAlias(ctx)
  assert.equal(state.registerCalls, 0)
  assert.deepEqual(state.ownedDirectory, [])
})

test('does not publish a phantom Models row when the wrapper adapter is not live', () => {
  const { ctx, state } = fakeContext({
    liveProviders: [{ id: 'deepseek-official', name: 'DeepSeek' }],
  })
  installWrapperDirectoryAlias(ctx)
  assert.equal(state.registerCalls, 0)
  assert.deepEqual(state.ownedDirectory, [])
})

test('is a no-op on older LLM runtimes without the configurable-provider directory API', () => {
  const ctx = {
    llm: {
      listProviders: () => [],
    },
  }
  assert.doesNotThrow(() => installWrapperDirectoryAlias(ctx))
  assert.equal(resolveWrapperDirectoryEntry(ctx), undefined)
})

test('disposes the directory alias with the plugin fiber and stays inert afterwards', () => {
  const { ctx, state, emit, dispose } = fakeContext()
  installWrapperDirectoryAlias(ctx)
  assert.equal(state.registerCalls, 1)
  assert.equal(state.ownedDirectory.length, 1)

  dispose()
  assert.deepEqual(state.ownedDirectory, [])

  state.visionConfig = { wrapperRoute: 'relay-auto-vision' }
  state.liveProviders.push({ id: 'relay-auto-vision', name: 'DeepSeek + 自动识图' })
  emit('settings/updated', 'vision-router', state.visionConfig, {}, 'update')

  assert.equal(state.registerCalls, 1)
  assert.equal(state.replaceCalls, 0)
  assert.deepEqual(state.ownedDirectory, [])
})

test('re-registers cleanly after a fiber reload instead of freezing on the stale row', () => {
  const { ctx, state, dispose } = fakeContext()
  installWrapperDirectoryAlias(ctx)
  dispose()

  // Same context object, fresh install: the reloaded instance must see an
  // empty directory (the old row was disposed with the fiber) and publish.
  installWrapperDirectoryAlias(ctx)
  assert.equal(state.registerCalls, 2)
  assert.equal(state.ownedDirectory.length, 1)
  assert.equal(state.ownedDirectory[0].provider, 'deepseek-vision')
})

test('withdrawal records the empty-state key and skips redundant replaces', () => {
  const { ctx, state, emit } = fakeContext()
  installWrapperDirectoryAlias(ctx)
  assert.equal(state.ownedDirectory[0].provider, 'deepseek-vision')

  // An external owner takes over a NEW route the settings now point at.
  state.visionConfig = { wrapperRoute: 'relay-auto-vision' }
  state.liveProviders.push({ id: 'relay-auto-vision', name: 'DeepSeek + 自动识图' })
  state.sourceDirectory.push({
    provider: 'relay-auto-vision',
    displayName: 'External',
    settingsNs: 'external-ns',
    settingsPath: [],
  })
  emit('settings/updated', 'vision-router', state.visionConfig, {}, 'update')
  assert.equal(state.replaceCalls, 1)
  assert.deepEqual(state.ownedDirectory, [])

  // The wrapper disappears entirely: the cached empty-state key must make
  // this a no-op rather than a second redundant replace.
  state.liveProviders = []
  emit('llm/adapters-updated')
  assert.equal(state.replaceCalls, 1)
})

test('deduplicates identical sync warnings across repeated adapter events', () => {
  const error = new Error('already declared')
  error.code = 'DUPLICATE_DIRECTORY'
  const { ctx, emit, warns } = fakeContext({ registerError: error })
  installWrapperDirectoryAlias(ctx)
  emit('llm/adapters-updated')
  emit('llm/adapters-updated')

  assert.equal(warns.length, 1)
  assert.match(warns[0], /Models-directory alias sync failed/)
})
