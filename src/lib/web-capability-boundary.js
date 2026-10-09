const wrappedContexts = new WeakMap()

const VISION_ROUTER_WEB_PREFIX = '/_dsh/vision-router/'

export const WEB_ROUTE_REMOTE_CAPABILITY = Object.freeze({
  ALLOW_REMOTE: 'allow-remote',
  REDACT_REMOTE: 'redact-remote',
  LOCAL_ONLY: 'local-only',
})

// One declaration owns every browser-facing capability exception. Route method
// is part of the key because the same path may be a redacted GET and a local-
// only POST. `legacyMutation` preserves the historical helper semantics for
// callers that use isLocalMutationRoute(); local-only GET capabilities such as
// test-connection are intentionally not reclassified as mutations.
const ROUTE_CAPABILITY_POLICIES = new Map([
  ['/_dsh/vision-router/self-update', new Map([
    ['POST', { remote: WEB_ROUTE_REMOTE_CAPABILITY.LOCAL_ONLY, legacyMutation: true }],
  ])],
  ['/_dsh/vision-router/logs', new Map([
    ['GET', { remote: WEB_ROUTE_REMOTE_CAPABILITY.REDACT_REMOTE }],
    ['POST', { remote: WEB_ROUTE_REMOTE_CAPABILITY.LOCAL_ONLY, legacyMutation: true }],
  ])],
  ['/_dsh/vision-router/request-screenshot-permission', new Map([
    ['POST', { remote: WEB_ROUTE_REMOTE_CAPABILITY.LOCAL_ONLY, legacyMutation: true }],
  ])],
  ['/_dsh/vision-router/settings-save-diagnostics', new Map([
    ['POST', { remote: WEB_ROUTE_REMOTE_CAPABILITY.LOCAL_ONLY, legacyMutation: true }],
  ])],
  // Model-invoking capability measurements spend user/provider quota and may
  // resolve stored credentials, so they inherit the local transport boundary.
  ['/_dsh/vision-router/capability-benchmark', new Map([
    ['GET', { remote: WEB_ROUTE_REMOTE_CAPABILITY.ALLOW_REMOTE }],
    ['POST', { remote: WEB_ROUTE_REMOTE_CAPABILITY.LOCAL_ONLY, legacyMutation: true }],
    ['DELETE', { remote: WEB_ROUTE_REMOTE_CAPABILITY.LOCAL_ONLY, legacyMutation: true }],
  ])],
  ['/_dsh/vision-router/capability-runtime', new Map([
    ['GET', { remote: WEB_ROUTE_REMOTE_CAPABILITY.ALLOW_REMOTE }],
    ['POST', { remote: WEB_ROUTE_REMOTE_CAPABILITY.LOCAL_ONLY, legacyMutation: true }],
  ])],
  ['/_dsh/vision-router/host-capabilities', new Map([
    ['GET', { remote: WEB_ROUTE_REMOTE_CAPABILITY.ALLOW_REMOTE }],
  ])],
  // Remote settings may consume already-discovered model ids, but a remote GET
  // must never gain the Host-side network refresh capability. The handler
  // independently suppresses scheduling unless the transport is local.
  ['/_dsh/vision-router/live-models', new Map([
    ['GET', { remote: WEB_ROUTE_REMOTE_CAPABILITY.ALLOW_REMOTE }],
  ])],
  ['/_dsh/vision-router/model-capabilities', new Map([
    ['GET', { remote: WEB_ROUTE_REMOTE_CAPABILITY.ALLOW_REMOTE }],
  ])],
  ['/_dsh/vision-router/remote-settings-permission', new Map([
    ['POST', { remote: WEB_ROUTE_REMOTE_CAPABILITY.LOCAL_ONLY, legacyMutation: true }],
  ])],
  ['/_dsh/vision-router/route-ownership', new Map([
    ['GET', { remote: WEB_ROUTE_REMOTE_CAPABILITY.ALLOW_REMOTE }],
  ])],
  // A connectivity probe is a GET, but it drives the Host to contact configured
  // local/private model endpoints and returns endpoint health metadata. Treat
  // the capability side effect as local-only rather than as an ordinary read.
  ['/_dsh/vision-router/test-connection', new Map([
    ['GET', { remote: WEB_ROUTE_REMOTE_CAPABILITY.LOCAL_ONLY }],
  ])],
  ['/_dsh/vision-router/update-check', new Map([
    ['GET', { remote: WEB_ROUTE_REMOTE_CAPABILITY.REDACT_REMOTE }],
  ])],
])

