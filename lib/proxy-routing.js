import { domainToASCII } from 'node:url'

const ownedProxyDispatchers = new WeakSet()

function objectLike(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
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

/** Mark a dispatcher created by Vision Router; returns it for expression use. */
export function markVisionProxyDispatcher(dispatcher) {
  if (objectLike(dispatcher)) ownedProxyDispatchers.add(dispatcher)
  return dispatcher
}

/** True only for a dispatcher actually constructed by Vision Router. */
export function isVisionProxyDispatcher(dispatcher) {
  return objectLike(dispatcher) && ownedProxyDispatchers.has(dispatcher)
}
