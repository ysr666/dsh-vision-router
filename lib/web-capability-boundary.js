const wrappedContexts = new WeakMap()
const patchedWebServers = new WeakMap()

const VISION_ROUTER_WEB_PREFIX = '/_dsh/vision-router/'

const LOCAL_MUTATION_ROUTES = new Map([
  ['/_dsh/vision-router/self-update', new Set(['POST'])],
  ['/_dsh/vision-router/logs', new Set(['POST'])],
  ['/_dsh/vision-router/request-screenshot-permission', new Set(['POST'])],
  ['/_dsh/vision-router/settings-save-diagnostics', new Set(['POST'])],
  // Model-invoking capability measurements spend user/provider quota and may
  // resolve stored credentials, so they inherit the local transport boundary.
  ['/_dsh/vision-router/capability-benchmark', new Set(['POST', 'DELETE'])],
])
const SENSITIVE_READ_ROUTES = new Map([
  ['/_dsh/vision-router/update-check', new Set(['GET'])],
  ['/_dsh/vision-router/logs', new Set(['GET'])],
])

function cleanAddress(value) {
  let text = String(value ?? '').trim().toLowerCase()
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)
  return text
}

/** True only for transport-level loopback peers; no Host/Origin header trust. */
export function isLoopbackAddress(value) {
  let address = cleanAddress(value)
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true
  if (address.startsWith('::ffff:')) address = address.slice('::ffff:'.length)
  const match = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!match) return false
  const octets = match.slice(1).map(Number)
  if (octets.some((part) => part < 0 || part > 255)) return false
  return octets[0] === 127
}

export function isLoopbackRequest(req) {
  const transport = req?.socket ?? req?.connection
  // Real node:http IncomingMessage objects always carry a transport socket.
  // A missing socket therefore means an internal/synthetic invocation (unit
  // tests, direct handler calls), not a remotely attributable network peer.
  if (!transport) return true
  return isLoopbackAddress(transport.remoteAddress)
}

function requestHostName(req) {
  const raw = String(req?.headers?.host ?? '').trim().toLowerCase()
  if (raw === '') return ''
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']')
    return close > 0 ? raw.slice(1, close) : ''
  }
  const colon = raw.lastIndexOf(':')
  return colon >= 0 ? raw.slice(0, colon) : raw
}

function isLocalHostName(value) {
  const host = cleanAddress(value)
  return host === 'localhost' || host.endsWith('.localhost') || isLoopbackAddress(host)
}

/**
 * Browser-facing local capability check. A real network request needs BOTH a
 * loopback TCP peer and a loopback/localhost Host header. This prevents the
 * common reverse-proxy shape (proxy -> 127.0.0.1, external Host preserved)
 * from silently acquiring local-machine capabilities. Internal direct handler
 * calls have no transport and remain compatible for tests/host composition.
 */
export function isLocalUiRequest(req) {
  const transport = req?.socket ?? req?.connection
  if (!transport) return true
  return isLoopbackAddress(transport.remoteAddress) && isLocalHostName(requestHostName(req))
}

export function isLocalMutationRoute(path, method) {
  const methods = LOCAL_MUTATION_ROUTES.get(String(path ?? ''))
  return methods?.has(String(method ?? '').toUpperCase()) === true
}

function rejectRemoteMutation(res) {
  res.writeHead(403, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify({
    ok: false,
    error: 'this local-machine action is available only from the local DSH UI',
  }))
}

function rejectUnauthenticatedHostRequest(res, status) {
  const code = status === 403 ? 403 : 401
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify({
    ok: false,
    error: code === 401 ? 'dsh web authentication required' : 'dsh web request rejected',
  }))
}

function hostRequestRejection(req, getConnection) {
  // Direct handler calls and unit fixtures intentionally have no transport and
  // are not browser requests. Do not turn alpha.1 browser authentication into
  // a new requirement for internal Host composition or old compatibility tests.
  if (!req?.socket && !req?.connection) return undefined
  let connection
  try { connection = typeof getConnection === 'function' ? getConnection() : undefined }
  catch { connection = undefined }
  const requestRejection = connection && typeof connection.requestRejection === 'function'
    ? connection.requestRejection.bind(connection)
    : undefined
  if (requestRejection === undefined) return undefined
  try {
    const status = requestRejection(req)
    return status === 401 || status === 403 ? status : undefined
  } catch {
    // Host authentication is a security boundary. If an alpha/newer Host
    // advertises it but cannot evaluate this request, fail closed rather than
    // silently falling back to the pre-authenticated rc.6/rc.7 behavior.
    return 403
  }
}

function redactRemoteBody(path, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  if (path === '/_dsh/vision-router/update-check') {
    const auto = body.autoUpdate
    if (!auto || typeof auto !== 'object' || Array.isArray(auto) || auto.token === undefined) return body
    const { token: _secret, ...safeAuto } = auto
    return { ...body, autoUpdate: safeAuto }
  }
  if (path === '/_dsh/vision-router/logs') {
    const { directory: _directory, file: _file, ...safe } = body
    return { ...safe, local: false, canOpen: false }
  }
  return body
}