// DVR-owned browser routes are closed-world capabilities: a new route is local-only
// until its exact method is reviewed and declared above. This makes omission fail closed.
const DEFAULT_ROUTE_POLICY = Object.freeze({ remote: WEB_ROUTE_REMOTE_CAPABILITY.LOCAL_ONLY })

function routeCapabilityPolicy(path, method) {
  const methods = ROUTE_CAPABILITY_POLICIES.get(String(path ?? ''))
  return methods?.get(String(method ?? '').toUpperCase()) ?? DEFAULT_ROUTE_POLICY
}

/** Public classification seam for tests/doctor without exposing policy maps. */
export function webRouteRemoteCapability(path, method) {
  return routeCapabilityPolicy(path, method).remote
}

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
  return routeCapabilityPolicy(path, method).legacyMutation === true
}

function rejectRemoteLocalCapability(res) {
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

// Remote metadata is small. Never buffer an unbounded response from a future
// handler revision: local-only diagnostics should not turn into remote memory DoS.
const MAX_REMOTE_REDACTION_BYTES = 1024 * 1024

/**
 * A remote response requiring redaction must be completely validated *before*
 * emitting headers or bytes. Unlike intercepting end() alone, this also covers
 * write()+end(), malformed JSON, oversize bodies and async stream completion.
 * No handler may transmit its raw token, path or other local fields while the
 * remote body remains unvalidated.
 */
function runWithRemoteReadRedaction(path, handler, req, res) {
  const originalEnd = res?.end
  const originalWrite = res?.write
  const originalWriteHead = res?.writeHead
  const originalFlushHeaders = res?.flushHeaders
  if (typeof originalEnd !== 'function' || typeof originalWriteHead !== 'function') {
    throw new TypeError('vision-router: remote redaction requires a buffered HTTP response')
  }

  const chunks = []
  let bytes = 0
  let done = false
  let head
  const restore = () => {
    if (res.end === redactedEnd) res.end = originalEnd
    if (res.write === redactedWrite) {
      if (originalWrite === undefined) delete res.write
      else res.write = originalWrite
    }
    if (res.writeHead === redactedWriteHead) res.writeHead = originalWriteHead
    if (res.flushHeaders === redactedFlushHeaders) {
      if (originalFlushHeaders === undefined) delete res.flushHeaders
      else res.flushHeaders = originalFlushHeaders
    }
  }
  const stripBodyHeaders = () => {
    for (const key of ['content-length', 'content-encoding', 'transfer-encoding']) {
      try { res.removeHeader?.(key) } catch { /* response may be a test double */ }
    }
  }
  const safeHeaders = (headers) => {
    const next = {}
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
      for (const [key, value] of Object.entries(headers)) {
        if (!['content-length', 'content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
          next[key] = value
        }
      }
    }
    return { ...next, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  }
  const complete = (body, rejected = false, callback) => {
    if (done) return res
    done = true
    // On rejection, deliberately retain the buffered wrappers after sending
    // the safe error. A drifting async handler may continue calling write()
    // or end(); restoring the raw methods here would expose those later bytes.
    // The response is already ended and these wrappers swallow late writes.
    if (!rejected) restore()
    stripBodyHeaders()
    if (rejected) {
      // An invalid or oversized response is an internal gateway failure. Do
      // not repeat the untrusted data or send previously staged headers.
      try {
        for (const key of res.getHeaderNames?.() ?? []) res.removeHeader?.(key)
      } catch {}
      originalWriteHead.call(res, 502, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      return originalEnd.call(res, JSON.stringify({
        ok: false,
        error: 'remote response could not be safely redacted',
      }), callback)
    }
    if (head) {
      const { status, message, headers } = head
      if (message !== undefined) {
        originalWriteHead.call(res, status, message, safeHeaders(headers))
      } else {
        originalWriteHead.call(res, status, safeHeaders(headers))
      }
    } else {
      originalWriteHead.call(res, Number.isInteger(res.statusCode) ? res.statusCode : 200, safeHeaders())
    }
    return originalEnd.call(res, body, callback)
  }
  const append = (chunk, encoding) => {
    if (chunk === undefined || chunk === null) return true
    let value
    try {
      if (Buffer.isBuffer(chunk)) value = chunk
      else if (typeof chunk === 'string') value = Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8')
      else if (chunk instanceof Uint8Array) value = Buffer.from(chunk)
      else return false
    } catch { return false }
    if (value.length > MAX_REMOTE_REDACTION_BYTES - bytes) return false
    bytes += value.length
    chunks.push(value)
    return true
  }
  const failed = () => complete(undefined, true)
  function redactedWriteHead(status, maybeMessage, maybeHeaders) {
    if (done) return this
    const message = typeof maybeMessage === 'string' ? maybeMessage : undefined
    const headers = message === undefined ? maybeMessage : maybeHeaders
    if (head || !Number.isInteger(status) || status < 100 || status > 599 ||
      (headers !== undefined && (!headers || typeof headers !== 'object' || Array.isArray(headers)))) {
      failed()
      return this
    }
    head = { status, message, headers }
    return this
  }
  function redactedFlushHeaders() {
    // Deferring the header is essential: once sent, an invalid JSON body
    // cannot be replaced by a safe 502.
  }
  function redactedWrite(chunk, encoding, callback) {
    const completeWrite = typeof encoding === 'function' ? encoding : callback
    if (!done && !append(chunk, encoding)) failed()
    if (typeof completeWrite === 'function') queueMicrotask(completeWrite)
    return !done
  }
  function redactedEnd(chunk, encoding, callback) {
    if (done) return res
    const completeEnd = typeof encoding === 'function' ? encoding : callback
    if (!append(chunk, encoding)) return failed()
    try {
      const body = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
      if (!body || typeof body !== 'object' || Array.isArray(body)) return failed()
      const redacted = JSON.stringify(redactRemoteBody(path, body))
      if (Buffer.byteLength(redacted, 'utf8') > MAX_REMOTE_REDACTION_BYTES) return failed()
      return complete(redacted, false, completeEnd)
    } catch {
      return failed()
    }
  }

  res.writeHead = redactedWriteHead
  res.write = redactedWrite
  res.end = redactedEnd
  res.flushHeaders = redactedFlushHeaders
  try {
    const result = handler(req, res)
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).catch(() => { if (!done) failed() })
    }
    return result
  } catch {
    if (!done) failed()
    return undefined
  }
}

function guardedRoute(route, getConnection) {
  if (!route || typeof route !== 'object' || typeof route.handler !== 'function') return route
  const pluginOwned = typeof route.path === 'string' && route.path.startsWith(VISION_ROUTER_WEB_PREFIX)
  const capabilityMethods = ROUTE_CAPABILITY_POLICIES.get(route.path)
  if (!pluginOwned && (!capabilityMethods || capabilityMethods.size === 0)) return route

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
      const remoteCapability = routeCapabilityPolicy(route.path, method).remote
      if (remoteCapability === WEB_ROUTE_REMOTE_CAPABILITY.LOCAL_ONLY && !localUi) {
        rejectRemoteLocalCapability(res)
        return undefined
      }
      if (remoteCapability === WEB_ROUTE_REMOTE_CAPABILITY.REDACT_REMOTE && !localUi) {
        return runWithRemoteReadRedaction(route.path, originalHandler, req, res)
      }
      return originalHandler(req, res)
    },
  }
}

