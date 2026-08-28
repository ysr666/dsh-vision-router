// P2-E: keep the process-global fetch patch only as a compatibility fallback
// for Host-owned/raw-fetch visual providers. Router-owned provider HTTP already
// uses VisionProviderTransport and therefore never needs this seam.

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

/**
 * Install after core.apply has installed its lifecycle-safe legacy proxy patch.
 *
 * The outer gate bypasses that process-global patch entirely whenever the live
 * visual chain is Router-owned. If a Host-owned provider is configured, calls
 * fall through to the legacy patched fetch exactly as before. No request URL,
 * header or body is rewritten here; this boundary only decides whether the old
 * compatibility seam is allowed to participate.
 */
export function installLegacyGlobalProxyBoundary(ctx, config = {}, options = {}) {
  const originalFetch = typeof options.originalFetch === 'function'
    ? options.originalFetch
    : moduleFetch
  const legacyFetch = typeof globalThis.fetch === 'function'
    ? globalThis.fetch
    : undefined
  if (typeof originalFetch !== 'function' || typeof legacyFetch !== 'function') return () => {}

  let active = true
  const gatedFetch = (...args) => {
    if (!active) return originalFetch(...args)
    const current = liveConfig(ctx, config)
    return legacyGlobalProxyRequired(current)
      ? legacyFetch(...args)
      : originalFetch(...args)
  }

  globalThis.fetch = gatedFetch

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    active = false
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
