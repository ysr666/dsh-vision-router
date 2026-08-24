import test from 'node:test'
import assert from 'node:assert/strict'

import {
  contextWithVisionRouteOwnership,
  createVisionRouteOwnership,
} from '../lib/vision-route-ownership.js'
import { resolveWrapperDirectoryEntry } from '../lib/wrapper-directory.js'

function registrationHandle(onDispose = () => {}) {
  const handle = () => onDispose()
  handle.replace = () => {}
  return handle
}

function fakeLlm(initial = []) {
  const adapters = new Map(initial.map(([route, adapter]) => [route, adapter]))
  const configurable = [{
    provider: 'deepseek-official',
    displayName: 'DeepSeek',
    settingsNs: 'llm-deepseek',
    settingsPath: [],
  }]
  return {
    adapters,
    registration(route) {
      const adapter = adapters.get(route)
      if (!adapter) {
        const error = new Error(`no adapter ${route}`)
        error.code = 'NO_ADAPTER'
        throw error
      }
      return { adapter }
    },
    listProviders() {
      return [...adapters.entries()].map(([id, adapter]) => ({
        id,
        name: adapter?.providerInfo?.(id)?.name ?? id,
      }))
    },
    listConfigurableProviders() {
      return configurable.slice()
    },
    registerAdapter(routes, adapter) {
      if (routes.some((route) => adapters.has(route))) {
        const error = new Error('duplicate')
        error.code = 'DUPLICATE_ADAPTER'
        throw error
      }
      for (const route of routes) adapters.set(route, adapter)
      return registrationHandle(() => {
        for (const route of routes) {
          if (adapters.get(route) === adapter) adapters.delete(route)
        }
      })
    },
  }
}

function settingsService(value) {
  return {
    get(namespace) {
      return namespace === 'vision-router' ? value : undefined
    },
  }
}

function context(llm, config) {
  const settings = settingsService(config)
  return {
    llm,
    settings,
    get(name) {
      if (name === 'llm') return llm
      if (name === 'settings') return settings
      return undefined
    },
  }
}

const mainWrapper = {
  providerInfo(provider) {
    return { id: provider, name: 'DeepSeek + 自动识图' }
  },
}

const genericWrapper = {
  providerInfo(provider) {
    return { id: provider, name: 'OpenCode Go + 自动识图' }
  },
}

test('issue #284 ownership is created only by a successful registration through this plugin context', () => {
  const llm = fakeLlm()
  const config = { wrapperRoute: 'deepseek-vision', chainRoute: 'vision-chain' }
  const ownership = createVisionRouteOwnership()
  const wrapped = contextWithVisionRouteOwnership(context(llm, config), config, ownership)

  assert.equal(ownership.sourceFor('deepseek-vision'), undefined)
  const handle = wrapped.ctx.llm.registerAdapter(['deepseek-vision'], mainWrapper)
  assert.equal(ownership.sourceFor('deepseek-vision'), 'deepseek-official')
  assert.equal(ownership.owns('deepseek-vision'), true)

  handle()
  assert.equal(ownership.sourceFor('deepseek-vision'), undefined)
  assert.equal(ownership.owns('deepseek-vision'), false)
})

test('issue #284 generic twin ownership records the exact source only after host commit', () => {
  const llm = fakeLlm()
  const config = { wrapperRoute: 'deepseek-vision' }
  const ownership = createVisionRouteOwnership()
  const wrapped = contextWithVisionRouteOwnership(context(llm, config), config, ownership)

  const handle = wrapped.ctx.llm.registerAdapter(['opencode-go-vision'], genericWrapper)
  assert.equal(ownership.sourceFor('opencode-go-vision'), 'opencode-go')
  handle()
  assert.equal(ownership.sourceFor('opencode-go-vision'), undefined)
})

test('issue #284 an exact third-party wrapper collision is never adopted as Vision Router ownership', () => {
  const impostor = {
    providerInfo(provider) {
      return { id: provider, name: 'DeepSeek + 自动识图' }
    },
  }
  const llm = fakeLlm([['deepseek-vision', impostor]])
  const config = { wrapperRoute: 'deepseek-vision', chainRoute: 'vision-chain' }
  const ownership = createVisionRouteOwnership()
  const wrapped = contextWithVisionRouteOwnership(context(llm, config), config, ownership)

  // The legacy core sees the conflicting wrapper disabled instead of entering
  // its historical DUPLICATE_ADAPTER -> "adopt" branch.
  assert.equal(wrapped.config.wrapperRoute, '')
  assert.equal(wrapped.ctx.settings.get('vision-router').wrapperRoute, '')
  assert.equal(wrapped.ctx.get('settings').get('vision-router').wrapperRoute, '')
  assert.equal(ownership.sourceFor('deepseek-vision'), undefined)
})

test('issue #284 collision projection heals automatically when the external route disappears', () => {
  const impostor = { providerInfo: (provider) => ({ id: provider, name: 'DeepSeek + 自动识图' }) }
  const llm = fakeLlm([['deepseek-vision', impostor]])
  const config = { wrapperRoute: 'deepseek-vision' }
  const ownership = createVisionRouteOwnership()
  const wrapped = contextWithVisionRouteOwnership(context(llm, config), config, ownership)

  assert.equal(wrapped.ctx.settings.get('vision-router').wrapperRoute, '')
  llm.adapters.delete('deepseek-vision')
  assert.equal(wrapped.ctx.settings.get('vision-router').wrapperRoute, 'deepseek-vision')
})

test('issue #284 Models alias requires Host-confirmed main-wrapper ownership when an oracle is supplied', () => {
  const llm = fakeLlm([
    ['deepseek-official', { providerInfo: (provider) => ({ id: provider, name: 'DeepSeek' }) }],
    ['deepseek-vision', mainWrapper],
  ])
  const ctx = context(llm, { wrapperRoute: 'deepseek-vision' })
  const ownership = createVisionRouteOwnership()

  assert.equal(resolveWrapperDirectoryEntry(ctx, {}, { ownership }), undefined)

  ownership.track(
    ['deepseek-vision'],
    mainWrapper,
    registrationHandle(),
    { wrapperRoute: 'deepseek-vision' },
  )
  const entry = resolveWrapperDirectoryEntry(ctx, {}, { ownership })
  assert.equal(entry?.provider, 'deepseek-vision')
  assert.equal(entry?.settingsNs, 'llm-deepseek')
})
