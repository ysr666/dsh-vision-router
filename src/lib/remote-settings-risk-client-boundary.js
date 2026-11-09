/**
 * Current-product remote Settings risk behavior shared by every browser
 * attachment lifecycle. Host loader/version compatibility stays outside this owner.
 *
 * PRODUCT CONTRACT (2.3+): acceptedRisk is reminder/friction only. It is not
 * authentication, authorization, local-presence proof, or a credential.
 *
 * This function is serialized with `toString()` into the browser boundary source
 * below, so its body must stay self-contained: no imported helper and no free
 * identifier may appear inside it.
 */
export function createRemoteSettingsRiskClientBoundary(rawOptions) {
  var options = rawOptions !== null && typeof rawOptions === 'object' ? rawOptions : {}
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
      ? '启用完整远程设置？\n\n当前页面通过远程地址访问 DSH。确认后，通过 DSH 登录认证且能访问该 Host 的客户端可修改完整的 Vision Router 普通配置，包括代理/网络出口、HTTP Provider、本地 Ollama / LM Studio、产物路径、仅本地视觉策略和桌面截图开关。这些修改会影响运行 DSH 的设备和图片数据流向。\n\n已保存的密钥和 URL 凭据不会以明文回显，但远程用户可以替换相应配置。远程修改桌面截图开关不会自动授予操作系统录屏权限；打开仅本地视觉之前，云端识图仍可能上传图片。\n\nDSH trustedHosts 本身不是身份认证，风险确认也不是身份认证。请只在信任 DSH 登录用户及网络访问环境时继续。\n\n确定允许远程修改完整配置吗？'
      : 'Enable full remote settings?\n\nThis page is accessing DSH through a remote address. After confirmation, clients authenticated to DSH that can reach this Host can edit the full ordinary Vision Router configuration, including proxy/network egress, HTTP providers, local Ollama / LM Studio, artifact paths, the Local-only vision policy and the desktop-capture toggle. Changes affect the machine running DSH and where image data may be sent.\n\nSaved keys and URL credentials are not echoed in plaintext, but remote users can replace their configuration. Editing the capture toggle does not grant OS screen-recording permission. Cloud vision may still upload images until Local-only vision is enabled.\n\nDSH trustedHosts is not authentication, and this risk confirmation is not authentication. Continue only if you trust the authenticated DSH users and network access.\n\nAllow full remote configuration edits?'
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
