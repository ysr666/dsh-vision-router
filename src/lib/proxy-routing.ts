import type { Dispatcher } from 'undici'
import { URL, domainToASCII } from 'node:url'

export type FetchDispatcher = Dispatcher

export interface DispatcherLike {
  dispatch(options: unknown, handler: unknown): unknown
}

function objectLike(value: unknown): value is object | ((...args: never[]) => unknown) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

/** True only when the user explicitly configured a Vision Router proxy override. */
export function visionProxyOverrideConfigured(config: unknown = {}): boolean {
  const value = objectLike(config)
    ? (config as { proxy?: unknown }).proxy
    : undefined
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Canonicalize a configured/request hostname for proxy admission only.
 * Persisted settings stay untouched; this removes DNS presentation differences
 * (case, one trailing dot and Unicode) without broadening the suffix policy.
 */
export function canonicalProxyHost(value: unknown): string {
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
export function proxyHostMatchesAny(hostname: unknown, hosts: readonly unknown[] = []): boolean {
  const host = canonicalProxyHost(hostname)
  if (host === '') return false
  return hosts.some((raw) => {
    const candidate = canonicalProxyHost(raw)
    return candidate !== '' && (host === candidate || host.endsWith(`.${candidate}`))
  })
}

export function proxyDispatcherLike(value: unknown): value is DispatcherLike {
  return objectLike(value)
    && typeof (value as { dispatch?: unknown }).dispatch === 'function'
}

function proxyDispatchOriginUrl(options: unknown): URL | undefined {
  try {
    const origin = objectLike(options)
      ? (options as { origin?: unknown }).origin
      : undefined
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
export function createPerHopProxyDispatcher(
  proxyDispatcher: unknown,
  fallbackDispatcher: unknown,
  proxyHosts: readonly unknown[] = [],
): FetchDispatcher {
  if (!proxyDispatcherLike(proxyDispatcher) || !proxyDispatcherLike(fallbackDispatcher)) {
    throw new TypeError('vision proxy hop selector requires proxy and fallback dispatchers')
  }
  const hosts = [...proxyHosts]
  const proxy = proxyDispatcher as FetchDispatcher
  const fallback = fallbackDispatcher as FetchDispatcher

  // Fetch types model a full Undici Dispatcher, while fetch dispatch itself
  // consumes the dispatch() seam. A Host dispatcher may expose dispatch as a
  // frozen/non-configurable own property; using that borrowed object directly
  // as a Proxy target would make an overriding get trap violate ECMAScript
  // Proxy invariants. Use a neutral shell with the same prototype instead.
  //
  // Every non-dispatch read still resolves against and binds to the real
  // fallback Dispatcher, so the wrapper does not become a second owner for
  // close/destroy/event state and instanceof-style prototype checks remain
  // compatible with the borrowed dispatcher.
  const shell = Object.create(Object.getPrototypeOf(fallback)) as object

  return new Proxy(shell, {
    get(_target, property) {
      if (property === 'dispatch') {
        return (
          options: Parameters<FetchDispatcher['dispatch']>[0],
          handler: Parameters<FetchDispatcher['dispatch']>[1],
        ): ReturnType<FetchDispatcher['dispatch']> => {
          const url = proxyDispatchOriginUrl(options)
          const selected = url && proxyHostMatchesAny(url.hostname, hosts)
            ? proxy
            : fallback
          return selected.dispatch(options, handler)
        }
      }
      const value = Reflect.get(fallback, property, fallback)
      return typeof value === 'function' ? value.bind(fallback) : value
    },
  }) as FetchDispatcher
}
