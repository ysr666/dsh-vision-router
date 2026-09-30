import { probeLocalBackends } from './local-connection-probe.js'
import {
  METADATA_RESPONSE_MAX_BYTES,
  readResponseJsonBounded,
} from './http-body-limit.js'

export const VISION_TEST_CONNECTION_PATH = '/_dsh/vision-router/test-connection'
export const VISION_MODEL_CAPABILITIES_PATH = '/_dsh/vision-router/model-capabilities'

function adapterAvailable(llm, provider) {
  try {
    llm?.registration?.(provider)
    return true
  } catch {
    return false
  }
}

async function probeModels(fetchImpl, baseURL, expectedModel, startedAt) {
  try {
    const response = await fetchImpl(`${String(baseURL).replace(/\/$/, '')}/models`, {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
    })
    const latencyMs = Date.now() - startedAt
    if (!response.ok) {
      return { ok: false, latencyMs, status: response.status, error: `HTTP ${response.status}` }
    }
    const data = await readResponseJsonBounded(
      response,
      METADATA_RESPONSE_MAX_BYTES,
      { label: 'vision backend /models response' },
    ).catch(() => undefined)
    const models = data && Array.isArray(data.data) ? data.data : undefined
    const count = models ? models.length : undefined
    if (
      typeof expectedModel === 'string' &&
      expectedModel !== '' &&
      models &&
      !models.some((entry) => entry && String(entry.id) === expectedModel)
    ) {
      return {
        ok: false,
        latencyMs,
        status: response.status,
        models: count,
        endpoint: baseURL,
        error: `configured model "${expectedModel}" was not returned by /models`,
      }
    }
    return { ok: true, latencyMs, status: response.status, models: count, endpoint: baseURL }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error && error.message ? error.message : String(error),
    }
  }
}

function getArray(factory) {
  const value = typeof factory === 'function' ? factory() : factory
  return Array.isArray(value) ? value : []
}

/**
 * Product diagnostics/settings-support routes kept outside visual Core.
 *
 * The caller supplies three coherent domain faces instead of a Core facade:
 * connection candidates/probes, capability snapshot production, and the
 * Host-ownership state rendered in the connection response. Authentication
 * and remote/local capability policy stay outside this module in the existing
 * scoped WebServer boundary.
 */
export function installVisionDiagnosticsRoutes(ctx, options = {}) {
  if (!ctx || typeof ctx.inject !== 'function') return ctx

  const connection = options.connection ?? {}
  const capabilities = options.capabilities ?? {}
  const ownership = options.ownership ?? {}
  const resolveCapability = connection.resolveCapability
  const collectCapabilities = capabilities.collect
  if (typeof resolveCapability !== 'function') {
    throw new TypeError('vision diagnostics routes require a connection capability resolver')
  }
  if (typeof collectCapabilities !== 'function') {
    throw new TypeError('vision diagnostics routes require a capability collector')
  }

  const llm = ctx.llm
  const httpRoute = typeof connection.httpRoute === 'string' && connection.httpRoute !== ''
    ? connection.httpRoute
    : 'vision-http'
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch

  const probeConnection = async () => {
    const started = Date.now()
    let first
    for (const pair of getArray(connection.candidatePairs)) {
      if (!pair) continue
      if (pair.provider !== httpRoute && !adapterAvailable(llm, pair.provider)) continue
      const capability = await resolveCapability(pair.provider, pair.model)
      if (capability?.attemptable !== false) {
        first = pair
        break
      }
    }

    const localProbe = await probeLocalBackends(
      getArray(connection.localBackends),
      (provider) => probeModels(fetchImpl, provider.baseURL, provider.model, started),
      started,
    )
    if (localProbe !== undefined) return localProbe

    const httpBackends = getArray(connection.httpBackends)
    if (first !== undefined && first.provider === httpRoute) {
      const entry = httpBackends.find((provider) => `${provider.name}/${provider.model}` === first.model)
      if (entry !== undefined) return probeModels(fetchImpl, entry.baseURL, entry.model, started)
    }

    if (first !== undefined) {
      try {
        await llm.resolveModelInfo(first.provider, first.model)
        return {
          ok: true,
          latencyMs: Date.now() - started,
          detail: `${first.provider}/${first.model} metadata resolved (no network call)`,
        }
      } catch (error) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          error: error && error.message ? error.message : String(error),
        }
      }
    }

    const httpFirst = httpBackends[0]
    if (httpFirst !== undefined) return probeModels(fetchImpl, httpFirst.baseURL, httpFirst.model, started)
    return { ok: false, error: 'no usable vision provider configured' }
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      return webCtx.webServer.register({
        kind: 'exact',
        path: VISION_TEST_CONNECTION_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET')
            res.writeHead(405)
            res.end()
            return
          }
          try {
            const result = await probeConnection()
            const officialRouteAvailable = adapterAvailable(llm, 'deepseek-official')
            result.stealth = {
              configured: ownership.stealthConfigured,
              active: false,
              reason: ownership.hostOwnsOfficialDeepSeek && !officialRouteAvailable
                ? 'host-owned-official-unavailable'
                : undefined,
              hostOwned: ownership.hostOwnsOfficialDeepSeek,
            }
            res.writeHead(result.ok ? 200 : 502, { 'content-type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
              ok: false,
              error: error && error.message ? error.message : String(error),
            }))
          }
        },
      })
    }, 'vision-router: test-connection route')
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: VISION_MODEL_CAPABILITIES_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET')
            res.writeHead(405)
            res.end()
            return
          }
          try {
            const snapshot = await collectCapabilities()
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
              capabilities: snapshot,
              builtinFallback: getArray(capabilities.builtinFallback),
              anonymousRpmPerModel: 2,
            }))
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
              capabilities: {},
              error: error && error.message ? error.message : String(error),
            }))
          }
        },
      }),
      'vision-router: model capabilities route',
    )
  })

  return ctx
}
