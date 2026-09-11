// H2: retain the legacy Host-owned proxy override as a scoped compatibility
// transport, not as process-wide routing authority. The wrapper is always
// transparent unless one DVR-owned visual adapter call is active (or the
// explicitly retained legacy direct whole-turn fallback is in use).

import { AsyncLocalStorage } from 'node:async_hooks'
import { effectiveProxyUrlForUndici } from './proxy-url-compat.js'
import { createProxyDispatcherPool } from './proxy-dispatcher-pool.js'
import {
  createPerHopProxyDispatcher,
  proxyDispatcherLike,
  proxyHostMatchesAny,
  visionProxyOverrideConfigured,
} from './proxy-routing.js'

const legacyProxyScope = new AsyncLocalStorage()

export const LEGACY_GLOBAL_PROXY_REMOVAL_CONDITION =
  'Remove the remaining wrapper when explicit Vision Router proxy overrides no longer need Host-owned adapter interception and the legacy direct whole-turn fallback is retired by product policy.'

function validPair(provider, model) {
  return typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== ''
}

function configuredPairs(config = {}) {
  const pairs = []
  if (Array.isArray(config.providers)) {
    for (const entry of config.providers) {
      if (!validPair(entry?.provider, entry?.model)) continue
      pairs.push({ provider: entry.provider, model: entry.model })
      for (const fallback of entry.fallbacks ?? []) {
        if (typeof fallback === 'string' && fallback !== '') pairs.push({ provider: entry.provider, model: fallback })
      }
    }
  }
  if (pairs.length === 0 && validPair(config.provider, config.model)) {
    pairs.push({ provider: config.provider, model: config.model })
    for (const fallback of config.fallbacks ?? []) {
      if (typeof fallback === 'string' && fallback !== '') pairs.push({ provider: config.provider, model: fallback })
    }
  }
  if (pairs.length === 0) pairs.push({ provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B' })
  return pairs
}

function routerOwnedProvider(provider, config = {}) {
  if (provider === 'vision-http') return true
  const wrapper = typeof config.wrapperRoute === 'string'
    ? (config.wrapperRoute !== '' ? config.wrapperRoute : undefined)
    : 'deepseek-vision'
  const chain = typeof config.chainRoute === 'string'
    ? (config.chainRoute !== '' ? config.chainRoute : undefined)
    : 'vision-chain'
  return provider === wrapper || provider === chain || provider === 'deepseek-official-native'
}

function configuredHostOwnedPair(config, provider, model) {
  if (!validPair(provider, model) || routerOwnedProvider(provider, config)) return false
  return configuredPairs(config).some((pair) => pair.provider === provider && pair.model === model)
}

export function legacyGlobalProxyRequired(config = {}) {
  return visionProxyOverrideConfigured(config) && configuredPairs(config).some(
    (pair) => !routerOwnedProvider(pair.provider, config),
  )
}

// One legacy mode cannot be scoped at an adapter call boundary: routing=true
// with an explicitly disabled chainRoute hands the image turn back to the Host
// agent loop, which performs the provider request after the DVR hook returns.
// Preserve that old behavior narrowly until H3 can retire the mode explicitly.
export function legacyGlobalProxyUnscopedFallbackRequired(config = {}) {
  if (!legacyGlobalProxyRequired(config) || config.routing !== true) return false
  const chainRoute = typeof config.chainRoute === 'string' ? config.chainRoute : 'vision-chain'
  return chainRoute === ''
}

export function currentLegacyGlobalProxyScope() {
  const state = legacyProxyScope.getStore()
  return state?.active === true ? state : undefined
}

export function legacyGlobalProxyScopeAllows(config = {}, state = currentLegacyGlobalProxyScope()) {
  if (!visionProxyOverrideConfigured(config) || state?.active !== true) return false
  return configuredHostOwnedPair(config, state.provider, state.model)
}

// AsyncIterable work is lazy: the adapter normally opens its network request on
// iterator.next(), not when ctx.llm.stream() returns. Keep the scope active for
// every iterator operation and retire it as soon as the stream ends/fails.
export function streamWithLegacyGlobalProxyScope(provider, model, streamFactory) {
  if (typeof streamFactory !== 'function') throw new TypeError('legacy proxy scope requires a stream factory')
  if (!validPair(provider, model)) return streamFactory()
  return {
    [Symbol.asyncIterator]() {
      const state = { provider, model, active: true }
      let iteratorPromise
      const retire = () => { state.active = false }
      const ensure = () => {
        if (iteratorPromise === undefined) {
          iteratorPromise = legacyProxyScope.run(state, async () => {
            const stream = await streamFactory()
            if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
              throw new TypeError('scoped legacy proxy stream is not async iterable')
            }
            return stream[Symbol.asyncIterator]()
          })
        }
        return iteratorPromise
      }
      return {
        next(value) {
          return legacyProxyScope.run(state, async () => {
            try {
              const result = await (await ensure()).next(value)
              if (result?.done === true) retire()
              return result
            } catch (error) {
              retire()
              throw error
            }
          })
        },
        return(value) {
          if (iteratorPromise === undefined) {
            retire()
            return Promise.resolve({ done: true, value })
          }
          return legacyProxyScope.run(state, async () => {
            try {
              const iterator = await iteratorPromise
              return typeof iterator.return === 'function' ? await iterator.return(value) : { done: true, value }
            } finally {
              retire()
            }
          })
        },
        throw(error) {
          if (iteratorPromise === undefined) {
            retire()
            return Promise.reject(error)
          }
          return legacyProxyScope.run(state, async () => {
            try {
              const iterator = await iteratorPromise
              if (typeof iterator.throw === 'function') return await iterator.throw(error)
              throw error
            } finally {
              retire()
            }
          })
        },
      }
    },
  }
}

function liveConfig(ctx, fallback) {
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  } catch {
    // Composition config remains authoritative until Settings is available.
  }
  return fallback
}

