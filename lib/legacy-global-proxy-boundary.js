// P2-E: keep the process-global fetch patch only as a compatibility fallback
// for Host-owned/raw-fetch visual providers. Router-owned provider HTTP already
// uses VisionProviderTransport and therefore never needs this seam.

import {
  needsSocks5hProxyCompat,
  normalizeProxyUrlForUndici,
} from './proxy-url-compat.js'

const moduleFetch =
  typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : undefined

export const LEGACY_GLOBAL_PROXY_REMOVAL_CONDITION =
  'Remove when the minimum supported DSH provides a provider-scoped/shared HTTP proxy seam.'

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
        if (typeof fallback === 'string' && fallback !== '') {
          pairs.push({ provider: entry.provider, model: fallback })
        }
      }
    }
  }
  if (pairs.length === 0 && validPair(config.provider, config.model)) {
    pairs.push({ provider: config.provider, model: config.model })
    for (const fallback of config.fallbacks ?? []) {
      if (typeof fallback === 'string' && fallback !== '') {
        pairs.push({ provider: config.provider, model: fallback })
      }
    }
  }
  if (pairs.length === 0) pairs.push({ provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B' })
  return pairs
}

function routerOwnedProvider(provider, config = {}) {
  if (provider === 'vision-http') return true
  const wrapper = typeof config.wrapperRoute === 'string' && config.wrapperRoute !== ''
    ? config.wrapperRoute
    : 'deepseek-vision'
  const chain = typeof config.chainRoute === 'string' && config.chainRoute !== ''
    ? config.chainRoute
    : 'vision-chain'
  if (provider === wrapper || provider === chain) return true
  // Hidden native takeover route is registered by this plugin and does not
  // require the Host/raw-fetch compatibility patch.
  if (provider === 'deepseek-official-native') return true
  return false
}

/**
 * True only when the configured visual chain still contains a provider whose
 * network transport is owned by the Host/another adapter. This is deliberately
 * conservative: any unknown provider keeps the compatibility seam available.
 */
export function legacyGlobalProxyRequired(config = {}) {
  return configuredPairs(config).some(
    (pair) => !routerOwnedProvider(pair.provider, config),
  )
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

// These helpers intentionally mirror the mature legacy proxy patch in index.js.
// Keep its admission semantics unchanged; this boundary only supplies the one
// historical `socks5h:` compatibility spelling that Undici 7.x does not parse.
function currentProxyUrl(config) {
  const value = config?.proxy
  return typeof value === 'string' && value !== '' ? value : undefined
}

function currentProxyHosts(config) {
  const value = config?.proxyHosts
  return Array.isArray(value)
    ? value.filter((host) => typeof host === 'string' && host !== '')
    : []
}

function hostMatchesAny(hostname, hosts) {
  return (hosts ?? []).some((host) => hostname === host || hostname.endsWith(`.${host}`))
}

function requestUrl(input) {
  try {
    return new URL(
      typeof input === 'string' ? input : input && input.url ? input.url : String(input),
    )
  } catch {
    return undefined
  }
}

async function closeDispatcher(dispatcher) {
  if (!dispatcher || (typeof dispatcher !== 'object' && typeof dispatcher !== 'function')) return
  try {
    if (typeof dispatcher.close === 'function') await dispatcher.close()
    else if (typeof dispatcher.destroy === 'function') await dispatcher.destroy()
  } catch {
    // Lifecycle cleanup is best effort and must never mask plugin disposal.
  }
}

/**
 * Install after core.apply has installed its lifecycle-safe legacy proxy patch.
 *
 * The outer gate bypasses that process-global patch entirely whenever the live
 * visual chain is Router-owned. If a Host-owned provider is configured, calls
 * fall through to the legacy patched fetch exactly as before. The sole
 * exception is the historical `socks5h:` spelling advertised by Vision Router:
 * for an admitted proxy host it is canonicalized to `socks5:` at the Undici
 * boundary, while every other proxy URL continues through the mature path.
 */
export function installLegacyGlobalProxyBoundary(ctx, config = {}, options = {}) {
  const originalFetch = typeof options.originalFetch === 'function'
    ? options.originalFetch
    : moduleFetch
  const importUndici = typeof options.importUndici === 'function'
    ? options.importUndici
    : () => import('undici')
  const legacyFetch = typeof globalThis.fetch === 'function'
    ? globalThis.fetch
    : undefined
  if (typeof originalFetch !== 'function' || typeof legacyFetch !== 'function') return () => {}

  let cachedCompatProxyUrl
  let cachedCompatDispatcherPromise
  // Keep every successfully-started compatibility pool reachable until plugin
  // disposal. We intentionally do not close a replaced pool during a live
  // Settings change: doing so can race a request that already admitted the old
  // config. Local-only proxy settings make URL churn bounded in normal use.
  const compatDispatcherPromises = new Set()

  const compatDispatcherFor = (proxyUrl) => {
    if (cachedCompatProxyUrl === proxyUrl && cachedCompatDispatcherPromise) {
      return cachedCompatDispatcherPromise
    }
    cachedCompatProxyUrl = proxyUrl
    const promise = Promise.resolve(importUndici()).then(({ ProxyAgent }) => {
      if (typeof ProxyAgent !== 'function') {
        throw new Error('vision-router: undici ProxyAgent is unavailable')
      }
      return new ProxyAgent(proxyUrl)
    })
    cachedCompatDispatcherPromise = promise.catch((error) => {
      compatDispatcherPromises.delete(promise)
      if (cachedCompatProxyUrl === proxyUrl) {
        cachedCompatProxyUrl = undefined
        cachedCompatDispatcherPromise = undefined
      }
      throw error
    })
    compatDispatcherPromises.add(promise)
    return cachedCompatDispatcherPromise
  }

  let active = true
  const gatedFetch = (...args) => {
    if (!active) return originalFetch(...args)
    const current = liveConfig(ctx, config)
    if (!legacyGlobalProxyRequired(current)) return originalFetch(...args)

    const proxyUrl = currentProxyUrl(current)
    if (!needsSocks5hProxyCompat(proxyUrl)) return legacyFetch(...args)

    const [input, init] = args
    const url = requestUrl(input)
    if (!url || !hostMatchesAny(url.hostname, currentProxyHosts(current))) {
      // Preserve the mature legacy patch for all non-admitted requests; it
      // keeps #149's original-fetch behavior and does not lazy-load Undici.
      return legacyFetch(...args)
    }

    const effectiveProxyUrl = normalizeProxyUrlForUndici(proxyUrl)
    return compatDispatcherFor(effectiveProxyUrl).then((dispatcher) =>
      originalFetch(input, { ...(init ?? {}), dispatcher }),
    )
  }

  globalThis.fetch = gatedFetch

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    active = false
    cachedCompatProxyUrl = undefined
    cachedCompatDispatcherPromise = undefined
    for (const dispatcherPromise of compatDispatcherPromises) {
      void Promise.resolve(dispatcherPromise)
        .then((dispatcher) => closeDispatcher(dispatcher))
        .catch(() => undefined)
    }
    compatDispatcherPromises.clear()
    // Preserve a later plugin wrapper if one was installed above us. If we are
    // still outermost, restore the original Host fetch directly instead of the
    // inner legacy guard: this remains correct regardless of effect-disposal
    // order and cannot leave an inert Vision Router closure as process state.
    if (globalThis.fetch === gatedFetch) globalThis.fetch = originalFetch
  }

  if (typeof ctx?.effect === 'function') {
    ctx.effect(
      () => dispose,
      'vision-router: legacy global proxy compatibility gate',
    )
  }
  return dispose
}
