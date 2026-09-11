import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  LEGACY_GLOBAL_PROXY_REMOVAL_CONDITION,
  currentLegacyGlobalProxyScope,
  installLegacyGlobalProxyBoundary,
  legacyGlobalProxyRequired,
  legacyGlobalProxyScopeAllows,
  legacyGlobalProxyUnscopedFallbackRequired,
  streamWithLegacyGlobalProxyScope,
} from '../lib/legacy-global-proxy-boundary.js'
import { isVisionProxyDispatcher } from '../lib/proxy-routing.js'

const hostPair = { provider: 'custom-host-provider', model: 'vl-model', fallbacks: [] }

function baseConfig(extra = {}) {
  return {
    proxy: 'http://127.0.0.1:7890',
    proxyHosts: ['provider.example.test'],
    providers: [hostPair],
    ...extra,
  }
}

async function drain(stream) {
  const out = []
  for await (const value of stream) out.push(value)
  return out
}

test('default and Router-owned visual chains do not require the legacy compatibility seam', () => {
  assert.equal(legacyGlobalProxyRequired({}), false)
  assert.equal(legacyGlobalProxyRequired({ proxy: 'http://127.0.0.1:7890' }), false)
  assert.equal(legacyGlobalProxyRequired({
    proxy: 'http://127.0.0.1:7890',
    providers: [{ provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] }],
  }), false)
  assert.equal(legacyGlobalProxyRequired({
    proxy: 'http://127.0.0.1:7890',
    wrapperRoute: 'custom-wrapper',
    providers: [{ provider: 'custom-wrapper', model: 'model', fallbacks: [] }],
  }), false)
})

test('Host-owned pairs require compatibility only with an explicit plugin proxy', () => {
  assert.equal(legacyGlobalProxyRequired({ providers: [hostPair] }), false)
  assert.equal(legacyGlobalProxyRequired({ proxy: '  ', providers: [hostPair] }), false)
  assert.equal(legacyGlobalProxyRequired(baseConfig()), true)
})

test('unscoped compatibility is retained only for the legacy direct whole-turn route', () => {
  assert.equal(legacyGlobalProxyUnscopedFallbackRequired(baseConfig()), false)
  assert.equal(legacyGlobalProxyUnscopedFallbackRequired(baseConfig({ routing: false, chainRoute: '' })), false)
  assert.equal(legacyGlobalProxyUnscopedFallbackRequired(baseConfig({ routing: true, chainRoute: 'vision-chain' })), false)
  assert.equal(legacyGlobalProxyUnscopedFallbackRequired(baseConfig({ routing: true, chainRoute: '   ' })), false)
  assert.equal(legacyGlobalProxyUnscopedFallbackRequired(baseConfig({ routing: true, chainRoute: '' })), true)
})

test('explicitly blank wrapper and chain routes do not impersonate the disabled DVR routes', () => {
  assert.equal(legacyGlobalProxyRequired(baseConfig({
    wrapperRoute: '',
    providers: [{ provider: 'deepseek-vision', model: 'foreign-vl', fallbacks: [] }],
  })), true)
  assert.equal(legacyGlobalProxyRequired(baseConfig({
    chainRoute: '',
    providers: [{ provider: 'vision-chain', model: 'foreign-vl', fallbacks: [] }],
  })), true)
})

test('legacy proxy scope survives lazy iterator work and retires after completion', async () => {
  const seen = []
  const stream = streamWithLegacyGlobalProxyScope(hostPair.provider, hostPair.model, () => ({
    [Symbol.asyncIterator]() {
      let done = false
      return {
        async next() {
          seen.push(currentLegacyGlobalProxyScope()?.provider)
          await Promise.resolve()
          seen.push(currentLegacyGlobalProxyScope()?.model)
          if (done) return { done: true }
          done = true
          return { done: false, value: 'ok' }
        },
      }
    },
  }))
  assert.equal(currentLegacyGlobalProxyScope(), undefined)
  assert.deepEqual(await drain(stream), ['ok'])
  assert.deepEqual(seen, [hostPair.provider, hostPair.model, hostPair.provider, hostPair.model])
  assert.equal(currentLegacyGlobalProxyScope(), undefined)
})

