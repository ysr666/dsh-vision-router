import type { RequestInit as UndiciRequestInit } from 'undici'
import {
  ERROR_RESPONSE_MAX_BYTES,
  MODEL_RESPONSE_MAX_BYTES,
  readResponseJsonBounded,
  readResponseTextBounded,
} from './http-body-limit.js'
import { effectiveProxyUrlForUndici } from './proxy-url-compat.js'
import { createProxyDispatcherPool } from './proxy-dispatcher-pool.js'
import {
  createPerHopProxyDispatcher,
  proxyDispatcherLike,
  proxyHostMatchesAny,
  visionProxyOverrideConfigured,
} from './proxy-routing.js'

const DEFAULT_PROXY_HOSTS = Object.freeze([
  'api.openrouter.ai',
  'openrouter.ai',
  'api.openai.com',
  'api.anthropic.com',
  'api.groq.com',
  'api.mistral.ai',
  'api.together.xyz',
  'generativelanguage.googleapis.com',
  'api.x.ai',
])

type FetchInput = string | URL | Request

export type ProviderFetchInit = UndiciRequestInit

export type ProviderFetch = (
  input: FetchInput,
  init?: ProviderFetchInit,
) => Promise<Response>

export interface VisionProviderTransportContext {
  get?(name: string): unknown
}

export interface VisionProviderTransportOptions {
  readonly ctx?: VisionProviderTransportContext
  readonly config?: unknown | (() => unknown)
  readonly fetchImpl?: ProviderFetch
  readonly importUndici?: () => unknown | PromiseLike<unknown>
}

export interface VisionProviderFetchContext {
  readonly allowProxy?: boolean
}

export interface VisionProviderReadOptions {
  readonly maxBytes?: number
  readonly label?: string
}

export interface VisionProviderProxyDecision {
  readonly proxied: boolean
  readonly proxy: string | undefined
  readonly hostname: string | undefined
}

export interface VisionProviderTransport {
  fetch(
    input: FetchInput,
    init?: ProviderFetchInit,
    context?: VisionProviderFetchContext,
  ): Promise<Response>
  dispose(): Promise<void>
  resolveCredential(ref: unknown): Promise<string | undefined>
  readErrorText(response: unknown, options?: VisionProviderReadOptions): Promise<string>
  readModelJson(response: unknown, options?: VisionProviderReadOptions): Promise<unknown>
  proxyDecision(input: unknown): Readonly<VisionProviderProxyDecision>
}

// Capture before core.apply installs the legacy process-wide fetch patch. The
// Router-owned transport uses this original function explicitly, so direct
// provider calls are not coupled to later globalThis.fetch mutation.
type HostFetchInit = Parameters<typeof globalThis.fetch>[1]

const capturedHostFetch =
  typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : undefined

const moduleFetch: ProviderFetch | undefined = capturedHostFetch
  ? (input, init) => capturedHostFetch(input, init as HostFetchInit)
  : undefined

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function live(value: unknown | (() => unknown)): unknown {
  return typeof value === 'function' ? value() : value
}

function asObject(value: unknown): Record<string, unknown> {
  return objectRecord(value) ?? {}
}

function asUrl(input: unknown): URL | undefined {
  try {
    if (input instanceof URL) return input
    if (typeof input === 'string') return new URL(input)
    const raw = objectRecord(input)?.url
    return typeof raw === 'string' ? new URL(raw) : undefined
  } catch {
    return undefined
  }
}

function proxySettings(config: unknown | (() => unknown)): {
  proxy: string | undefined
  proxyHosts: string[]
} {
  const value = asObject(live(config))
  const rawProxy = value.proxy
  const proxy = visionProxyOverrideConfigured(value) && typeof rawProxy === 'string'
    ? rawProxy.trim()
    : undefined
  const proxyHosts = Array.isArray(value.proxyHosts)
    ? value.proxyHosts
      .filter((host): host is string => typeof host === 'string' && host.trim() !== '')
      .map((host) => host.trim())
    : [...DEFAULT_PROXY_HOSTS]
  return { proxy, proxyHosts }
}

