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
} = {}) {
  const listeners = new Map()
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
    logger: { warn() {} },
  }

  return { ctx, state, emit }
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

test('tracks live wrapper/text-provider settings and mirrors the new source settings path', () => {
  const { ctx, state, emit } = fakeContext()
  installWrapperDirectoryAlias(ctx)

  state.visionConfig = {
    wrapperRoute: 'relay-auto-vision',
    textProvider: { provider: 'openrouter' },
  }
  state.liveProviders = [
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
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openrouter'],
    },
  ])
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