test('scope authorization follows the live configured pair and explicit proxy', async () => {
  let config = baseConfig()
  const checks = []
  await drain(streamWithLegacyGlobalProxyScope(hostPair.provider, hostPair.model, () => ({
    async *[Symbol.asyncIterator]() {
      checks.push(legacyGlobalProxyScopeAllows(config))
      config = { ...config, proxy: '' }
      checks.push(legacyGlobalProxyScopeAllows(config))
      config = baseConfig({ providers: [{ provider: 'different', model: 'vl-model', fallbacks: [] }] })
      checks.push(legacyGlobalProxyScopeAllows(config))
      yield 'done'
    },
  })))
  assert.deepEqual(checks, [true, false, false])
})

test('scoped Host-owned visual fetch gets the DVR dispatcher while concurrent same-origin Host traffic does not', async () => {
  const saved = globalThis.fetch
  const calls = []
  const agents = []
  let release
  let ready
  const gate = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { ready = resolve })
  class FakeProxyAgent {
    constructor(url) {
      this.url = url
      agents.push(this)
    }
  }
  const originalFetch = async (input, init = {}) => {
    calls.push({ input: String(input), dispatcher: init.dispatcher })
    return new Response('ok')
  }
  const config = baseConfig()
  const ctx = { get(name) { return name === 'settings' ? { get: () => config } : undefined } }

  try {
    globalThis.fetch = originalFetch
    installLegacyGlobalProxyBoundary(ctx, config, {
      importUndici: async () => ({ ProxyAgent: FakeProxyAgent }),
    })

    const scoped = streamWithLegacyGlobalProxyScope(hostPair.provider, hostPair.model, () => ({
      async *[Symbol.asyncIterator]() {
        ready()
        await gate
        await globalThis.fetch('https://provider.example.test/vision')
        yield 'vision'
      },
    }))
    const pending = drain(scoped)
    await started
    await globalThis.fetch('https://provider.example.test/host')
    release()
    assert.deepEqual(await pending, ['vision'])

    assert.equal(calls.length, 2)
    assert.equal(calls[0].dispatcher, undefined, 'concurrent Host traffic must remain on the inherited Host path')
    assert.equal(isVisionProxyDispatcher(calls[1].dispatcher), true)
    assert.equal(calls[1].dispatcher.url, config.proxy)
    assert.equal(agents.length, 1)
  } finally {
    globalThis.fetch = saved
  }
})

test('live proxy clearing takes effect inside an already scoped stream', async () => {
  const saved = globalThis.fetch
  const calls = []
  class FakeProxyAgent { constructor(url) { this.url = url } }
  let config = baseConfig()
  const ctx = { get() { return { get: () => config } } }
  const originalFetch = async (_input, init = {}) => {
    calls.push(init.dispatcher)
    return new Response('ok')
  }
  try {
    globalThis.fetch = originalFetch
    installLegacyGlobalProxyBoundary(ctx, config, { importUndici: async () => ({ ProxyAgent: FakeProxyAgent }) })
    await drain(streamWithLegacyGlobalProxyScope(hostPair.provider, hostPair.model, () => ({
      async *[Symbol.asyncIterator]() {
        await globalThis.fetch('https://provider.example.test/one')
        config = { ...config, proxy: '' }
        await globalThis.fetch('https://provider.example.test/two')
        yield 'done'
      },
    })))
    assert.equal(isVisionProxyDispatcher(calls[0]), true)
    assert.equal(calls[1], undefined)
  } finally {
    globalThis.fetch = saved
  }
})

test('legacy direct whole-turn fallback preserves existing unscoped behavior narrowly', async () => {
  const saved = globalThis.fetch
  const calls = []
  class FakeProxyAgent { constructor(url) { this.url = url } }
  const config = baseConfig({ routing: true, chainRoute: '' })
  const originalFetch = async (_input, init = {}) => {
    calls.push(init.dispatcher)
    return new Response('ok')
  }
  try {
    globalThis.fetch = originalFetch
    installLegacyGlobalProxyBoundary({ get() { return { get: () => config } } }, config, {
      importUndici: async () => ({ ProxyAgent: FakeProxyAgent }),
    })
    await globalThis.fetch('https://provider.example.test/direct-turn')
    assert.equal(isVisionProxyDispatcher(calls[0]), true)
  } finally {
    globalThis.fetch = saved
  }
})