function credentialService(ctx: VisionProviderTransportContext | undefined): {
  resolve?(ref: string): unknown
} | undefined {
  try {
    const service = ctx?.get?.('credentials')
    return service !== null && (typeof service === 'object' || typeof service === 'function')
      ? service as { resolve?(ref: string): unknown }
      : undefined
  } catch {
    return undefined
  }
}

function envCredential(ref: string): string | undefined {
  const value = process.env[ref]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Router-owned provider transport.
 *
 * It owns only direct visual-provider HTTP mechanics: the Host fetch function,
 * optional provider-scoped proxy OVERRIDE dispatch, credential lookup helpers,
 * bounded response readers and cancellation propagation. With no explicit plugin
 * proxy, fetch is forwarded without a dispatcher so DSH/Host's ambient network
 * policy remains authoritative. It intentionally does not cover update checks,
 * GitHub/npm maintenance traffic or Host-owned LLM adapter requests.
 */
export function createVisionProviderTransport({
  ctx,
  config = {},
  fetchImpl = moduleFetch,
  importUndici = () => import('undici'),
}: VisionProviderTransportOptions = {}): Readonly<VisionProviderTransport> {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('vision provider transport requires fetch')
  }

  let disposed = false
  let disposePromise: Promise<void> | undefined
  const dispatcherPool = createProxyDispatcherPool({
    importUndici,
    label: 'vision provider transport',
  })

  const fetchProvider = async (
    input: FetchInput,
    init: ProviderFetchInit = {},
    context: VisionProviderFetchContext = {},
  ): Promise<Response> => {
    if (disposed) return fetchImpl(input, init)
    const url = asUrl(input)
    const { proxy, proxyHosts } = proxySettings(config)
    const effectiveProxyUrl = proxy ? effectiveProxyUrlForUndici(proxy) : undefined
    dispatcherPool.reconcile(effectiveProxyUrl)
    if (
      !url
      || !effectiveProxyUrl
      || context.allowProxy === false
      || !proxyHostMatchesAny(url.hostname, proxyHosts)
    ) {
      return fetchImpl(input, init)
    }
    const lease = await dispatcherPool.acquire(effectiveProxyUrl)
    try {
      const fallbackDispatcher = proxyDispatcherLike(init.dispatcher)
        ? init.dispatcher
        : lease.getGlobalDispatcher()
      const dispatcher = createPerHopProxyDispatcher(
        lease.dispatcher,
        fallbackDispatcher,
        proxyHosts,
      )
      return await fetchImpl(input, { ...init, dispatcher })
    } finally {
      lease.release()
    }
  }

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise
    disposed = true
    disposePromise = dispatcherPool.dispose()
    return disposePromise
  }

  return Object.freeze({
    fetch: fetchProvider,
    dispose,

    async resolveCredential(ref: unknown): Promise<string | undefined> {
      const name = typeof ref === 'string' ? ref.trim() : ''
      if (!name) return undefined
      const credentials = credentialService(ctx)
      try {
        const resolve = credentials?.resolve
        if (typeof resolve === 'function') {
          const hit = await Reflect.apply(resolve, credentials, [name])
          const value = objectRecord(hit)?.value
          if (typeof value === 'string' && value !== '') return value
        }
      } catch {
        // A missing/partial/throwing Host credential service must not suppress
        // the supported environment-variable compatibility fallback.
      }
      return envCredential(name)
    },

    readErrorText(
      response: unknown,
      options: VisionProviderReadOptions = {},
    ): Promise<string> {
      return readResponseTextBounded(
        response,
        options.maxBytes ?? ERROR_RESPONSE_MAX_BYTES,
        { label: options.label ?? 'vision provider error response' },
      )
    },

    readModelJson(
      response: unknown,
      options: VisionProviderReadOptions = {},
    ): Promise<unknown> {
      return readResponseJsonBounded(
        response,
        options.maxBytes ?? MODEL_RESPONSE_MAX_BYTES,
        { label: options.label ?? 'vision provider response' },
      )
    },

    proxyDecision(input: unknown): Readonly<VisionProviderProxyDecision> {
      const url = asUrl(input)
      const { proxy, proxyHosts } = proxySettings(config)
      return Object.freeze({
        proxied: Boolean(url && proxy && proxyHostMatchesAny(url.hostname, proxyHosts)),
        proxy,
        hostname: url?.hostname,
      })
    },
  })
}
