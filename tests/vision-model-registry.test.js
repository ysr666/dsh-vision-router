import assert from 'node:assert/strict'
import test from 'node:test'

import {
  configuredVisionPairs,
  decorateVisionModelSnapshot,
  installVisionModelRegistry,
  isProviderActive,
} from '../lib/vision-model-registry.js'

function fakeContext({ visionSettings, active = [], piProviders } = {}) {
  const activeSet = new Set(active)
  const settings = {
    get(namespace) {
      if (namespace === 'vision-router') return visionSettings
      if (namespace === 'llm-pi-ai') return piProviders === undefined ? undefined : { providers: piProviders }
      return undefined
    },
  }
  const effects = []
  return {
    effects,
    ctx: {
      get(name) {
        return name === 'settings' ? settings : undefined
      },
      llm: {
        registration(provider) {
          if (!activeSet.has(provider)) throw new Error(`unknown provider: ${provider}`)
          return { provider: { id: provider } }
        },
      },
      effect(factory) {
        const dispose = factory()
        effects.push(dispose)
        return dispose
      },
    },
  }
}

test('configuredVisionPairs prefers current Host settings and mirrors multi-provider fallback precedence', () => {
  const { ctx } = fakeContext({
    visionSettings: {
      providers: [
        { provider: 'zhipu', model: 'glm-4.6v', fallbacks: ['glm-flash', 'glm-flash'] },
        { provider: 'vision-http', model: 'builtin', fallbacks: [] },
        { provider: 'custom-vision', model: 'generated', fallbacks: [] },
      ],
      provider: 'legacy-provider',
      model: 'legacy-model',
      wrapperRoute: 'deepseek-vision',
      chainRoute: 'vision-chain',
    },
  })
  const fallbackConfig = {
    providers: [{ provider: 'boot-only', model: 'stale-model', fallbacks: [] }],
  }

  assert.deepEqual(configuredVisionPairs(ctx, fallbackConfig), [
    { provider: 'zhipu', model: 'glm-4.6v' },
    { provider: 'zhipu', model: 'glm-flash' },
  ])
})

test('configuredVisionPairs keeps legacy shorthand only when the multi-provider form is empty', () => {
  const { ctx } = fakeContext({
    visionSettings: {
      providers: [],
      provider: 'legacy-provider',
      model: 'legacy-model',
      fallbacks: ['legacy-fallback'],
    },
  })
  assert.deepEqual(configuredVisionPairs(ctx), [
    { provider: 'legacy-provider', model: 'legacy-model' },
    { provider: 'legacy-provider', model: 'legacy-fallback' },
  ])
})

test('provider activity is a structural registry fact, not inferred from settings', () => {
  const { ctx } = fakeContext({ active: ['zhipu'] })
  assert.equal(isProviderActive(ctx, 'zhipu'), true)
  assert.equal(isProviderActive(ctx, 'removed-provider'), false)
})

test('registry decorates live/cached sources and preserves saved ids under active providers', () => {
  const { ctx } = fakeContext({
    active: ['zhipu', 'private-gateway'],
    visionSettings: {
      providers: [
        { provider: 'zhipu', model: 'glm-flash', fallbacks: [] },
        { provider: 'private-gateway', model: 'future-vl', fallbacks: [] },
        { provider: 'removed-provider', model: 'ghost', fallbacks: [] },
      ],
    },
  })
  const snapshot = decorateVisionModelSnapshot({
    ok: true,
    version: 7,
    refreshing: false,
    providers: [
      {
        provider: 'zhipu',
        discoveredAt: 123,
        stale: false,
        models: [
          { id: 'glm-4.6v', name: 'GLM 4.6V' },
          { id: 'glm-flash' },
        ],
      },
      {
        provider: 'cached-provider',
        discoveredAt: 50,
        stale: true,
        models: [{ id: 'cached-vl' }],
      },
    ],
  }, { ctx })

  const zhipu = snapshot.providers.find((entry) => entry.provider === 'zhipu')
  assert.deepEqual(zhipu.models, [
    { id: 'glm-4.6v', name: 'GLM 4.6V [live]', visionRouterSource: 'live' },
    { id: 'glm-flash', name: 'glm-flash [live]', visionRouterSource: 'live' },
  ])

  const cached = snapshot.providers.find((entry) => entry.provider === 'cached-provider')
  assert.equal(cached.models[0].name, 'cached-vl [cached]')
  assert.equal(cached.models[0].visionRouterSource, 'cached')

  const configured = snapshot.providers.find((entry) => entry.provider === 'private-gateway')
  assert.deepEqual(configured.models, [
    { id: 'future-vl', name: 'future-vl [saved]', visionRouterSource: 'configured' },
  ])
  assert.equal(configured.configuredOnly, true)

  assert.equal(snapshot.providers.some((entry) => entry.provider === 'removed-provider'), false)
  assert.deepEqual(snapshot.registry, {
    revision: 2,
    configuredCount: 3,
    activeConfiguredCount: 2,
    trustedHintCount: 0,
    sources: ['dsh-catalog', 'provider-live', 'trusted-vision-hints', 'saved-compat'],
  })
})