test('synchronous Undici loader failure does not poison the dispatcher cache', async () => {
  const saved = globalThis.fetch
  let imports = 0
  const config = baseConfig()
  const originalFetch = async () => new Response('ok')
  const ctx = { get() { return { get: () => config } } }
  try {
    globalThis.fetch = originalFetch
    installLegacyGlobalProxyBoundary(ctx, config, {
      importUndici() {
        imports += 1
        throw new Error('sync import failure')
      },
    })
    const once = () => drain(streamWithLegacyGlobalProxyScope(hostPair.provider, hostPair.model, () => ({
      async *[Symbol.asyncIterator]() {
        await globalThis.fetch('https://provider.example.test/fail')
        yield 'unreachable'
      },
    })))
    await assert.rejects(once(), /sync import failure/)
    await assert.rejects(once(), /sync import failure/)
    assert.equal(imports, 2, 'a rejected lazy import must not leave a poisoned cached promise')
  } finally {
    globalThis.fetch = saved
  }
})

test('effect registration failure rolls back the installed compatibility wrapper', () => {
  const saved = globalThis.fetch
  const originalFetch = async () => new Response('host')
  try {
    globalThis.fetch = originalFetch
    assert.throws(() => installLegacyGlobalProxyBoundary({
      effect() { throw new Error('effect registration failed') },
    }, baseConfig()), /effect registration failed/)
    assert.equal(globalThis.fetch, originalFetch)
  } finally {
    globalThis.fetch = saved
  }
})

test('cleanup preserves a later wrapper and retained scoped fetch becomes inert', async () => {
  const saved = globalThis.fetch
  const originalFetch = async () => new Response('original')
  try {
    globalThis.fetch = originalFetch
    const dispose = installLegacyGlobalProxyBoundary({ get() { return undefined } }, {})
    const gate = globalThis.fetch
    const later = (...args) => gate(...args)
    globalThis.fetch = later
    dispose()
    assert.equal(globalThis.fetch, later)
    assert.equal(await (await later('https://provider.example.test')).text(), 'original')
  } finally {
    globalThis.fetch = saved
  }
})

test('removal condition names both remaining blockers', () => {
  assert.match(LEGACY_GLOBAL_PROXY_REMOVAL_CONDITION, /Host-owned adapter interception/i)
  assert.match(LEGACY_GLOBAL_PROXY_REMOVAL_CONDITION, /direct whole-turn fallback/i)
  assert.match(LEGACY_GLOBAL_PROXY_REMOVAL_CONDITION, /product policy/i)
})

test('H2 moves ProxyAgent ownership out of Core and scopes every DVR-owned Host adapter stream', async () => {
  const [core, boundary, benchmark] = await Promise.all([
    readFile(new URL('../index.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/legacy-global-proxy-boundary.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/vision-capability-benchmark-service.js', import.meta.url), 'utf8'),
  ])
  assert.doesNotMatch(core, /new ProxyAgent\(/)
  assert.doesNotMatch(core, /effectiveProxyUrlForUndici/)
  assert.doesNotMatch(core, /globalThis\.fetch = patchedFetch/)
  assert.ok((core.match(/streamWithLegacyGlobalProxyScope\(/g) ?? []).length >= 2)
  assert.match(benchmark, /streamWithLegacyGlobalProxyScope\(/)
  assert.match(boundary, /new ProxyAgent\(url\)/)
  const hostAdmission = boundary.indexOf('if (!proxyHostMatchesAny(url.hostname, proxyHostsOf(current)))')
  const projection = boundary.indexOf('const effectiveProxyUrl = effectiveProxyUrlForUndici(proxyUrl)', hostAdmission)
  assert.ok(hostAdmission >= 0)
  assert.ok(projection > hostAdmission, 'proxy URL compatibility projection must stay after host admission')
})
