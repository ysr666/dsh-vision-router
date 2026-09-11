import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import {
  createLiveModelDiscoveryManager,
  installLiveModelDiscovery,
  LIVE_MODEL_CACHE_VERSION,
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

async function waitForSettled(manager, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await manager.snapshot()
    if (!snapshot.refreshing) return snapshot
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for discovery to settle')
}

function fakeDiscoveryContext({ baseURL = 'https://open.bigmodel.example/api/paas/v4' } = {}) {
  const settings = {
    get(namespace) {
      if (namespace === 'llm-pi-ai') {
        return {
          providers: {
            zai: {
              baseURL,
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


function memoryCacheFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    ops: {
      async readFile(file) {
        if (!files.has(file)) {
          const error = new Error('missing')
          error.code = 'ENOENT'
          throw error
        }
        return files.get(file)
      },
      async mkdir() {},
      async writeFile(file, body) { files.set(file, body) },
      async rename(from, to) {
        files.set(to, files.get(from))
        files.delete(from)
      },
    },
  }
}

function mutableDiscoveryContext(initialProviders = {}) {
  const state = { providers: initialProviders, settingsAvailable: true }
  const settings = {
    get(namespace) {
      if (namespace === 'llm-pi-ai') return { providers: state.providers }
      if (namespace === 'vision-router') return { providers: [] }
      return undefined
    },
  }
  return {
    state,
    ctx: {
      llm: { registration() { return undefined } },
      get(name) {
        if (name === 'settings') return state.settingsAvailable ? settings : undefined
        return undefined
      },
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

test('route fingerprint is credential-independent and covers only provider transport identity', () => {
  const base = {
    provider: 'zai',
    baseURL: 'https://example.test/v1',
    api: 'openai-completions',
  }
  assert.equal(routeFingerprint(base), routeFingerprint({ ...base }))
  assert.equal(
    routeFingerprint({ ...base, apiKey: 'secret-alpha', apiKeyEnv: 'ALPHA_KEY' }),
    routeFingerprint({ ...base, apiKey: 'secret-beta', apiKeyEnv: 'BETA_KEY' }),
  )
  assert.notEqual(routeFingerprint(base), routeFingerprint({ ...base, provider: 'other' }))
  assert.notEqual(routeFingerprint(base), routeFingerprint({ ...base, api: 'openai-responses' }))
  assert.notEqual(routeFingerprint(base), routeFingerprint({ ...base, baseURL: 'https://other.test/v1' }))
})

test('Host discovery uses configured transport/credential and disk cache is display-only until revalidated', async () => {
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
    assert.equal(live.stale, false)
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
    assert.equal(JSON.parse(cacheText).version, LIVE_MODEL_CACHE_VERSION)
    assert.match(cacheText, /glm-4v-flash/)

    const cachedManager = createLiveModelDiscoveryManager(ctx, {
      dshHome,
      timeoutMs: 500,
      fetchImpl: async () => { throw new Error('offline') },
    })
    await cachedManager.ready()
    const cached = await cachedManager.snapshot()
    assert.equal(cached.providers[0].provider, 'zai')
    assert.equal(cached.providers[0].stale, true)
    assert.equal(cached.providers[0].models.some((model) => model.id === 'glm-4v-flash'), true)
    assert.equal(cachedManager.hasModel('zai', 'glm-4v-flash'), false)

    cachedManager.queueConfigured()
    await waitForSettled(cachedManager)
    assert.equal(cachedManager.hasModel('zai', 'glm-4v-flash'), false)
    await cachedManager.dispose()
  } finally {
    await rm(dshHome, { recursive: true, force: true })
  }
})

test('credential rotation invalidates live evidence through current and legacy Host events without hashing the key', async () => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'vision-router-credential-events-'))
  let apiKey = 'rotation-alpha'
  let lifecycleCleanup
  const listeners = new Map()
  const calls = []
  const blocked = []
  const settings = {
    get(namespace) {
      if (namespace === 'llm-pi-ai') {
        return {
          providers: {
            zai: {
              baseURL: 'https://example.test/v1',
              api: 'openai-completions',
              apiKeyEnv: 'ZAI_API_KEY',
            },
          },
        }
      }
      if (namespace === 'vision-router') {
        return { providers: [{ provider: 'zai', model: 'glm-live', fallbacks: [] }] }
      }
      return undefined
    },
  }
  const ctx = {
    llm: { registration() { return undefined } },
    get(name) {
      if (name === 'settings') return settings
      if (name === 'credentials') {
        return { async resolve() { return { value: apiKey, source: 'memory' } } }
      }
      return undefined
    },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    inject() {},
    effect(factory) {
      lifecycleCleanup = factory()
      return lifecycleCleanup
    },
  }
  const manager = installLiveModelDiscovery(ctx, {
    dshHome,
    fetchImpl: async (_url, options) => {
      const call = { authorization: options?.headers?.authorization }
      calls.push(call)
      if (calls.length > 1) {
        await new Promise((resolve) => blocked.push(resolve))
      }
      return new Response(JSON.stringify({ data: [{ id: 'glm-live' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  const waitFor = async (predicate, timeoutMs = 1500) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('timed out waiting for credential invalidation')
  }

  try {
    await manager.ready()
    manager.queueConfigured()
    await waitForSettled(manager)
    assert.equal(manager.hasModel('zai', 'glm-live'), true)
    assert.deepEqual(calls, [{ authorization: 'Bearer rotation-alpha' }])
    assert.equal(listeners.has('credentials/reference-updated'), true)
    assert.equal(listeners.has('credentials/updated'), true)

    const versionBefore = (await manager.snapshot()).version
    apiKey = 'rotation-beta'
    listeners.get('credentials/reference-updated')('ZAI_API_KEY')
    assert.equal(manager.hasModel('zai', 'glm-live'), false, 'current Host event must revoke evidence synchronously')
    listeners.get('credentials/updated')('ZAI_API_KEY')
    await Promise.resolve()
    await waitFor(() => calls.length === 2 && blocked.length === 1)
    assert.equal((await manager.snapshot()).version, versionBefore + 1)
    assert.equal(manager.hasModel('zai', 'glm-live'), false)
    assert.equal(calls[1].authorization, 'Bearer rotation-beta')
    blocked.shift()()
    await waitForSettled(manager)
    assert.equal(manager.hasModel('zai', 'glm-live'), true)
    assert.equal(calls.length, 2, 'current+legacy aliases in one turn must coalesce to one refresh')

    apiKey = 'rotation-gamma'
    listeners.get('credentials/updated')('ZAI_API_KEY')
    await Promise.resolve()
    await waitFor(() => calls.length === 3 && blocked.length === 1)
    assert.equal(manager.hasModel('zai', 'glm-live'), false)
    assert.equal(calls[2].authorization, 'Bearer rotation-gamma')
    blocked.shift()()
    await waitForSettled(manager)
    assert.equal(manager.hasModel('zai', 'glm-live'), true)
  } finally {
    lifecycleCleanup?.()
    await manager.dispose()
    await rm(dshHome, { recursive: true, force: true })
  }
})

test('cache from a different route fingerprint is hidden and never authorizes the new route', async () => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'vision-router-route-fingerprint-'))
  try {
    const first = createLiveModelDiscoveryManager(
      fakeDiscoveryContext({ baseURL: 'https://first.example/v1' }),
      {
        dshHome,
        fetchImpl: async () => new Response(
          JSON.stringify({ data: [{ id: 'only-first-route' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      },
    )
    await first.ready()
    first.queueConfigured()
    await waitForProvider(first, 'zai')
    assert.equal(first.hasModel('zai', 'only-first-route'), true)
    await first.dispose()

    const second = createLiveModelDiscoveryManager(
      fakeDiscoveryContext({ baseURL: 'https://second.example/v1' }),
      {
        dshHome,
        fetchImpl: async () => { throw new Error('second route offline') },
      },
    )
    await second.ready()
    assert.equal((await second.snapshot()).providers[0].stale, true)
    assert.equal(second.hasModel('zai', 'only-first-route'), false)

    second.queueConfigured()
    const settled = await waitForSettled(second)
    assert.equal(settled.providers.some((entry) => entry.provider === 'zai'), false)
    assert.equal(second.hasModel('zai', 'only-first-route'), false)
    await second.dispose()
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
  assert.equal(sandbox.window.__ModuleLoader__, undefined)
  sandbox.window.__ModuleLoader__ = loader
  assert.equal(typeof sandbox.window.__ModuleLoader__.load, 'function')

  sandbox.window.__ModuleLoader__.load({
    id: 'dsh-vision-router',
    factory() {
      return {
        async apply(ctx) {
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

test('index prelude injection is idempotent and runs after head boot scripts but before body shell', () => {
  const html = '<html><head><script src="/shell.js"></script></head><body></body></html>'
  const once = injectLiveModelClientPrelude(html)
  const twice = injectLiveModelClientPrelude(once)
  assert.equal(once, twice)
  assert.match(once, /data-vision-router-live-models/)
  assert.ok(once.indexOf('data-vision-router-live-models') > once.indexOf('/shell.js'))
  assert.ok(once.indexOf('data-vision-router-live-models') < once.indexOf('</head>'))
})

test('authoritative provider config prunes removed cached providers and rewrites the cache', async () => {
  const cacheFile = '/virtual/live-models.json'
  const cachedProviders = [
    { provider: 'keep', fingerprint: 'keep-route', discoveredAt: 9_000, models: [{ id: 'keep-model' }] },
    { provider: 'removed', fingerprint: 'removed-route', discoveredAt: 9_000, models: [{ id: 'removed-model' }] },
  ]
  const mem = memoryCacheFs({
    [cacheFile]: JSON.stringify({ version: LIVE_MODEL_CACHE_VERSION, providers: cachedProviders }),
  })
  const { ctx } = mutableDiscoveryContext({
    keep: { baseURL: 'https://keep.example/v1', api: 'openai-completions' },
  })
  const manager = createLiveModelDiscoveryManager(ctx, {
    cacheFile,
    fsOps: mem.ops,
    now: () => 10_000,
    fetchImpl: async () => { throw new Error('not needed') },
  })

  await manager.ready()
  const snapshot = await manager.snapshot({ schedule: false })
  assert.deepEqual(snapshot.providers.map((entry) => entry.provider), ['keep'])
  assert.equal(manager.hasModel('removed', 'removed-model'), false)
  await manager.dispose()
  const disk = JSON.parse(mem.files.get(cacheFile))
  assert.deepEqual(disk.providers.map((entry) => entry.provider), ['keep'])
})

test('temporarily unavailable settings never turn an empty read into provider cache deletion', async () => {
  const cacheFile = '/virtual/live-models-unavailable.json'
  const mem = memoryCacheFs({
    [cacheFile]: JSON.stringify({
      version: LIVE_MODEL_CACHE_VERSION,
      providers: [{ provider: 'cached', fingerprint: 'cached-route', discoveredAt: 9_000, models: [{ id: 'cached-model' }] }],
    }),
  })
  const { ctx, state } = mutableDiscoveryContext({})
  state.settingsAvailable = false
  const manager = createLiveModelDiscoveryManager(ctx, {
    cacheFile,
    fsOps: mem.ops,
    now: () => 10_000,
    fetchImpl: async () => { throw new Error('not needed') },
  })

  await manager.ready()
  assert.deepEqual((await manager.snapshot({ schedule: false })).providers.map((entry) => entry.provider), ['cached'])
  manager.queueConfigured()
  assert.deepEqual((await manager.snapshot({ schedule: false })).providers.map((entry) => entry.provider), ['cached'])
  await manager.dispose()
})

test('removed provider cannot be resurrected by a late inflight discovery completion', async () => {
  const cacheFile = '/virtual/live-models-inflight.json'
  const mem = memoryCacheFs()
  const { ctx, state } = mutableDiscoveryContext({
    zai: { baseURL: 'https://zai.example/v1', api: 'openai-completions' },
  })
  let release
  let started
  const startedPromise = new Promise((resolve) => { started = resolve })
  const manager = createLiveModelDiscoveryManager(ctx, {
    cacheFile,
    fsOps: mem.ops,
    now: () => 10_000,
    fetchImpl: async () => {
      started()
      await new Promise((resolve) => { release = resolve })
      return new Response(JSON.stringify({ data: [{ id: 'late-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  await manager.ready()
  manager.queueConfigured()
  await startedPromise
  state.providers = {}
  manager.queueConfigured()
  release()
  const settled = await waitForSettled(manager)
  assert.equal(settled.providers.some((entry) => entry.provider === 'zai'), false)
  assert.equal(manager.hasModel('zai', 'late-model'), false)
  await manager.dispose()
})

test('removing a provider clears queued/backoff lifecycle state so a later re-add probes immediately', async () => {
  const cacheFile = '/virtual/live-models-readd.json'
  const mem = memoryCacheFs()
  const { ctx, state } = mutableDiscoveryContext({
    zai: { baseURL: 'https://zai.example/v1', api: 'openai-completions' },
  })
  let calls = 0
  const manager = createLiveModelDiscoveryManager(ctx, {
    cacheFile,
    fsOps: mem.ops,
    now: () => 10_000,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) return new Response('offline', { status: 503 })
      return new Response(JSON.stringify({ data: [{ id: 'readded-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  await manager.ready()
  manager.queueConfigured()
  await waitForSettled(manager)
  assert.equal(calls, 1)

  state.providers = {}
  manager.queueConfigured()
  state.providers = {
    zai: { baseURL: 'https://zai.example/v1', api: 'openai-completions' },
  }
  manager.queueConfigured()
  const live = await waitForProvider(manager, 'zai')
  assert.equal(live.models.some((model) => model.id === 'readded-model'), true)
  assert.equal(calls, 2, 're-added provider must not inherit the removed provider backoff window')
  await manager.dispose()
})

test('same-name provider transport changes fence old inflight results even without an invalidation event', async () => {
  const cacheFile = '/virtual/live-models-route-change.json'
  const mem = memoryCacheFs()
  const { ctx, state } = mutableDiscoveryContext({
    zai: { baseURL: 'https://old.example/v1', api: 'openai-completions' },
  })
  const calls = []
  let releaseOld
  let oldStarted
  const oldStartedPromise = new Promise((resolve) => { oldStarted = resolve })
  const manager = createLiveModelDiscoveryManager(ctx, {
    cacheFile,
    fsOps: mem.ops,
    now: () => 10_000,
    fetchImpl: async (url) => {
      calls.push(String(url))
      if (calls.length === 1) {
        oldStarted()
        await new Promise((resolve) => { releaseOld = resolve })
        return new Response(JSON.stringify({ data: [{ id: 'old-route-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ data: [{ id: 'new-route-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  await manager.ready()
  manager.queueConfigured()
  await oldStartedPromise
  state.providers = {
    zai: { baseURL: 'https://new.example/v1', api: 'openai-completions' },
  }
  manager.queueConfigured()
  releaseOld()
  const live = await waitForProvider(manager, 'zai')
  assert.deepEqual(calls, [
    'https://old.example/v1/models',
    'https://new.example/v1/models',
  ])
  assert.deepEqual(live.models.map((model) => model.id), ['new-route-model'])
  assert.equal(manager.hasModel('zai', 'old-route-model'), false)
  await manager.dispose()
})

test('provider removal drops queued discovery before a concurrency slot can start it', async () => {
  const cacheFile = '/virtual/live-models-queued-removal.json'
  const mem = memoryCacheFs()
  const { ctx, state } = mutableDiscoveryContext({
    first: { baseURL: 'https://first.example/v1', api: 'openai-completions' },
    removed: { baseURL: 'https://removed.example/v1', api: 'openai-completions' },
  })
  const calls = []
  let releaseFirst
  let firstStarted
  const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve })
  const manager = createLiveModelDiscoveryManager(ctx, {
    cacheFile,
    fsOps: mem.ops,
    concurrency: 1,
    now: () => 10_000,
    fetchImpl: async (url) => {
      calls.push(String(url))
      firstStarted()
      await new Promise((resolve) => { releaseFirst = resolve })
      return new Response(JSON.stringify({ data: [{ id: 'first-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  await manager.ready()
  manager.queueConfigured()
  await firstStartedPromise
  state.providers = {
    first: { baseURL: 'https://first.example/v1', api: 'openai-completions' },
  }
  manager.queueConfigured()
  releaseFirst()
  await waitForSettled(manager)
  assert.deepEqual(calls, ['https://first.example/v1/models'])
  assert.equal((await manager.snapshot()).providers.some((entry) => entry.provider === 'removed'), false)
  await manager.dispose()
})

test('remove then re-add of the same provider creates a new lifecycle generation', async () => {
  const cacheFile = '/virtual/live-models-reincarnation.json'
  const mem = memoryCacheFs()
  const config = { baseURL: 'https://same.example/v1', api: 'openai-completions' }
  const { ctx, state } = mutableDiscoveryContext({ zai: config })
  let calls = 0
  let releaseOld
  let oldStarted
  const oldStartedPromise = new Promise((resolve) => { oldStarted = resolve })
  const manager = createLiveModelDiscoveryManager(ctx, {
    cacheFile,
    fsOps: mem.ops,
    now: () => 10_000,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) {
        oldStarted()
        await new Promise((resolve) => { releaseOld = resolve })
        return new Response(JSON.stringify({ data: [{ id: 'old-lifecycle-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ data: [{ id: 'new-lifecycle-model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  await manager.ready()
  manager.queueConfigured()
  await oldStartedPromise
  state.providers = {}
  manager.queueConfigured()
  state.providers = { zai: config }
  manager.queueConfigured()
  releaseOld()
  const live = await waitForProvider(manager, 'zai')
  assert.equal(calls, 2)
  assert.deepEqual(live.models.map((model) => model.id), ['new-lifecycle-model'])
  assert.equal(manager.hasModel('zai', 'old-lifecycle-model'), false)
  await manager.dispose()
})

test('dispose fences a late fetch that ignores AbortSignal and never persists its result', async () => {
  const cacheFile = '/virtual/live-models-dispose.json'
  const mem = memoryCacheFs()
  const { ctx } = mutableDiscoveryContext({
    zai: { baseURL: 'https://zai.example/v1', api: 'openai-completions' },
  })
  let release
  let started
  const startedPromise = new Promise((resolve) => { started = resolve })
  const manager = createLiveModelDiscoveryManager(ctx, {
    cacheFile,
    fsOps: mem.ops,
    now: () => 10_000,
    fetchImpl: async () => {
      started()
      await new Promise((resolve) => { release = resolve })
      return new Response(JSON.stringify({ data: [{ id: 'too-late' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  await manager.ready()
  manager.queueConfigured()
  await startedPromise
  const disposing = manager.dispose()
  release()
  await disposing
  assert.equal((await manager.snapshot({ schedule: false })).providers.some((entry) => entry.provider === 'zai'), false)
  assert.equal([...mem.files.values()].some((body) => String(body).includes('too-late')), false)
})
