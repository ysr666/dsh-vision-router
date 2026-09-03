import { htmlHasScriptMarker } from './html-script-marker.js'

const CLIENT_HOST_COMPAT_MARK = 'data-vision-router-host-compat'

/**
 * Client-side Host compatibility shim for the hand-maintained Vision Router
 * settings factory.
 *
 * DSH 0.1.2 moved model-catalog ownership from the legacy
 * `connection.api.llm.models()` facade to `remote.session.modelCatalog()` and
 * renamed the forwarded credential invalidation event. Keep the old client
 * factory unchanged: when (and only when) the new Host capability exists,
 * expose a tiny compatibility view of those two seams to that one factory.
 * Old rc.6/rc.7/rc.8 clients see their original Connection and Remote objects
 * byte-for-byte because the capability probe fails closed.
 */
export const CLIENT_HOST_COMPAT_PRELUDE = String.raw`(function(){
  'use strict';
  var TARGET = 'dsh-vision-router';
  var LEGACY_CREDENTIAL_EVENT = 'credentials/updated';
  var HOST_CREDENTIAL_EVENT = 'credentials/reference-updated';

  function optionalHostSession(ctx, remote) {
    try {
      if (ctx && typeof ctx.get === 'function') {
        var session = ctx.get('remote.session');
        if (session) return session;
      }
    } catch (_) {}
    try {
      return remote && remote.session;
    } catch (_) {
      return undefined;
    }
  }

  function hasHostCatalog(session) {
    return !!(session && typeof session.modelCatalog === 'function');
  }

  function wrapCatalogResult(value) {
    // The alpha Host returns ConnectionRpcResult<ModelCatalog>. The legacy
    // factory already understands the older { result: RpcResult } envelope, so
    // adapt only that carrier shape and leave future direct values untouched.
    if (value && typeof value === 'object' && typeof value.ok === 'boolean') {
      return { result: value };
    }
    return value;
  }

  function catalogModels(session) {
    return function models() {
      return Promise.resolve(session.modelCatalog()).then(wrapCatalogResult);
    };
  }

  function compatibleApi(originalApi, session) {
    var originalLlm = originalApi && originalApi.llm;
    var llm = originalLlm && (typeof originalLlm === 'object' || typeof originalLlm === 'function')
      ? new Proxy(originalLlm, {
          get: function(target, property) {
            if (property === 'models') return catalogModels(session);
            var value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        })
      : { models: catalogModels(session) };
    if (originalApi && (typeof originalApi === 'object' || typeof originalApi === 'function')) {
      return new Proxy(originalApi, {
        get: function(target, property) {
          if (property === 'llm') return llm;
          var value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
    return { llm: llm };
  }

  function compatibleConnection(connection, session) {
    if (!hasHostCatalog(session)) return connection;
    if (!connection || (typeof connection !== 'object' && typeof connection !== 'function')) return connection;
    var api = compatibleApi(connection.api, session);
    return new Proxy(connection, {
      get: function(target, property) {
        if (property === 'api') return api;
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  function compatibleRemote(remote, session) {
    if (!hasHostCatalog(session)) return remote;
    if (!remote || (typeof remote !== 'object' && typeof remote !== 'function')) return remote;
    return new Proxy(remote, {
      get: function(target, property) {
        if (property === '$on') {
          var subscribe = Reflect.get(target, property, target);
          if (typeof subscribe !== 'function') return subscribe;
          return function(event, listener) {
            var args = Array.prototype.slice.call(arguments);
            if (event === LEGACY_CREDENTIAL_EVENT) args[0] = HOST_CREDENTIAL_EVENT;
            return subscribe.apply(target, args);
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  function patchCanonicalImageCopy(namespace, dictionaries) {
    if (namespace !== 'vision-router' || !dictionaries || typeof dictionaries !== 'object') return dictionaries;
    var next = Object.assign({}, dictionaries);
    if (next.zh && typeof next.zh === 'object') {
      next.zh = Object.assign({}, next.zh, {
        hintInstantDescribe: '会话日志保留 Host 持久化后的图片；像素工具以这份 canonical 图片为坐标与像素事实源。',
        openPresentedImage: '点击查看图片',
        openNamedImage: '查看图片：{name}'
      });
    }
    if (next.en && typeof next.en === 'object') {
      next.en = Object.assign({}, next.en, {
        hintInstantDescribe: 'The session log keeps the Host-persisted image; pixel tools use that canonical image as their coordinate and pixel source of truth.',
        openPresentedImage: 'Open image',
        openNamedImage: 'Open image: {name}'
      });
    }
    return next;
  }

  function compatibleLocale(locale) {
    if (!locale || (typeof locale !== 'object' && typeof locale !== 'function')) return locale;
    return new Proxy(locale, {
      get: function(target, property) {
        if (property === 'register') {
          var register = Reflect.get(target, property, target);
          if (typeof register !== 'function') return register;
          return function(namespace, dictionaries) {
            var args = Array.prototype.slice.call(arguments);
            args[1] = patchCanonicalImageCopy(namespace, dictionaries);
            return register.apply(target, args);
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  function compatibleContext(ctx) {
    if (!ctx || typeof ctx !== 'object' || typeof Proxy !== 'function') return ctx;
    var session = optionalHostSession(ctx, ctx.remote);
    var remote = compatibleRemote(ctx.remote, session);
    var locale = compatibleLocale(ctx.locale);
    return new Proxy(ctx, {
      get: function(target, property) {
        if (property === 'remote') return remote;
        if (property === 'locale') return locale;
        if (property === 'get') {
          var get = Reflect.get(target, property, target);
          if (typeof get !== 'function') return get;
          return function(name) {
            var value = get.call(target, name);
            return name === 'connection' ? compatibleConnection(value, session) : value;
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  function decorate(plugin) {
    if (!plugin || typeof plugin !== 'object' || typeof plugin.apply !== 'function') return plugin;
    if (plugin.apply.__visionRouterHostCompat) return plugin;
    var originalApply = plugin.apply;
    function apply(ctx) {
      var args = Array.prototype.slice.call(arguments);
      args[0] = compatibleContext(ctx);
      return originalApply.apply(this, args);
    }
    try { Object.defineProperty(apply, '__visionRouterHostCompat', { value: true }); } catch (_) {}
    plugin.apply = apply;
    return plugin;
  }

  function patchLoader(loader) {
    if (!loader || (typeof loader !== 'object' && typeof loader !== 'function')) return;
    if (typeof loader.load === 'function' && !loader.load.__visionRouterHostCompat) {
      var originalLoad = loader.load;
      function load(spec) {
        if (spec && spec.id === TARGET && typeof spec.factory === 'function') {
          var factory = spec.factory;
          spec = Object.assign({}, spec, {
            factory: function(require) { return decorate(factory(require)); }
          });
        }
        return originalLoad.call(this, spec);
      }
      try { Object.defineProperty(load, '__visionRouterHostCompat', { value: true }); } catch (_) {}
      loader.load = load;
    }
    if (typeof loader.create === 'function' && !loader.create.__visionRouterHostCompat) {
      var originalCreate = loader.create;
      function create() {
        var result = originalCreate.apply(this, arguments);
        patchLoader(loader);
        return result;
      }
      try { Object.defineProperty(create, '__visionRouterHostCompat', { value: true }); } catch (_) {}
      loader.create = create;
    }
  }

  function install() {
    if (window.__ModuleLoader__) {
      patchLoader(window.__ModuleLoader__);
      return;
    }
    var descriptor = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__');
    if (descriptor && descriptor.configurable === false) return;
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

  install();
})();`

export function injectClientHostCompatibility(html) {
  if (typeof html !== 'string' || htmlHasScriptMarker(html, CLIENT_HOST_COMPAT_MARK)) return html
  const safe = CLIENT_HOST_COMPAT_PRELUDE.replace(/<\/script/gi, '<\\/script')
  const script = `<script ${CLIENT_HOST_COMPAT_MARK}>${safe}</script>`
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installClientHostCompatibility(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectClientHostCompatibility),
      'vision-router: client Host compatibility boundary',
    )
  })
}
