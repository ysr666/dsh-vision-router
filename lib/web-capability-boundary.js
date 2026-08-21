const wrappedContexts = new WeakMap()
const patchedWebServers = new WeakMap()

const LOCAL_MUTATION_ROUTES = new Map([
  ['/_dsh/vision-router/self-update', new Set(['POST'])],
  ['/_dsh/vision-router/logs', new Set(['POST'])],
  ['/_dsh/vision-router/request-screenshot-permission', new Set(['POST'])],
  ['/_dsh/vision-router/settings-save-diagnostics', new Set(['POST'])],
  // Model-invoking diagnostics spend user/provider quota and may resolve stored
  // credentials. DSH's WebServer is intentionally unauthenticated on LAN binds,
  // so these actions must inherit the same transport-level loopback capability
  // boundary as other local side effects. Keep the v2 benchmark path listed
  // here before it lands on main so merging v2 cannot accidentally reopen it.
  ['/_dsh/vision-router/test-vision-backend', new Set(['POST'])],
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

function guardedRoute(route) {
  if (!route || typeof route !== 'object' || typeof route.handler !== 'function') return route
  const mutationMethods = LOCAL_MUTATION_ROUTES.get(route.path)
  const sensitiveReadMethods = SENSITIVE_READ_ROUTES.get(route.path)
  if ((!mutationMethods || mutationMethods.size === 0) && (!sensitiveReadMethods || sensitiveReadMethods.size === 0)) {
    return route
  }
  const originalHandler = route.handler
  return {
    ...route,
    handler(req, res) {
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
function retainWebServerBoundary(webServer) {
  if (!webServer || (typeof webServer !== 'object' && typeof webServer !== 'function')) return () => {}
  if (typeof webServer.register !== 'function') return () => {}

  let state = patchedWebServers.get(webServer)
  if (!state) {
    const originalRegister = webServer.register
    let active = true
    const guardedRegister = function registerWithLocalMutationBoundary(route) {
      return originalRegister.call(this, active ? guardedRoute(route) : route)
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
 * DSH's all-interface WebServer deliberately has no TLS/auth/origin policy.
 * Same-origin checks therefore prevent browser CSRF but cannot authenticate a
 * LAN client. Keep plugin-owned OS/process/disk mutations local-UI-only and do
 * not issue their bearer capability tokens or host paths to remote clients.
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
            const release = retainWebServerBoundary(childCtx?.webServer)
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
