import { domainToASCII } from 'node:url'

function objectLike(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

/** True only when the user explicitly configured a Vision Router proxy override. */
export function visionProxyOverrideConfigured(config = {}) {
  const value = config && typeof config === 'object' ? config.proxy : undefined
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Canonicalize a configured/request hostname for proxy admission only.
 * Persisted settings stay untouched; this removes DNS presentation differences
 * (case, one trailing dot and Unicode) without broadening the suffix policy.
 */
export function canonicalProxyHost(value) {
  let host = String(value ?? '').trim()
  if (host === '') return ''
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (host === '') return ''

  // WHATWG URL.hostname keeps IPv6 literals bracketed. domainToASCII does not
  // accept a bare IPv6 literal, so preserve the bracketed spelling and only
  // case-fold it. Proxy hosts are otherwise DNS names and can be IDNA-folded.
  if (host.startsWith('[') && host.endsWith(']')) return host.toLowerCase()
  const ascii = domainToASCII(host)
  return (ascii || host).toLowerCase()
}

/** Exact host or subdomain match using one shared proxy-host interpretation. */
export function proxyHostMatchesAny(hostname, hosts) {
  const host = canonicalProxyHost(hostname)
  if (host === '') return false
  return (hosts ?? []).some((raw) => {
    const candidate = canonicalProxyHost(raw)
    return candidate !== '' && (host === candidate || host.endsWith(`.${candidate}`))
  })
}

export function proxyDispatcherLike(value) {
  return objectLike(value) && typeof value.dispatch === 'function'
}

function proxyDispatchOriginUrl(options) {
  try {
    const origin = options?.origin
    if (origin instanceof URL) return origin
    if (origin !== undefined && origin !== null) return new URL(String(origin))
  } catch {
    // Unknown dispatcher shapes never authorize the plugin proxy.
  }
  return undefined
}

/**
 * Preserve Fetch/Undici redirect semantics while keeping proxyHosts an upper
 * bound on every hop after a request has entered the DVR proxy override.
 * The fallback dispatcher is borrowed, never owned or closed by this selector.
 */
export function createPerHopProxyDispatcher(proxyDispatcher, fallbackDispatcher, proxyHosts = []) {
  if (!proxyDispatcherLike(proxyDispatcher) || !proxyDispatcherLike(fallbackDispatcher)) {
    throw new TypeError('vision proxy hop selector requires proxy and fallback dispatchers')
  }
  const hosts = [...proxyHosts]
  return Object.freeze({
    dispatch(options, handler) {
      const url = proxyDispatchOriginUrl(options)
      const target = url && proxyHostMatchesAny(url.hostname, hosts)
        ? proxyDispatcher
        : fallbackDispatcher
      return target.dispatch(options, handler)
    },
  })
}
