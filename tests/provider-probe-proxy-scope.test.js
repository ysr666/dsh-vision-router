// Provider probes must follow the same egress path as the provider traffic they
// describe. Live model discovery and the settings "test connection" route do not
// stream a provider turn, so nothing opened a legacy-proxy scope for them: with a
// configured `proxy`, real vision turns were proxied while these probes went
// direct (and reported failures the turns did not have). These tests pin both
// halves of the fix — a boundary-owned transport plus a scoped probe — and the
// scope's retirement so nothing leaks into later, unrelated fetches.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  currentLegacyGlobalProxyFetch,
  currentLegacyGlobalProxyScope,
  installLegacyGlobalProxyBoundary,
  legacyGlobalProxyPairFor,
  legacyGlobalProxyScopeAllows,
  runWithLegacyGlobalProxyScope,
} from '../lib/legacy-global-proxy-boundary.js'
import { installFetchWrapper } from '../lib/fetch-wrapper-lifecycle.js'
import { createLiveModelDiscoveryManager } from '../lib/live-model-discovery.js'
import {
  installVisionDiagnosticsRoutes,
  VISION_TEST_CONNECTION_PATH,
} from '../lib/vision-diagnostics-routes.js'

// proxyHosts deliberately does not match the probe host: the scope decision and
// the host match are separate steps, and the tests assert the scope half (the
// dispatch half is covered by tests/legacy-global-proxy-boundary.test.js).
const PROXY_CONFIG = Object.freeze({
  proxy: 'http://127.0.0.1:19600',
  proxyHosts: ['other.example'],
  providers: [{ provider: 'zhipu-glm', model: 'glm-4.6v-flash', fallbacks: [] }],
})