test('trusted official BigModel endpoint contributes known visual models omitted by /models', () => {
  const { ctx } = fakeContext({
    active: ['zhipu-glm'],
    piProviders: {
      'zhipu-glm': {
        baseURL: 'https://open.bigmodel.cn/api/paas/v4',
        api: 'openai-completions',
        apiKeyEnv: 'ZHIPU_GLM_API_KEY',
      },
    },
  })
  const snapshot = decorateVisionModelSnapshot({
    ok: true,
    version: 1,
    refreshing: false,
    providers: [{
      provider: 'zhipu-glm',
      discoveredAt: 123,
      stale: false,
      models: [
        { id: 'glm-4.5' },
        { id: 'glm-4.6' },
      ],
    }],
  }, { ctx })

  const zhipu = snapshot.providers.find((entry) => entry.provider === 'zhipu-glm')
  const flash = zhipu.models.find((model) => model.id === 'glm-4.6v-flash')
  assert.equal(flash.name, 'GLM-4.6V-Flash [known]')
  assert.equal(flash.visionRouterSource, 'known')
  assert.equal(flash.visionRouterTrustedHint, true)
  assert.equal(snapshot.registry.trustedHintCount >= 2, true)
})

test('saved membership changes the browser invalidation version without changing live evidence', () => {
  const state = {
    providers: [{ provider: 'zhipu', model: 'one', fallbacks: [] }],
  }
  const { ctx } = fakeContext({ active: ['zhipu'], visionSettings: state })
  const base = {
    ok: true,
    version: 3,
    refreshing: false,
    providers: [{ provider: 'zhipu', discoveredAt: 100, stale: false, models: [] }],
  }
  const first = decorateVisionModelSnapshot(base, { ctx })
  state.providers = [{ provider: 'zhipu', model: 'two', fallbacks: [] }]
  const second = decorateVisionModelSnapshot(base, { ctx })

  assert.notEqual(first.version, second.version)
  assert.equal(first.providers[0].models[0].id, 'one')
  assert.equal(second.providers[0].models[0].id, 'two')
})

test('installVisionModelRegistry preserves raw live evidence and adds only endpoint-scoped trusted evidence', async () => {
  const { ctx, effects } = fakeContext({
    active: ['zhipu-glm'],
    visionSettings: { providers: [{ provider: 'zhipu-glm', model: 'saved-vl', fallbacks: [] }] },
    piProviders: {
      'zhipu-glm': {
        baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
        api: 'openai-completions',
      },
    },
  })
  let rawCalls = 0
  const manager = {
    async snapshot() {
      rawCalls += 1
      return { ok: true, version: 1, refreshing: false, providers: [] }
    },
    hasModel(provider, model) {
      return provider === 'zhipu-glm' && model === 'live-only'
    },
  }
  installVisionModelRegistry(ctx, manager)

  const decorated = await manager.snapshot({ schedule: false })
  assert.equal(rawCalls, 1)
  const provider = decorated.providers.find((entry) => entry.provider === 'zhipu-glm')
  assert.equal(provider.models.some((model) => model.id === 'saved-vl'), true)
  assert.equal(provider.models.some((model) => model.id === 'glm-4.6v-flash'), true)

  assert.equal(manager.hasModel('zhipu-glm', 'live-only'), true)
  assert.equal(manager.hasModel('zhipu-glm', 'glm-4.6v-flash'), true)
  assert.equal(manager.hasModel('zhipu-glm', 'saved-vl'), false)
  assert.equal(manager.hasModel('zhipu-glm', 'made-up-model'), false)

  assert.equal(typeof effects[0], 'function')
  effects[0]()
  assert.equal(manager.snapshot.__visionRouterRegistry, undefined)
  const raw = await manager.snapshot()
  assert.deepEqual(raw, { ok: true, version: 1, refreshing: false, providers: [] })
})

test('trusted hints do not authorize a proxy, subdomain, or lookalike endpoint', () => {
  for (const baseURL of [
    'https://proxy.example/v1',
    'https://evil.open.bigmodel.cn/api/paas/v4',
    'http://open.bigmodel.cn/api/paas/v4',
    'https://open.bigmodel.cn/api/coding/paas/v4',
  ]) {
    const { ctx } = fakeContext({
      active: ['zhipu-glm'],
      piProviders: {
        'zhipu-glm': { baseURL, api: 'openai-completions' },
      },
    })
    const manager = {
      async snapshot() { return { ok: true, version: 1, refreshing: false, providers: [] } },
      hasModel() { return false },
    }
    installVisionModelRegistry(ctx, manager)
    assert.equal(manager.hasModel('zhipu-glm', 'glm-4.6v-flash'), false, baseURL)
  }
})
