/**
 * Current-product remote Settings risk behavior shared by every browser
 * attachment lifecycle. Host loader/version compatibility stays outside this owner.
 *
 * PRODUCT CONTRACT (2.3+): acceptedRisk is reminder/friction only. It is not
 * authentication, authorization, local-presence proof, or a credential.
 */
export function createRemoteSettingsRiskClientBoundary(options = {}) {
  var confirmImpl = options.confirmImpl
  var alertImpl = options.alertImpl
  var locale = options.locale
  var location = options.location
  var normalizeLoopback = options.normalizeLoopback === true
  var connectionCache = typeof WeakMap === 'function' ? new WeakMap() : undefined
  var rpcCache = typeof WeakMap === 'function' ? new WeakMap() : undefined
  var contextCache = typeof WeakMap === 'function' ? new WeakMap() : undefined
  var authorizationByRpc = typeof WeakMap === 'function' ? new WeakMap() : undefined
  var CHANNEL = '/vision-router-settings'
  var AUTHORIZE_ENDPOINT = 'authorize'

  function localeValue() {
    try {
      var value = typeof locale === 'function' ? locale() : locale
      return String(value || '').toLowerCase()
    } catch (_) {
      return ''
    }
  }

  function chineseLocale() {
    var lang = localeValue()
    return lang === '' || lang.indexOf('zh') === 0
  }

  function riskMessage() {
    return chineseLocale()
      ? '启用远程设置？\n\n当前页面通过远程地址访问 DSH。启用后，能够访问此 trusted host 的客户端可以修改 Vision Router 已开放的设置。\n\nDSH trustedHosts 不是身份认证，请仅在你信任当前网络和访问者时继续。API Key、HTTP Provider 凭据、本地 Ollama / LM Studio、产物路径等未列入远程白名单的敏感配置仍不会开放。\n\n确定要允许远程修改设置吗？'
      : 'Enable remote settings?\n\nThis page is accessing DSH through a remote address. After enabling this, clients that can reach this trusted host can change the Vision Router settings exposed by the remote allow-list.\n\nDSH trustedHosts is not authentication. Continue only if you trust the current network and its users. Sensitive settings outside the remote allow-list, including API keys, HTTP-provider credentials, local Ollama / LM Studio, and artifact paths, remain unavailable remotely.\n\nAllow remote settings?'
  }

  function isLoopbackLocation(locationLike) {
    var hostname = locationLike && typeof locationLike.hostname === 'string'
      ? locationLike.hostname.toLowerCase().replace(/^\[|\]$/g, '')
      : ''
    var protocol = locationLike && typeof locationLike.protocol === 'string'
      ? locationLike.protocol.toLowerCase()
      : ''
    if (protocol === 'dsh-app:' && hostname === 'app') return true
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1') return true
    return /^127(?:\.\d{1,3}){3}$/.test(hostname)
  }

  function currentLocation() {
    try { return typeof location === 'function' ? location() : location }
    catch (_) { return undefined }
  }

  function isPermissionDisabledDescribe(channel, endpoint, result) {
    return channel === CHANNEL
      && endpoint === 'describe'
      && result && result.ok === true
      && result.value && result.value.enabled !== true
      && result.value.reason === 'permission-disabled'
  }

  async function authorizeAndRefresh(target, call) {
    var existing = authorizationByRpc && authorizationByRpc.get(target)
    if (existing) return existing
    var pending = (async function() {
      if (typeof confirmImpl !== 'function' || confirmImpl(riskMessage()) !== true) return undefined
      var authorized = await call.call(target, CHANNEL, AUTHORIZE_ENDPOINT, { acceptedRisk: true })
      if (!authorized || authorized.ok !== true) {
        var message = authorized && authorized.error && authorized.error.message
          ? authorized.error.message
          : 'Vision Router could not enable remote settings.'
        try { if (typeof alertImpl === 'function') alertImpl(message) } catch (_) {}
        return undefined
      }
      return call.call(target, CHANNEL, 'describe', {})
    })()
    if (authorizationByRpc) authorizationByRpc.set(target, pending)
    try { return await pending }
    finally {
      if (authorizationByRpc && authorizationByRpc.get(target) === pending) {
        authorizationByRpc.delete(target)
      }
    }
  }

  function wrapRpc(rpc) {
    if (!rpc || (typeof rpc !== 'object' && typeof rpc !== 'function')) return rpc
    if (rpcCache && rpcCache.has(rpc)) return rpcCache.get(rpc)
    var wrapped = new Proxy(rpc, {
      get: function(target, property) {
        if (property === 'call') {
          var call = Reflect.get(target, property, target)
          if (typeof call !== 'function') return call
          return async function(channel, endpoint) {
            var result = await call.apply(target, arguments)
            if (!isPermissionDisabledDescribe(channel, endpoint, result)) return result
            var refreshed = await authorizeAndRefresh(target, call)
            return refreshed || result
          }
        }
        var value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    if (rpcCache) rpcCache.set(rpc, wrapped)
    return wrapped
  }

  function wrapConnection(connection) {
    if (!connection || (typeof connection !== 'object' && typeof connection !== 'function')) return connection
    if (connectionCache && connectionCache.has(connection)) return connectionCache.get(connection)
    var wrapped = new Proxy(connection, {
      get: function(target, property) {
        if (property === 'isLoopback' && normalizeLoopback && isLoopbackLocation(currentLocation())) return true
        if (property === 'rpc') return wrapRpc(Reflect.get(target, property, target))
        var value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    if (connectionCache) connectionCache.set(connection, wrapped)
    return wrapped
  }

  function wrapContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return ctx
    if (contextCache && contextCache.has(ctx)) return contextCache.get(ctx)
    var wrapped = new Proxy(ctx, {
      get: function(target, property) {
        if (property === 'get') {
          var get = Reflect.get(target, property, target)
          if (typeof get !== 'function') return get
          return function(name) {
            var value = get.apply(target, arguments)
            return name === 'connection' ? wrapConnection(value) : value
          }
        }
        var value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    if (contextCache) contextCache.set(ctx, wrapped)
    return wrapped
  }

  return { wrapContext: wrapContext }
}

export const REMOTE_SETTINGS_RISK_CLIENT_BOUNDARY_SOURCE =
  'var createRemoteSettingsRiskClientBoundary = (' +
  createRemoteSettingsRiskClientBoundary.toString() +
  ');'