/**
 * Scope DVR's WebServer registrar to one injected child context without ever
 * mutating the shared WebServer implementation. Cordis service reads return a
 * caller-scoped proxy, so shadowing `childCtx.webServer` preserves the original
 * child identity/effect ownership while keeping unrelated plugin contexts on the
 * untouched service. Async injection callbacks keep only this private shadow
 * until they settle; they never hold a process-global registrar override.
 */
function runWithWebServerBoundary(childCtx, getConnection, callback) {
  if (!childCtx || (typeof childCtx !== 'object' && typeof childCtx !== 'function')) return callback()

  let webServer
  try { webServer = childCtx.webServer } catch { return callback() }
  if (!webServer || (typeof webServer !== 'object' && typeof webServer !== 'function')) return callback()
  if (typeof webServer.register !== 'function') return callback()

  const ownWebServer = Object.getOwnPropertyDescriptor(childCtx, 'webServer')
  if (ownWebServer && (!('value' in ownWebServer) || (ownWebServer.configurable === false && ownWebServer.writable !== true))) {
    throw new TypeError('vision-router: cannot scope the injected webServer service safely')
  }

  const originalRegister = webServer.register
  const guardedRegister = function registerWithLocalMutationBoundary(route) {
    return originalRegister.call(webServer, guardedRoute(route, getConnection))
  }
  const scopedWebServer = new Proxy(webServer, {
    get(target, property, receiver) {
      if (property === 'register') return guardedRegister
      return Reflect.get(target, property, receiver)
    },
  })

  Object.defineProperty(childCtx, 'webServer', ownWebServer
    ? { ...ownWebServer, value: scopedWebServer }
    : { value: scopedWebServer, configurable: true, enumerable: false, writable: true })

  const restore = () => {
    if (Object.getOwnPropertyDescriptor(childCtx, 'webServer')?.value !== scopedWebServer) return
    if (ownWebServer) Object.defineProperty(childCtx, 'webServer', ownWebServer)
    else delete childCtx.webServer
  }

  let result
  try {
    result = callback()
  } catch (error) {
    restore()
    throw error
  }
  if (result && typeof result.then === 'function') {
    return Promise.resolve(result).finally(restore)
  }
  restore()
  return result
}

