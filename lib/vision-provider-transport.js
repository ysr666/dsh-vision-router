import {
  ERROR_RESPONSE_MAX_BYTES,
  MODEL_RESPONSE_MAX_BYTES,
  readResponseJsonBounded,
  readResponseTextBounded,
} from './http-body-limit.js'
import { effectiveProxyUrlForUndici } from './proxy-url-compat.js'
import {
  markVisionProxyDispatcher,
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

function proxySettings(config) {
  const value = asObject(live(config))
  const proxy = visionProxyOverrideConfigured(value) ? value.proxy.trim() : undefined
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
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('vision provider transport requires fetch')
  }

  let cachedEntry
  let disposed = false
  let disposePromise
  const liveEntries = new Set()

  const closeDispatcher = async (dispatcher) => {
    if (!dispatcher || (typeof dispatcher !== 'object' && typeof dispatcher !== 'function')) return
    try {
      if (typeof dispatcher.close === 'function') {
        await dispatcher.close()
        return
      }
      if (typeof dispatcher.destroy === 'function') await dispatcher.destroy()
    } catch {
      // Cleanup must not turn a completed provider request into an unload failure.
    }
  }

  const maybeCloseEntry = (entry) => {
    if (!entry.obsolete || entry.refs !== 0 || !entry.dispatcher || entry.closing) return
    entry.closing = Promise.resolve()
      .then(() => closeDispatcher(entry.dispatcher))
      .finally(() => {
        liveEntries.delete(entry)
        entry.resolveDone()
      })
  }

  const retireEntry = (entry) => {
    if (!entry || entry.obsolete) return
    entry.obsolete = true
    maybeCloseEntry(entry)
  }

  const createDispatcherEntry = (proxyUrl) => {
    let resolveDone
    const entry = {
      proxyUrl,
      refs: 0,
      obsolete: false,
      dispatcher: undefined,
      closing: undefined,
      done: new Promise((resolve) => { resolveDone = resolve }),
      resolveDone: () => resolveDone(),
      promise: undefined,
    }
    liveEntries.add(entry)
    entry.promise = Promise.resolve()
      .then(() => importUndici())
      .then(({ ProxyAgent }) => {
        if (typeof ProxyAgent !== 'function') {
          throw new Error('vision provider transport: undici ProxyAgent is unavailable')
        }
        entry.dispatcher = markVisionProxyDispatcher(new ProxyAgent(proxyUrl))
        maybeCloseEntry(entry)
        return entry.dispatcher
      })
      .catch((error) => {
        if (cachedEntry === entry) cachedEntry = undefined
        liveEntries.delete(entry)
        entry.resolveDone()
        throw error
      })
    return entry
  }

  const reconcileProxyIdentity = (effectiveProxyUrl) => {
    if (cachedEntry && cachedEntry.proxyUrl !== effectiveProxyUrl) {
      const previous = cachedEntry
      cachedEntry = undefined
      retireEntry(previous)
    }
  }

  const acquireDispatcher = async (proxyUrl) => {
    let entry = cachedEntry
    if (!entry || entry.proxyUrl !== proxyUrl || entry.obsolete) {
      if (entry) retireEntry(entry)
      entry = createDispatcherEntry(proxyUrl)
      cachedEntry = entry
    }
    entry.refs += 1
    try {
      const dispatcher = await entry.promise
      let released = false
      return {
        dispatcher,
        release() {
          if (released) return
          released = true
          entry.refs = Math.max(0, entry.refs - 1)
          maybeCloseEntry(entry)
        },
      }
    } catch (error) {
      entry.refs = Math.max(0, entry.refs - 1)
      maybeCloseEntry(entry)
      throw error
    }
  }

  const fetchProvider = async (input, init = {}, context = {}) => {
    if (disposed) return fetchImpl(input, init)
    const url = asUrl(input)
    const { proxy, proxyHosts } = proxySettings(config)
    const effectiveProxyUrl = proxy ? effectiveProxyUrlForUndici(proxy) : undefined
    reconcileProxyIdentity(effectiveProxyUrl)
    if (!url || !effectiveProxyUrl || context.allowProxy === false || !proxyHostMatchesAny(url.hostname, proxyHosts)) {
      return fetchImpl(input, init)
    }
    const lease = await acquireDispatcher(effectiveProxyUrl)
    try {
      return await fetchImpl(input, { ...init, dispatcher: lease.dispatcher })
    } finally {
      lease.release()
    }
  }

  const dispose = () => {
    if (disposePromise) return disposePromise
    disposed = true
    const current = cachedEntry
    cachedEntry = undefined
    retireEntry(current)
    for (const entry of liveEntries) retireEntry(entry)
    disposePromise = Promise.all([...liveEntries].map((entry) => entry.done)).then(() => undefined)
    return disposePromise
  }

  return Object.freeze({
    fetch: fetchProvider,
    dispose,

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
        proxied: Boolean(url && proxy && proxyHostMatchesAny(url.hostname, proxyHosts)),
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
