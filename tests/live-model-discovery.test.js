import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import {
  createLiveModelDiscoveryManager,
  liveModelCachePath,
  normalizeOpenAIModelListing,
  routeFingerprint,
} from '../lib/live-model-discovery.js'
import {
  injectLiveModelClientPrelude,
  LIVE_MODEL_CLIENT_PRELUDE,
} from '../lib/live-model-client-prelude.js'

async function waitForProvider(manager, provider, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await manager.snapshot()
    const hit = snapshot.providers.find((entry) => entry.provider === provider)
    if (hit) return hit
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for live provider ${provider}`)
}

function fakeDiscoveryContext() {
  const settings = {
    get(namespace) {
      if (namespace === 'llm-pi-ai') {
        return {
          providers: {
            zai: {
              baseURL: 'https://open.bigmodel.example/api/paas/v4',
              api: 'openai-completions',
              apiKeyEnv: 'ZAI_API_KEY',
            },
          },
        }
      }
      if (namespace === 'vision-router') {
        return { providers: [{ provider: 'zai', model: 'glm-4v-flash', fallbacks: [] }] }
      }
      return undefined
    },
  }
  const credentials = {
    async resolve(ref) {
      assert.equal(ref, 'ZAI_API_KEY')
      return { value: 'super-secret-live-discovery-key' }
    },
  }
  return {
    llm: { registration() { return undefined } },
    get(name) {
      if (name === 'settings') return settings
      if (name === 'credentials') return credentials
      return undefined
    },
  }
}

test('OpenAI-compatible listing normalization proves existence only and de-duplicates ids', () => {
  assert.deepEqual(
    normalizeOpenAIModelListing({
      data: [
        { id: 'glm-4v-flash', name: 'GLM-4V-Flash' },
        { id: 'glm-4v-flash', name: 'duplicate' },
        { id: 'glm-4.6v-flash', display_name: 'GLM-4.6V-Flash' },
        { id: '' },
        null,
      ],
    }),
    [
      { id: 'glm-4v-flash', name: 'GLM-4V-Flash' },
      { id: 'glm-4.6v-flash', name: 'GLM-4.6V-Flash' },
    ],
  )
  assert.throws(
    () => normalizeOpenAIModelListing({ models: [] }),
    (error) => error && error.code === 'LIVE_MODEL_LISTING_INVALID',
  )
})

test('route fingerprint changes with endpoint, protocol, or credential fingerprint', () => {
  const base = {
    provider: 'zai',
    baseURL: 'https://example.test/v1',
    api: 'openai-completions',
    credentialFingerprint: 'a',
  }
  assert.equal(routeFingerprint(base), routeFingerprint({ ...base }))
  assert.notEqual(routeFingerprint(base), routeFingerprint({ ...base, credentialFingerprint: 'b' }))
  assert.notEqual(routeFingerprint(base), routeFingerprint({ ...base, baseURL: 'https://other.test/v1' }))
})

test('Host discovery uses configured transport/credential, persists a secret-free stale-while-revalidate cache', async () => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'vision-router-live-models-'))
  const calls = []
  try {
    const ctx = fakeDiscoveryContext()
    const manager = createLiveModelDiscoveryManager(ctx, {
      dshHome,
      timeoutMs: 1000,
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), authorization: options?.headers?.authorization })
        return new Response(JSON.stringify({
          data: [
            { id: 'glm-4v-flash', name: 'GLM-4V-Flash' },
            { id: 'glm-4.6v-flash' },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await manager.ready()
    manager.queueConfigured()
    const live = await waitForProvider(manager, 'zai')
    assert.deepEqual(live.models, [
      { id: 'glm-4v-flash', name: 'GLM-4V-Flash' },
      { id: 'glm-4.6v-flash' },
    ])
    assert.equal(manager.hasModel('zai', 'glm-4v-flash'), true)
    assert.equal(manager.hasModel('zai', 'missing-model'), false)
    assert.deepEqual(calls, [{
      url: 'https://open.bigmodel.example/api/paas/v4/models',
      authorization: 'Bearer super-secret-live-discovery-key',
    }])
    await manager.dispose()

    const cacheText = await readFile(liveModelCachePath(dshHome), 'utf8')
    assert.equal(cacheText.includes('super-secret-live-discovery-key'), false)
    assert.match(cacheText, /glm-4v-flash/)

    // A new process/page gets the last successful list immediately even if the
    // endpoint is currently unavailable; refresh failure must not blank it.
    const cachedManager = createLiveModelDiscoveryManager(ctx, {
      dshHome,
      timeoutMs: 500,
      fetchImpl: async () => { throw new Error('offline') },
    })
    await cachedManager.ready()
    const cached = await cachedManager.snapshot()
    assert.equal(cached.providers[0].provider, 'zai')
    assert.equal(cached.providers[0].models.some((model) => model.id === 'glm-4v-flash'), true)
    assert.equal(cachedManager.hasModel('zai', 'glm-4v-flash'), true)
    await cachedManager.dispose()
  } finally {
    await rm(dshHome, { recursive: true, force: true })
  }
})

test('client prelude wraps only Vision Router and appends live-only models without inventing image metadata', async () => {
  let captured
  const loader = {
    load(spec) {
      captured = spec
    },
  }
  const liveSnapshot = {
    ok: true,
    version: 1,
    refreshing: false,
    providers: [{
      provider: 'zai',
      discoveredAt: Date.now(),
      stale: false,
      models: [
        { id: 'glm-base', name: 'duplicate base' },
        { id: 'glm-4v-flash', name: 'GLM-4V-Flash' },
      ],
    }],
  }
  const sandbox = {
    window: {},
    fetch: async () => new Response(JSON.stringify(liveSnapshot), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    Response,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
  }
  vm.runInNewContext(LIVE_MODEL_CLIENT_PRELUDE, sandbox)
  // DSH installs its module loader after index scripts run; the prelude's
  // setter must catch that assignment without tripping the double-boot guard.
  assert.equal(sandbox.window.__ModuleLoader__, undefined)
  sandbox.window.__ModuleLoader__ = loader
  assert.equal(typeof sandbox.window.__ModuleLoader__.load, 'function')

  sandbox.window.__ModuleLoader__.load({
    id: 'dsh-vision-router',
    factory() {
      return {
        async apply(ctx) {
          // Give the eager cache warm-up microtask a turn, then read the private
          // catalog view exactly as VisionRouterCard does.
          await new Promise((resolve) => setTimeout(resolve, 0))
          return ctx.get('connection').api.llm.models({})
        },
      }
    },
  })
  const exported = captured.factory(() => {})
  const baseCatalog = {
    result: {
      ok: true,
      value: {
        groups: [{
          id: 'zai',
          name: 'Z.AI',
          models: [{ id: 'glm-base', name: 'GLM Base' }],
        }],
        failures: [],
      },
    },
  }
  const ctx = {
    remote: { $on() { return () => {} } },
    get(name) {
      if (name !== 'connection') return undefined
      return {
        api: {
          llm: {
            async models() { return baseCatalog },
          },
        },
      }
    },
    effect(factory) {
      this.dispose = factory()
    },
  }
  const merged = await exported.apply(ctx)
  const models = merged.result.value.groups[0].models
  assert.deepEqual(models.map((model) => model.id), ['glm-base', 'glm-4v-flash'])
  const liveOnly = models[1]
  assert.equal(liveOnly.visionRouterLiveDiscovered, true)
  assert.equal(Object.prototype.hasOwnProperty.call(liveOnly, 'inputModalities'), false)
  if (typeof ctx.dispose === 'function') ctx.dispose()
})

test('index prelude injection is idempotent and runs from head before lazy client bundles', () => {
  const html = '<html><head><script src="/shell.js"></script></head><body></body></html>'
  const once = injectLiveModelClientPrelude(html)
  const twice = injectLiveModelClientPrelude(once)
  assert.equal(once, twice)
  assert.match(once, /data-vision-router-live-models/)
  assert.ok(once.indexOf('data-vision-router-live-models') < once.indexOf('/shell.js'))
})