/**
 * DSH rc.6/rc.7 expose no browser-authentication service for named plugin
 * routes, so the historical local-machine fences below remain the compatibility
 * floor. DSH 0.1.2-alpha.1 adds `connection.requestRejection(req)` specifically
 * so another Web route can inherit the Host/Origin + signed-browser-session
 * boundary. Feature-detect that seam and apply it to every DVR-owned named
 * route before the plugin's narrower local-capability/read-redaction policy.
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
              if (typeof childCtx?.get === 'function') {
                try {
                  const connection = childCtx.get('connection')
                  if (connection !== undefined && connection !== null) return connection
                } catch {}
              }
              if (typeof target?.get === 'function') {
                try {
                  const connection = target.get('connection')
                  return connection === undefined || connection === null ? undefined : connection
                } catch {
                  return undefined
                }
              }
              // Non-Cordis harness compatibility only. Supported DSH Hosts have
              // Context#get from the 0.1.5 floor onward.
              try { return childCtx?.connection ?? target?.connection } catch { return undefined }
            }
            // Preserve the ORIGINAL child context identity for rc.6 ownership,
            // but never leave our registrar wrapper visible to other plugins.
            return runWithWebServerBoundary(
              childCtx,
              getConnection,
              () => callback(childCtx),
            )
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
