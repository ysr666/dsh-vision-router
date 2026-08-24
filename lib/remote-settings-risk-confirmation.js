import { htmlHasScriptMarker } from './html-script-marker.js'

const RISK_PRELUDE_MARK = 'data-vision-router-remote-settings-risk-confirmation'

export const REMOTE_SETTINGS_RISK_CLIENT_PRELUDE = String.raw`(function(){
  'use strict';
  var CHANNEL = '/vision-router-settings';
  var AUTHORIZE_ENDPOINT = 'authorize';
  var connectionCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;
  var rpcCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;
  var contextCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;
  var authorizationPromise;

  function chineseLocale() {
    var lang = '';
    try {
      lang = String((document && document.documentElement && document.documentElement.lang) || (navigator && navigator.language) || '').toLowerCase();
    } catch (_) {}
    return lang === '' || lang.indexOf('zh') === 0;
  }

  function riskMessage() {
    return chineseLocale()
      ? '启用远程设置？\n\n当前页面通过远程地址访问 DSH。启用后，能够访问此 trusted host 的客户端可以修改 Vision Router 已开放的设置。\n\nDSH trustedHosts 不是身份认证，请仅在你信任当前网络和访问者时继续。API Key、HTTP Provider 凭据、本地 Ollama / LM Studio、产物路径等未列入远程白名单的敏感配置仍不会开放。\n\n确定要允许远程修改设置吗？'
      : 'Enable remote settings?\n\nThis page is accessing DSH through a remote address. After enabling this, clients that can reach this trusted host can change the Vision Router settings exposed by the remote allow-list.\n\nDSH trustedHosts is not authentication. Continue only if you trust the current network and its users. Sensitive settings outside the remote allow-list, including API keys, HTTP-provider credentials, local Ollama / LM Studio, and artifact paths, remain unavailable remotely.\n\nAllow remote settings?';
  }

  function isPermissionDisabledDescribe(channel, endpoint, result) {
    return channel === CHANNEL
      && endpoint === 'describe'
      && result && result.ok === true
      && result.value && result.value.enabled !== true
      && result.value.reason === 'permission-disabled';
  }

  async function authorizeAndRefresh(target, call) {
    if (authorizationPromise) return authorizationPromise;
    authorizationPromise = (async function(){
      if (typeof window.confirm !== 'function' || window.confirm(riskMessage()) !== true) return undefined;
      var authorized = await call.call(target, CHANNEL, AUTHORIZE_ENDPOINT, { acceptedRisk: true });
      if (!authorized || authorized.ok !== true) {
        var message = authorized && authorized.error && authorized.error.message
          ? authorized.error.message
          : 'Vision Router could not enable remote settings.';
        try { if (typeof window.alert === 'function') window.alert(message); } catch (_) {}
        return undefined;
      }
      return call.call(target, CHANNEL, 'describe', {});
    })();
    try { return await authorizationPromise; }
    finally { authorizationPromise = undefined; }
  }

  function wrapRpc(rpc) {
    if (!rpc || (typeof rpc !== 'object' && typeof rpc !== 'function')) return rpc;
    if (rpcCache && rpcCache.has(rpc)) return rpcCache.get(rpc);
    var wrapped = new Proxy(rpc, {
      get: function(target, property) {
        if (property === 'call') {
          var call = Reflect.get(target, property, target);
          if (typeof call !== 'function') return call;
          return async function(channel, endpoint) {
            var result = await call.apply(target, arguments);
            if (!isPermissionDisabledDescribe(channel, endpoint, result)) return result;
            var refreshed = await authorizeAndRefresh(target, call);
            return refreshed || result;
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    if (rpcCache) rpcCache.set(rpc, wrapped);
    return wrapped;
  }

  function wrapConnection(connection) {
    if (!connection || (typeof connection !== 'object' && typeof connection !== 'function')) return connection;
    if (connectionCache && connectionCache.has(connection)) return connectionCache.get(connection);
    var wrapped = new Proxy(connection, {
      get: function(target, property) {
        if (property === 'rpc') return wrapRpc(Reflect.get(target, property, target));
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    if (connectionCache) connectionCache.set(connection, wrapped);
    return wrapped;
  }

  function wrapContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return ctx;
    if (contextCache && contextCache.has(ctx)) return contextCache.get(ctx);
    var wrapped = new Proxy(ctx, {
      get: function(target, property) {
        if (property === 'get') {
          var get = Reflect.get(target, property, target);
          if (typeof get !== 'function') return get;
          return function(name) {
            var value = get.apply(target, arguments);
            return name === 'connection' ? wrapConnection(value) : value;
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    if (contextCache) contextCache.set(ctx, wrapped);
    return wrapped;
  }

  function patchLoader(loader) {
    if (!loader || typeof loader.load !== 'function' || loader.load.__visionRouterRemoteRiskConfirmation) return;
    var original = loader.load;
    function load(spec) {
      if (spec && spec.id === 'dsh-vision-router' && typeof spec.factory === 'function') {
        var factory = spec.factory;
        spec = Object.assign({}, spec, {
          factory: function(require) {
            var exports = factory(require);
            if (exports && typeof exports.apply === 'function' && !exports.apply.__visionRouterRemoteRiskConfirmation) {
              var apply = exports.apply;
              var wrappedApply = function(ctx) {
                var rest = Array.prototype.slice.call(arguments, 1);
                return apply.apply(exports, [wrapContext(ctx)].concat(rest));
              };
              Object.defineProperty(wrappedApply, '__visionRouterRemoteRiskConfirmation', { value: true });
              exports.apply = wrappedApply;
            }
            return exports;
          }
        });
      }
      return original.call(loader, spec);
    }
    Object.defineProperty(load, '__visionRouterRemoteRiskConfirmation', { value: true });
    loader.load = load;
  }

  function install() {
    if (window.__ModuleLoader__) {
      patchLoader(window.__ModuleLoader__);
      return;
    }
    var descriptor = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__');
    if (descriptor && descriptor.configurable === false) return;
    if (descriptor && typeof descriptor.set === 'function') {
      var previousGet = descriptor.get;
      var previousSet = descriptor.set;
      Object.defineProperty(window, '__ModuleLoader__', {
        configurable: true,
        enumerable: descriptor.enumerable !== false,
        get: function(){ return previousGet ? previousGet.call(window) : undefined; },
        set: function(value) {
          previousSet.call(window, value);
          try { patchLoader(window.__ModuleLoader__ || value); } catch (_) {}
        }
      });
      return;
    }
    var stored;
    Object.defineProperty(window, '__ModuleLoader__', {
      configurable: true,
      enumerable: true,
      get: function(){ return stored; },
      set: function(value) {
        stored = value;
        patchLoader(value);
        Object.defineProperty(window, '__ModuleLoader__', {
          configurable: true,
          enumerable: true,
          writable: true,
          value: stored
        });
      }
    });
  }

  try { install(); } catch (_) {}
})();`

export function injectRemoteSettingsRiskConfirmationPrelude(html) {
  if (typeof html !== 'string' || htmlHasScriptMarker(html, RISK_PRELUDE_MARK)) return html
  const script = `<script ${RISK_PRELUDE_MARK}>${REMOTE_SETTINGS_RISK_CLIENT_PRELUDE.replace(/<\/script/gi, '<\\/script')}</script>`
  const endHead = html.indexOf('</head>')
  return endHead === -1 ? `${html}${script}` : `${html.slice(0, endHead)}${script}${html.slice(endHead)}`
}

export function installRemoteSettingsRiskConfirmationBridge(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectRemoteSettingsRiskConfirmationPrelude),
      'vision-router: remote settings risk confirmation client shim',
    )
  })
}