function listingResponse() {
  return new Response(JSON.stringify({ data: [{ id: 'glm-4.6v-flash' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function discoveryContext({ visionConfig = PROXY_CONFIG } = {}) {
  const settings = {
    get(namespace) {
      if (namespace === 'llm-pi-ai') {
        return {
          providers: {
            'zhipu-glm': {
              baseURL: 'https://open.bigmodel.cn/api/paas/v4',
              api: 'openai-completions',
              apiKeyEnv: 'ZHIPU_KEY',
            },
          },
        }
      }
      if (namespace === 'vision-router') return visionConfig
      return undefined
    },
  }
  return {
    llm: { registration() { return undefined } },
    get(name) {
      if (name === 'settings') return settings
      if (name === 'credentials') {
        return { async resolve() { return { value: 'stored-key' } } }
      }
      return undefined
    },
  }
}

async function waitForSettled(manager) {
  await manager.snapshot({ schedule: false })
}

test('the scope runner activates the scope for its work and retires it afterwards', async () => {
  const seen = await runWithLegacyGlobalProxyScope('zhipu-glm', 'glm-4.6v-flash', async () => {
    const state = currentLegacyGlobalProxyScope()
    return {
      allowed: legacyGlobalProxyScopeAllows(PROXY_CONFIG, state),
      state: state === undefined ? state : { ...state },
    }
  })
  assert.equal(seen.allowed, true)
  assert.deepEqual(seen.state, { provider: 'zhipu-glm', model: 'glm-4.6v-flash', active: true })
  assert.equal(currentLegacyGlobalProxyScope(), undefined, 'the scope must not leak past the work')
})

test('an incomplete or unconfigured pair runs the work unscoped', async () => {
  assert.equal(await runWithLegacyGlobalProxyScope('zhipu-glm', '', () => 'direct'), 'direct')
  assert.equal(await runWithLegacyGlobalProxyScope('', '', () => currentLegacyGlobalProxyScope()), undefined)
  assert.equal(
    legacyGlobalProxyPairFor({ providers: PROXY_CONFIG.providers }, 'zhipu-glm'),
    undefined,
    'no proxy override means no pair',
  )
  assert.equal(
    legacyGlobalProxyPairFor({ ...PROXY_CONFIG, providers: [{ provider: 'vision-http', model: 'free' }] }, 'vision-http'),
    undefined,
    'router-owned providers are excluded, matching the boundary guard',
  )
})

test('live model discovery uses the boundary-owned fetch, not a later wrapper on the global', async () => {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'vision-router-probe-scope-'))
  const boundaryCalls = []
  const laterCalls = []
  const rawHostFetch = async (url) => {
    boundaryCalls.push({
      url: String(url),
      state: (() => { const s = currentLegacyGlobalProxyScope(); return s === undefined ? s : { ...s } })(),
    })
    return listingResponse()
  }
  const settings = discoveryContext().get('settings')
  const ctx = { get: (name) => (name === 'settings' ? settings : undefined) }
  const previousFetch = globalThis.fetch
  const previousConfig = undefined
  globalThis.fetch = rawHostFetch
  const disposeBoundary = installLegacyGlobalProxyBoundary(ctx, PROXY_CONFIG, {
    importUndici: async () => ({ ProxyAgent: class {}, Agent: class {}, getGlobalDispatcher: () => ({}) }),
  })
  // A wrapper installed after the boundary is exactly what a call-time
  // `globalThis.fetch` read would pick up (the L1-sealed-process-global class).
  const restoreLater = installFetchWrapper(async (url) => {
    laterCalls.push({ url: String(url) })
    return listingResponse()
  })
  const manager = createLiveModelDiscoveryManager(discoveryContext(), { dshHome })
  try {
    await manager.ready()
    manager.queueConfigured()
    await waitForSettled(manager)
    assert.equal(laterCalls.length, 0, 'the probe must not reach for whatever wrapper the global holds')
    assert.equal(boundaryCalls.length, 1, `expected one boundary probe, saw ${JSON.stringify(boundaryCalls)}`)
    assert.match(boundaryCalls[0].url, /open\.bigmodel\.cn\/api\/paas\/v4\/models$/)
    assert.deepEqual(boundaryCalls[0].state, { provider: 'zhipu-glm', model: 'glm-4.6v-flash', active: true })
    assert.equal(currentLegacyGlobalProxyScope(), undefined, 'the scope must retire when the probe ends')
  } finally {
    restoreLater()
    disposeBoundary()
    globalThis.fetch = previousFetch
    await manager.dispose()
    await rm(dshHome, { recursive: true, force: true })
  }
})

test('the boundary advertises the fetch it owns and withdraws it on dispose', () => {
  const ctx = { get: () => undefined }
  const fetchBefore = globalThis.fetch
  globalThis.fetch = async () => new Response('ok')
  const dispose = installLegacyGlobalProxyBoundary(ctx, PROXY_CONFIG, {
    importUndici: async () => ({ ProxyAgent: class {}, Agent: class {}, getGlobalDispatcher: () => ({}) }),
  })
  const owned = currentLegacyGlobalProxyFetch()
  try {
    assert.equal(typeof owned, 'function', 'the installed boundary must advertise its fetch')
  } finally {
    dispose()
    globalThis.fetch = fetchBefore
  }
  assert.equal(currentLegacyGlobalProxyFetch(), undefined, 'dispose must withdraw ownership')
})

test('the settings test-connection probe uses the same scoped transport', async () => {
  const calls = []
  const routes = new Map()
  const cfg = {
    proxy: 'http://127.0.0.1:19600',
    proxyHosts: ['other.test'],
    providers: [{ provider: 'local-ollama', model: 'qwen2.5vl', fallbacks: [] }],
  }
  const ctx = {
    llm: { registration() { return { id: 'mock' } } },
    get(name) {
      if (name === 'settings') return { get: (ns) => (ns === 'vision-router' ? cfg : undefined) }
      return undefined
    },
    inject(_deps, callback) {
      callback({
        webServer: {
          register(route) {
            routes.set(route.path, route)
            return () => {}
          },
        },
        effect(factory) { return factory() },
      })
    },
  }
  installVisionDiagnosticsRoutes(ctx, {
    connection: {
      candidatePairs: () => [],
      localBackends: () => [{ name: 'local-ollama', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5vl' }],
      httpBackends: () => [],
      resolveCapability: async () => ({ attemptable: true }),
      httpRoute: 'vision-http',
    },
    capabilities: { collect: async () => ({}), builtinFallback: [] },
    ownership: { hostOwnsOfficialDeepSeek: false, stealthConfigured: false },
  })
  const route = routes.get(VISION_TEST_CONNECTION_PATH)
  assert.ok(route, 'the test-connection route must be registered')
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const state = currentLegacyGlobalProxyScope()
    calls.push({
      url: String(url),
      scopeAllowed: legacyGlobalProxyScopeAllows(cfg, state),
      scope: state === undefined ? state : { ...state },
    })
    return new Response(JSON.stringify({ data: [{ id: 'qwen2.5vl' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const disposeBoundary = installLegacyGlobalProxyBoundary(ctx, cfg, {
    importUndici: async () => ({ ProxyAgent: class {}, Agent: class {}, getGlobalDispatcher: () => ({}) }),
  })
  const res = {
    status: undefined,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    writeHead(status) { this.status = status },
    end() {},
  }
  try {
    await route.handler({ method: 'GET' }, res)
    assert.ok(calls.length >= 1, 'the connection probe must fetch')
    assert.equal(calls[0].scopeAllowed, true, 'the probe must run inside an allowed proxy scope')
    assert.deepEqual(calls[0].scope, { provider: 'local-ollama', model: 'qwen2.5vl', active: true })
    assert.equal(currentLegacyGlobalProxyScope(), undefined, 'the scope must retire when the probe ends')
  } finally {
    disposeBoundary()
    globalThis.fetch = previousFetch
  }
})
