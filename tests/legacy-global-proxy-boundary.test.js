import test from 'node:test'
import assert from 'node:assert/strict'

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

test('unknown or mixed Host-owned providers conservatively retain the compatibility seam', () => {
  assert.equal(
    legacyGlobalProxyRequired({
      providers: [{ provider: 'custom-host-provider', model: 'vl-model', fallbacks: [] }],
    }),
    true,
  )
  assert.equal(
    legacyGlobalProxyRequired({
      providers: [
        { provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] },
        { provider: 'custom-host-provider', model: 'vl-model', fallbacks: [] },
      ],
    }),
    true,
  )
})

test('live settings switch the global compatibility seam on and off without restart', async () => {
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
    providers: [{ provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] }],
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

    await globalThis.fetch('https://maintenance.example.test')
    assert.equal(originalCalls, 1)
    assert.equal(legacyCalls, 0, 'Router-only chain must bypass the process-global compatibility patch')

    config = {
      providers: [{ provider: 'custom-host-provider', model: 'vl-model', fallbacks: [] }],
    }
    await globalThis.fetch('https://provider.example.test')
    assert.equal(legacyCalls, 1, 'Host-owned provider must keep the legacy compatibility seam available')

    config = {
      providers: [{ provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] }],
    }
    await globalThis.fetch('https://provider.example.test')
    assert.equal(originalCalls, 2, 'returning to Router-owned transport must narrow the seam immediately')
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
      return { get: () => ({ providers: [{ provider: 'custom-host-provider', model: 'vl', fallbacks: [] }] }) }
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