function proxyUrlOf(config) {
  return visionProxyOverrideConfigured(config) ? config.proxy : undefined
}

function proxyHostsOf(config) {
  return Array.isArray(config?.proxyHosts)
    ? config.proxyHosts.filter((host) => typeof host === 'string' && host.trim() !== '')
    : []
}

/**
 * Install one lifecycle-safe compatibility fetch wrapper after DVR runtime
 * composition. Unlike the old outer gate, ordinary traffic delegates to the
 * fetch chain that existed at install time, preserving Host/DVR wrappers below
 * it. A private dispatcher is injected only with exact visual-call scope, plus
 * the narrow legacy direct whole-turn fallback above.
 */
export function installLegacyGlobalProxyBoundary(ctx, config = {}, options = {}) {
  const originalFetch = typeof options.originalFetch === 'function' ? options.originalFetch : globalThis.fetch
  const importUndici = typeof options.importUndici === 'function' ? options.importUndici : () => import('undici')
  if (typeof originalFetch !== 'function') return () => {}

  const dispatcherPool = createProxyDispatcherPool({
    importUndici,
    label: 'dsh-vision-router',
  })

  let active = true
  const scopedFetch = (input, init) => {
    if (!active) return originalFetch(input, init)
    const current = liveConfig(ctx, config)
    const proxyUrl = proxyUrlOf(current)
    if (proxyUrl === undefined) dispatcherPool.reconcile(undefined)
    const scoped = legacyGlobalProxyScopeAllows(current)
    const legacyDirect = legacyGlobalProxyUnscopedFallbackRequired(current)
    if (!scoped && !legacyDirect) return originalFetch(input, init)
    if (proxyUrl === undefined) return originalFetch(input, init)
    let url
    try {
      url = new URL(typeof input === 'string' ? input : input?.url ? input.url : String(input))
    } catch {
      return originalFetch(input, init)
    }
    const proxyHosts = proxyHostsOf(current)
    if (!proxyHostMatchesAny(url.hostname, proxyHosts)) return originalFetch(input, init)
    const effectiveProxyUrl = effectiveProxyUrlForUndici(proxyUrl)
    dispatcherPool.reconcile(effectiveProxyUrl)
    return dispatcherPool.acquire(effectiveProxyUrl).then(async (lease) => {
      try {
        const { dispatcher: proxyDispatcher, getGlobalDispatcher } = lease
        const fallbackDispatcher = proxyDispatcherLike(init?.dispatcher)
          ? init.dispatcher
          : getGlobalDispatcher()
        const dispatcher = createPerHopProxyDispatcher(proxyDispatcher, fallbackDispatcher, proxyHosts)
        return await originalFetch(input, { ...(init ?? {}), dispatcher })
      } finally {
        lease.release()
      }
    })
  }

  globalThis.fetch = scopedFetch
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    active = false
    void dispatcherPool.dispose()
    if (globalThis.fetch === scopedFetch) globalThis.fetch = originalFetch
  }
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => dispose, 'vision-router: scoped legacy proxy fetch')
    } catch (error) {
      dispose()
      throw error
    }
  }
  return dispose
}
