import {
  ERROR_RESPONSE_MAX_BYTES,
  MODEL_RESPONSE_MAX_BYTES,
  readResponseJsonBounded,
  readResponseTextBounded,
} from './http-body-limit.js'

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

// Capture before core.apply installs the legacy process-wide fetch patch. The
// Router-owned transport uses this original function explicitly, so direct
// provider calls are not coupled to later globalThis.fetch mutation.
const moduleFetch =
  typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : undefined

const installed = []

function live(value) {
  return typeof value === 'function' ? value() : value
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asUrl(input) {
  try {
    return input instanceof URL ? input : new URL(typeof input === 'string' ? input : input?.url)
  } catch {
    return undefined
  }
}

function hostMatchesAny(hostname, hosts) {
  return (hosts ?? []).some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  )
}

function proxySettings(config) {
  const value = asObject(live(config))
  const proxy = typeof value.proxy === 'string' && value.proxy.trim() !== ''
    ? value.proxy.trim()
    : undefined
  const proxyHosts = Array.isArray(value.proxyHosts)
    ? value.proxyHosts.filter((host) => typeof host === 'string' && host.trim() !== '').map((host) => host.trim())
    : [...DEFAULT_PROXY_HOSTS]
  return { proxy, proxyHosts }
}

function credentialService(ctx) {
  try {
    return ctx?.get?.('credentials')
  } catch {
    return undefined
  }
}

function envCredential(ref) {
  if (typeof process === 'undefined' || !process.env) return undefined
  const value = process.env[ref]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Router-owned provider transport.
 *
 * It owns only direct visual-provider HTTP mechanics: the original fetch
 * implementation, provider-scoped proxy dispatch, credential lookup helpers,
 * bounded response readers and cancellation propagation. It intentionally does
 * not cover update checks, GitHub/npm maintenance traffic or Host-owned LLM
 * adapter requests.
 */
export function createVisionProviderTransport({
  ctx,
  config = {},
  fetchImpl = moduleFetch,
  importUndici = () => import('undici'),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('vision provider transport requires fetch')
  }

  let cachedProxyUrl
  let cachedDispatcherPromise
  const dispatcherFor = (proxyUrl) => {
    if (cachedProxyUrl === proxyUrl && cachedDispatcherPromise) return cachedDispatcherPromise
    cachedProxyUrl = proxyUrl
    cachedDispatcherPromise = Promise.resolve(importUndici()).then(({ ProxyAgent }) => {
      if (typeof ProxyAgent !== 'function') {
        throw new Error('vision provider transport: undici ProxyAgent is unavailable')
      }
      return new ProxyAgent(proxyUrl)
    }).catch((error) => {
      if (cachedProxyUrl === proxyUrl) {
        cachedProxyUrl = undefined
        cachedDispatcherPromise = undefined
      }
      throw error
    })
    return cachedDispatcherPromise
  }

  const fetchProvider = async (input, init = {}, context = {}) => {
    const url = asUrl(input)
    const { proxy, proxyHosts } = proxySettings(config)
    if (!url || !proxy || context.allowProxy === false || !hostMatchesAny(url.hostname, proxyHosts)) {
      return fetchImpl(input, init)
    }
    const dispatcher = await dispatcherFor(proxy)
    return fetchImpl(input, { ...init, dispatcher })
  }

  return Object.freeze({
    fetch: fetchProvider,

    async resolveCredential(ref) {
      const name = typeof ref === 'string' ? ref.trim() : ''
      if (!name) return undefined
      const credentials = credentialService(ctx)
      if (credentials && typeof credentials.resolve === 'function') {
        try {
          const hit = await credentials.resolve(name)
          if (hit && typeof hit.value === 'string' && hit.value !== '') return hit.value
        } catch {
          // Environment remains the compatibility fallback.
        }
      }
      return envCredential(name)
    },

    readErrorText(response, options = {}) {
      return readResponseTextBounded(
        response,
        options.maxBytes ?? ERROR_RESPONSE_MAX_BYTES,
        { label: options.label ?? 'vision provider error response' },
      )
    },

    readModelJson(response, options = {}) {
      return readResponseJsonBounded(
        response,
        options.maxBytes ?? MODEL_RESPONSE_MAX_BYTES,
        { label: options.label ?? 'vision provider response' },
      )
    },

    proxyDecision(input) {
      const url = asUrl(input)
      const { proxy, proxyHosts } = proxySettings(config)
      return Object.freeze({
        proxied: Boolean(url && proxy && hostMatchesAny(url.hostname, proxyHosts)),
        proxy,
        hostname: url?.hostname,
      })
    },
  })
}

/**
 * Scoped process/profile carrier for Router-owned compatibility calls whose
 * mature signatures do not yet accept an explicit VisionProviderTransport.
 * The registry never patches global fetch and is released with the public
 * plugin lifecycle. Remove it only after every production compatibility caller
 * receives the transport explicitly and no production code reads
 * currentVisionProviderTransport().
 */
export function installVisionProviderTransport(transport) {
  if (!transport || typeof transport.fetch !== 'function') {
    throw new TypeError('invalid vision provider transport')
  }
  const token = Object.freeze({ transport })
  installed.push(token)
  let active = true
  return () => {
    if (!active) return
    active = false
    const index = installed.indexOf(token)
    if (index >= 0) installed.splice(index, 1)
  }
}

export function currentVisionProviderTransport() {
  return installed[installed.length - 1]?.transport
}
