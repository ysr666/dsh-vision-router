import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createLiveModelDiscoveryManager } from '../lib/live-model-discovery.js'

async function waitForSettled(manager, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await manager.snapshot()
    if (!snapshot.refreshing) return snapshot
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for live-model discovery to settle')
}

async function waitForProvider(manager, provider, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = await manager.snapshot()
    const hit = snapshot.providers.find((entry) => entry.provider === provider)
    if (hit) return hit
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for provider ${provider}`)
}

function discoveryContext({
  ref = 'VISION_ROUTER_DISCOVERY_KEY',
  credentials = () => undefined,
  launchEnvironment = () => undefined,
} = {}) {
  const settings = {
    get(namespace) {
      if (namespace === 'llm-pi-ai') {
        return {
          providers: {
            'zhipu-glm': {
              baseURL: 'https://open.bigmodel.cn/api/paas/v4',
              api: 'openai-completions',
              apiKeyEnv: ref,
            },
          },
        }
      }
      if (namespace === 'vision-router') {
        return {
          providers: [{ provider: 'zhipu-glm', model: 'glm-4.6v-flash', fallbacks: [] }],
        }
      }
      return undefined
    },
  }

  return {
    llm: { registration() { return undefined } },
    get(name) {
      if (name === 'settings') return settings
      if (name === 'credentials') return credentials()
      if (name === 'launchEnvironment') return launchEnvironment()
      return undefined
    },
  }
}

function listingResponse() {
  return new Response(JSON.stringify({ data: [{ id: 'glm-4.6v-flash' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('startup credential race never probes /models anonymously and retries when the seam appears', async () => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'vision-router-credential-race-'))
  const calls = []
  let credentialService
  const ctx = discoveryContext({ credentials: () => credentialService })
  const manager = createLiveModelDiscoveryManager(ctx, {
    dshHome,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), authorization: options?.headers?.authorization })
      return listingResponse()
    },
  })

  try {
    await manager.ready()
    manager.queueConfigured()
    await waitForSettled(manager)
    assert.deepEqual(calls, [])

    credentialService = {
      async resolve(ref) {
        assert.equal(ref, 'VISION_ROUTER_DISCOVERY_KEY')
        return { value: 'stored-zhipu-key' }
      },
    }
    manager.queueConfigured()
    const provider = await waitForProvider(manager, 'zhipu-glm')
    assert.equal(provider.live, true)
    assert.deepEqual(calls, [{
      url: 'https://open.bigmodel.cn/api/paas/v4/models',
      authorization: 'Bearer stored-zhipu-key',
    }])
  } finally {
    await manager.dispose()
    await rm(dshHome, { recursive: true, force: true })
  }
})

test('without a credentials service discovery reads DSH launchEnvironment instead of flattened process.env', async () => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'vision-router-launch-env-'))
  const calls = []
  const ctx = discoveryContext({
    launchEnvironment: () => ({
      get(ref) {
        assert.equal(ref, 'VISION_ROUTER_DISCOVERY_KEY')
        return { value: 'launch-snapshot-key', source: 'user-env' }
      },
    }),
  })
  const manager = createLiveModelDiscoveryManager(ctx, {
    dshHome,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), authorization: options?.headers?.authorization })
      return listingResponse()
    },
  })

  try {
    await manager.ready()
    manager.queueConfigured()
    await waitForProvider(manager, 'zhipu-glm')
    assert.deepEqual(calls, [{
      url: 'https://open.bigmodel.cn/api/paas/v4/models',
      authorization: 'Bearer launch-snapshot-key',
    }])
  } finally {
    await manager.dispose()
    await rm(dshHome, { recursive: true, force: true })
  }
})

test('a mounted credentials seam miss does not fall through to an unrelated ambient key', async () => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'vision-router-credential-miss-'))
  const ref = 'VISION_ROUTER_DISCOVERY_AMBIENT_SHOULD_NOT_WIN'
  const previous = process.env[ref]
  process.env[ref] = 'wrong-ambient-key'
  let fetchCalls = 0
  const ctx = discoveryContext({
    ref,
    credentials: () => ({
      async resolve(candidate) {
        assert.equal(candidate, ref)
        return undefined
      },
    }),
  })
  const manager = createLiveModelDiscoveryManager(ctx, {
    dshHome,
    fetchImpl: async () => {
      fetchCalls += 1
      return listingResponse()
    },
  })

  try {
    await manager.ready()
    manager.queueConfigured()
    await waitForSettled(manager)
    assert.equal(fetchCalls, 0)
    assert.equal((await manager.snapshot()).providers.length, 0)
  } finally {
    await manager.dispose()
    if (previous === undefined) delete process.env[ref]
    else process.env[ref] = previous
    await rm(dshHome, { recursive: true, force: true })
  }
})
