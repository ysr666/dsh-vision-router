import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'

import { STRICT_LIVE_MODEL_CLIENT_PRELUDE } from '../lib/strict-live-model-client-prelude.js'

function rpc(value) {
  return { rpcId: 'test', result: { ok: true, value } }
}

function group(id, models) {
  return {
    id,
    name: id,
    models: models.map((model) => ({ id: model, name: model })),
  }
}

function active(provider) {
  return {
    provider,
    displayName: provider,
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', provider],
    active: true,
  }
}

async function runCatalog({ baseGroups, providerRows, liveProviders, providerDirectoryFails = false }) {
  let captured
  const loader = { load(spec) { captured = spec } }
  const sandbox = {
    window: { __ModuleLoader__: loader, prompt() { return '' } },
    fetch: async () => new Response(JSON.stringify({
      ok: true,
      version: 1,
      refreshing: false,
      providers: liveProviders,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    Response,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
  }
  vm.runInNewContext(STRICT_LIVE_MODEL_CLIENT_PRELUDE, sandbox)

  loader.load({
    id: 'dsh-vision-router',
    factory() {
      let activeCtx
      return {
        async apply(ctx) {
          activeCtx = ctx
          // wrapContext() starts live discovery before invoking the real apply.
          // Let that one fetch settle so this call observes the final snapshot.
          await new Promise((resolve) => setTimeout(resolve, 0))
          return activeCtx.get('connection').api.llm.models({})
        },
      }
    },
  })

  const exported = captured.factory(() => {})
  const ctx = {
    remote: { $on() { return () => {} } },
    get(name) {
      if (name !== 'connection') return undefined
      return {
        api: {
          llm: {
            async models() {
              return rpc({ groups: structuredClone(baseGroups), failures: [] })
            },
            async providers() {
              if (providerDirectoryFails) throw new Error('provider directory offline')
              return rpc({ providers: structuredClone(providerRows) })
            },
          },
        },
      }
    },
    effect(factory) {
      const disposer = factory()
      if (typeof disposer === 'function') this.dispose = disposer
    },
  }

  try {
    return await exported.apply(ctx)
  } finally {
    if (typeof ctx.dispose === 'function') ctx.dispose()
  }
}

function valueOf(body) {
  return body.result.value
}

function ids(body, provider) {
  const found = valueOf(body).groups.find((entry) => entry.id === provider)
  return found ? found.models.map((model) => model.id) : []
}

test('Settings -> Models wins over endpoint /models when DSH already enumerates the provider', async () => {
  const body = await runCatalog({
    baseGroups: [group('zai', ['glm-a', 'glm-b', 'glm-c'])],
    providerRows: [active('zai')],
    liveProviders: [{
      provider: 'zai',
      discoveredAt: Date.now(),
      stale: false,
      live: true,
      models: [
        { id: 'glm-a' },
        { id: 'glm-b' },
        { id: 'glm-c' },
        { id: 'glm-disabled-1' },
        { id: 'glm-disabled-2' },
      ],
    }],
  })

  assert.deepEqual(ids(body, 'zai'), ['glm-a', 'glm-b', 'glm-c'])
})

test('endpoint /models fills an active provider only when DSH has no enumerated models', async () => {
  const body = await runCatalog({
    baseGroups: [group('zai', [])],
    providerRows: [active('zai')],
    liveProviders: [{
      provider: 'zai',
      discoveredAt: Date.now(),
      stale: false,
      live: true,
      models: [{ id: 'glm-live-a' }, { id: 'glm-live-b' }],
    }],
  })

  assert.deepEqual(ids(body, 'zai'), ['glm-live-a', 'glm-live-b'])
  const zai = valueOf(body).groups.find((entry) => entry.id === 'zai')
  assert.equal(zai.models.every((model) => model.visionRouterLiveDiscovered === true), true)
})

test('a stale live-cache provider cannot recreate a provider removed from DSH settings', async () => {
  const body = await runCatalog({
    baseGroups: [group('deepseek-official', ['deepseek-v4-pro'])],
    providerRows: [active('deepseek-official')],
    liveProviders: [{
      provider: 'removed-provider',
      discoveredAt: Date.now() - 60_000,
      stale: true,
      live: false,
      models: [{ id: 'ghost-model' }],
    }],
  })

  assert.equal(valueOf(body).groups.some((entry) => entry.id === 'removed-provider'), false)
})

test('live fallback stays fail-soft when provider directory is unavailable but llm.models still has the provider', async () => {
  const body = await runCatalog({
    baseGroups: [group('zai', [])],
    providerRows: [],
    providerDirectoryFails: true,
    liveProviders: [{
      provider: 'zai',
      discoveredAt: Date.now(),
      stale: true,
      live: false,
      models: [{ id: 'glm-stale-but-configured' }],
    }],
  })

  assert.deepEqual(ids(body, 'zai'), ['glm-stale-but-configured'])
})