/** Intercept one JSON end() so local capability material is never issued remotely. */
function runWithRemoteReadRedaction(path, handler, req, res) {
  const originalEnd = res?.end
  if (typeof originalEnd !== 'function') return handler(req, res)
  let active = true
  res.end = function redactedEnd(chunk, ...args) {
    if (!active) return originalEnd.call(this, chunk, ...args)
    let next = chunk
    try {
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
        const parsed = JSON.parse(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : chunk)
        next = JSON.stringify(redactRemoteBody(path, parsed))
        try { this.removeHeader?.('content-length') } catch { /* best effort */ }
      }
    } catch {
      // If a future handler stops returning JSON, do not corrupt its response.
    }
    return originalEnd.call(this, next, ...args)
  }
  const redactedEndReference = res.end
  const restore = () => {
    active = false
    if (res.end === redactedEndReference) res.end = originalEnd
  }
  let result
  try {
    result = handler(req, res)
  } catch (error) {
    restore()
    throw error
  }
  if (result && typeof result.then === 'function') return result.finally(restore)
  restore()
  return result
}

function guardedRoute(route, getConnection) {
  if (!route || typeof route !== 'object' || typeof route.handler !== 'function') return route
  const pluginOwned = typeof route.path === 'string' && route.path.startsWith(VISION_ROUTER_WEB_PREFIX)
  const mutationMethods = LOCAL_MUTATION_ROUTES.get(route.path)
  const sensitiveReadMethods = SENSITIVE_READ_ROUTES.get(route.path)
  if (!pluginOwned && (!mutationMethods || mutationMethods.size === 0) && (!sensitiveReadMethods || sensitiveReadMethods.size === 0)) {
    return route
  }
  const originalHandler = route.handler
  return {
    ...route,
    handler(req, res) {
      if (pluginOwned) {
        const rejection = hostRequestRejection(req, getConnection)
        if (rejection !== undefined) {
          rejectUnauthenticatedHostRequest(res, rejection)
          return undefined
        }
      }
      const method = String(req?.method ?? '').toUpperCase()
      const localUi = isLocalUiRequest(req)
      if (mutationMethods?.has(method) && !localUi) {
        rejectRemoteMutation(res)
        return undefined
      }
      if (sensitiveReadMethods?.has(method) && !localUi) {
        return runWithRemoteReadRedaction(route.path, originalHandler, req, res)
      }
      return originalHandler(req, res)
    },
  }
}

/**
 * Patch one WebServer service instance without replacing its injected Cordis
 * child context. DSH rc.6/rc.7 use that exact child identity for effect
 * ownership, so the service method is the narrow safe interception point.
 */
function retainWebServerBoundary(webServer, getConnection) {
  if (!webServer || (typeof webServer !== 'object' && typeof webServer !== 'function')) return () => {}
  if (typeof webServer.register !== 'function') return () => {}

  let state = patchedWebServers.get(webServer)
  if (!state) {
    const originalRegister = webServer.register
    let active = true
    const guardedRegister = function registerWithLocalMutationBoundary(route) {
      return originalRegister.call(this, active ? guardedRoute(route, getConnection) : route)
    }
    webServer.register = guardedRegister
    state = { count: 0, originalRegister, guardedRegister, deactivate: () => { active = false } }
    patchedWebServers.set(webServer, state)
  }
  state.count += 1

  let released = false
  return () => {
    if (released) return
    released = true
    state.count = Math.max(0, state.count - 1)
    if (state.count !== 0) return
    state.deactivate()
    if (webServer.register === state.guardedRegister) webServer.register = state.originalRegister
    patchedWebServers.delete(webServer)
  }
}

/**
 * DSH rc.6/rc.7 expose no browser-authentication service for named plugin
 * routes, so the historical local-machine fences below remain the compatibility
 * floor. DSH 0.1.2-alpha.1 adds `connection.requestRejection(req)` specifically
 * so another Web route can inherit the Host/Origin + signed-browser-session
 * boundary. Feature-detect that seam and apply it to every DVR-owned named
 * route before the plugin's narrower local-mutation/read-redaction policy.
 */
export function installLocalMutationRouteBoundary(ctx) {
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return ctx
  const cached = wrappedContexts.get(ctx)
  if (cached) return cached

  const wrapped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'inject') {
        const inject = Reflect.get(target, property, target)
        if (typeof inject !== 'function') return inject
        return (dependencies, callback, ...rest) => {
          if (!Array.isArray(dependencies) || !dependencies.includes('webServer') || typeof callback !== 'function') {
            return inject.call(target, dependencies, callback, ...rest)
          }
          return inject.call(target, dependencies, (childCtx) => {
            const getConnection = () => {
              try {
                if (typeof childCtx?.get === 'function') return childCtx.get('connection')
              } catch {}
              try {
                if (typeof target?.get === 'function') return target.get('connection')
              } catch {}
              return childCtx?.connection ?? target?.connection
            }
            const release = retainWebServerBoundary(childCtx?.webServer, getConnection)
            let owned = false
            try {
              if (typeof childCtx?.effect === 'function') {
                childCtx.effect(() => release, 'vision-router: local mutation transport boundary')
                owned = true
              }
            } catch {
              /* fall back to the parent lifetime below */
            }
            if (!owned) {
              try {
                target.effect?.(() => release, 'vision-router: local mutation transport boundary fallback')
              } catch {
                /* service replacement still drops its registered routes */
              }
            }
            // Preserve the ORIGINAL child context identity for rc.6 ownership.
            return callback(childCtx)
          }, ...rest)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  wrappedContexts.set(ctx, wrapped)
  return wrapped
}
