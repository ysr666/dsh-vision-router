import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  LEGACY_GLOBAL_PROXY_REMOVAL_CONDITION,
  installLegacyGlobalProxyBoundary,
  legacyGlobalProxyRequired,
} from '../lib/legacy-global-proxy-boundary.js'

function response(source) {
  return Promise.resolve({ ok: true, source })
}

test('default and Router-owned visual chains do not require the legacy global proxy seam', () => {
  assert.equal(legacyGlobalProxyRequired({}), false)
  assert.equal(
    legacyGlobalProxyRequired({
      providers: [
        { provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: ['local-ollama/qwen2.5vl'] },
      ],
    }),
    false,
  )
  assert.equal(
    legacyGlobalProxyRequired({
      providers: [{ provider: 'vision-chain', model: 'vision-chain', fallbacks: [] }],
    }),
    false,
  )
  assert.equal(
    legacyGlobalProxyRequired({
      wrapperRoute: 'custom-wrapper',
      providers: [{ provider: 'custom-wrapper', model: 'deepseek-v4-pro', fallbacks: [] }],
    }),
    false,
  )
})

test('Host-owned providers retain the legacy seam only for an explicit plugin proxy override', () => {
  const hostOwned = [{ provider: 'custom-host-provider', model: 'vl-model', fallbacks: [] }]
  assert.equal(
    legacyGlobalProxyRequired({ providers: hostOwned }),
    false,
    'blank proxy must leave egress entirely to DSH/Host',
  )
  assert.equal(
    legacyGlobalProxyRequired({ proxy: '  ', providers: hostOwned }),
    false,
    'whitespace-only proxy is not an override',
  )
  assert.equal(
    legacyGlobalProxyRequired({
      proxy: 'http://127.0.0.1:7890',
      providers: hostOwned,
    }),
    true,
  )
  assert.equal(
    legacyGlobalProxyRequired({
      proxy: 'socks5://127.0.0.1:7890',
      providers: [
        { provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] },
        ...hostOwned,
      ],
    }),
    true,
  )
})

test('live settings keep Host authority by default and enable legacy seam only for an explicit override', async () => {
  const saved = globalThis.fetch
  let originalCalls = 0
  let legacyCalls = 0
  const originalFetch = async () => {
    originalCalls += 1
    return response('original')
  }
  const legacyFetch = async () => {
    legacyCalls += 1
    return response('legacy')
  }
  let config = {
    providers: [{ provider: 'custom-host-provider', model: 'vl-model', fallbacks: [] }],
  }
  const effects = []
  const ctx = {
    get(name) {
      if (name === 'settings') return { get: () => config }
      return undefined
    },
    effect(factory) {
      effects.push(factory())
    },
  }

  try {
    globalThis.fetch = legacyFetch
    installLegacyGlobalProxyBoundary(ctx, config, { originalFetch })

    await globalThis.fetch('https://provider.example.test')
    assert.equal(originalCalls, 1)
    assert.equal(legacyCalls, 0, 'Host-owned provider without plugin proxy must stay on Host fetch')

    config = { ...config, proxy: 'http://127.0.0.1:7890' }
    await globalThis.fetch('https://provider.example.test')
    assert.equal(legacyCalls, 1, 'explicit plugin proxy enables the compatibility seam live')

    config = { ...config, proxy: '' }
    await globalThis.fetch('https://provider.example.test')
    assert.equal(originalCalls, 2, 'clearing plugin proxy restores Host authority immediately')

    config = {
      proxy: 'http://127.0.0.1:7890',
      providers: [{ provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] }],
    }
    await globalThis.fetch('https://provider.example.test')
    assert.equal(originalCalls, 3, 'Router-owned transport never needs the legacy global seam')
  } finally {
    for (const dispose of effects.reverse()) dispose?.()
    globalThis.fetch = saved
  }
})

test('outermost cleanup restores original fetch and retained gate cannot resurface', async () => {
  const saved = globalThis.fetch
  let originalCalls = 0
  let legacyCalls = 0
  const originalFetch = async () => {
    originalCalls += 1
    return response('original')
  }
  const legacyFetch = async () => {
    legacyCalls += 1
    return response('legacy')
  }
  let cleanup
  const ctx = {
    get() {
      return { get: () => ({ proxy: 'http://127.0.0.1:7890', providers: [{ provider: 'custom-host-provider', model: 'vl', fallbacks: [] }] }) }
    },
    effect(factory) {
      cleanup = factory()
    },
  }

  try {
    globalThis.fetch = legacyFetch
    const dispose = installLegacyGlobalProxyBoundary(ctx, {}, { originalFetch })
    const retainedGate = globalThis.fetch
    await retainedGate('https://provider.example.test')
    assert.equal(legacyCalls, 1)

    dispose()
    assert.equal(globalThis.fetch, originalFetch)
    await retainedGate('https://provider.example.test')
    assert.equal(originalCalls, 1, 'retained gate must become an inert delegator after unload')
    assert.equal(legacyCalls, 1)

    cleanup?.()
    dispose()
    assert.equal(globalThis.fetch, originalFetch, 'cleanup must be idempotent')
  } finally {
    globalThis.fetch = saved
  }
})

test('cleanup preserves a later plugin wrapper', async () => {
  const saved = globalThis.fetch
  const originalFetch = async () => response('original')
  const legacyFetch = async () => response('legacy')
  try {
    globalThis.fetch = legacyFetch
    const dispose = installLegacyGlobalProxyBoundary(
      { get() { return undefined } },
      {},
      { originalFetch },
    )
    const gate = globalThis.fetch
    const later = (...args) => gate(...args)
    globalThis.fetch = later

    dispose()
    assert.equal(globalThis.fetch, later)
    const result = await later('https://maintenance.example.test')
    assert.equal((await result).source, 'original')
  } finally {
    globalThis.fetch = saved
  }
})

test('removal condition is explicit and tied to the minimum Host proxy seam', () => {
  assert.match(LEGACY_GLOBAL_PROXY_REMOVAL_CONDITION, /minimum supported DSH/i)
  assert.match(LEGACY_GLOBAL_PROXY_REMOVAL_CONDITION, /provider-scoped\/shared HTTP proxy seam/i)
})


test('legacy selective proxy projects socks5h only after host admission and before dispatcher caching', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(
    source,
    /import \{ effectiveProxyUrlForUndici \} from '\.\/lib\/proxy-url-compat\.js'/,
  )
  assert.match(
    source,
    /import \{ markVisionProxyDispatcher \} from '\.\/lib\/proxy-routing\.js'/,
  )
  assert.match(source, /markVisionProxyDispatcher\(new ProxyAgent\(url\)\)/)
  assert.match(source, /cachedAgentPromise === agentPromise/)
  const hostAdmission = source.indexOf(
    'if (!hostMatchesAny(url.hostname, currentProxyHosts())) return originalFetch(input, init)',
  )
  const projection = source.indexOf(
    'const effectiveProxyUrl = effectiveProxyUrlForUndici(proxyUrl)',
    hostAdmission,
  )
  const dispatch = source.indexOf(
    'return agentFor(effectiveProxyUrl).then((dispatcher) =>',
    projection,
  )
  assert.ok(hostAdmission >= 0)
  assert.ok(projection > hostAdmission, 'compat projection must not run before proxyHosts admission')
  assert.ok(dispatch > projection, 'effective URL must become the dispatcher cache identity')
})
