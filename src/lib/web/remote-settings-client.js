import { injectClientCarrierHtml, installClientScriptCarriers } from '../client-script-carrier.js'
import { installVisionRouterRemoteSettingsBridge } from '../remote-settings-bridge.js'
import { installSettingsClientLoaderLifecycle } from '../settings-client-loader-lifecycle.js'

const SETTINGS_CONFIG_FORMS_MARK = 'data-vision-router-settings-configforms-compat'

/**
 * DSH 0.1.7 replaces the browser `settingsScope` service with `configForms`.
 * Vision Router still supports older Hosts, so the browser bundle cannot hard
 * depend on either service name. This prelude removes the legacy hard service
 * edge at module-factory time and presents the old `settingsScope.bind()` face
 * over whichever official settings service the active Host provides.
 */
export const SETTINGS_CONFIG_FORMS_CLIENT_PRELUDE = String.raw`(function(){
  'use strict';
  var TARGET = 'dsh-vision-router';
  var FLAG = '__visionRouterSettingsConfigFormsCompat';
  var contextCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;
  var binderCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;
  var connectionCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;

  function safeGet(ctx, name) {
    if (!ctx || typeof ctx.get !== 'function') return undefined;
    try {
      var value = ctx.get(name);
      return value === undefined || value === null ? undefined : value;
    } catch (_) { return undefined; }
  }

  function isLoopbackLocation(locationLike) {
    var hostname = locationLike && typeof locationLike.hostname === 'string'
      ? locationLike.hostname.toLowerCase().replace(/^\[|\]$/g, '')
      : '';
    var protocol = locationLike && typeof locationLike.protocol === 'string'
      ? locationLike.protocol.toLowerCase()
      : '';
    if (protocol === 'dsh-app:' && hostname === 'app') return true;
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1') return true;
    return /^127(?:\.\d{1,3}){3}$/.test(hostname);
  }

  function normalizeConnection(connection) {
    if (!connection || typeof connection !== 'object') return connection;
    var locationLike;
    try { locationLike = window && window.location; } catch (_) { locationLike = undefined; }
    if (!isLoopbackLocation(locationLike) || connection.isLoopback !== false) return connection;
    if (connectionCache && connectionCache.has(connection)) return connectionCache.get(connection);
    var wrapped = new Proxy(connection, {
      get: function(target, property) {
        if (property === 'isLoopback') return true;
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    if (connectionCache) connectionCache.set(connection, wrapped);
    return wrapped;
  }

  function legacyBinder(ctx) {
    var binder = safeGet(ctx, 'settingsScope');
    return binder && typeof binder.bind === 'function' ? binder : undefined;
  }

  function configFormsBinder(ctx) {
    var forms = safeGet(ctx, 'configForms');
    if (!forms || typeof forms.get !== 'function') return undefined;
    if (binderCache && binderCache.has(forms)) return binderCache.get(forms);
    var binder = {
      bind: function(spec) {
        var namespace = spec && spec.namespace;
        if (typeof namespace !== 'string' || namespace.length === 0) {
          throw new TypeError('settings namespace must be a non-empty string');
        }
        return forms.get(namespace);
      }
    };
    if (binderCache) binderCache.set(forms, binder);
    return binder;
  }

  function resolveBinder(ctx) {
    return legacyBinder(ctx) || configFormsBinder(ctx);
  }

  function wrapContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return ctx;
    if (contextCache && contextCache.has(ctx)) return contextCache.get(ctx);
    var wrapped = new Proxy(ctx, {
      get: function(target, property) {
        if (property === 'settingsScope') {
          var binder = resolveBinder(target);
          if (!binder) {
            throw new Error('Vision Router requires DSH settingsScope or configForms');
          }
          return binder;
        }
        if (property === 'get') {
          var getter = Reflect.get(target, property, target);
          if (typeof getter !== 'function') return getter;
          return function(name) {
            var value = getter.call(target, name);
            return name === 'connection' ? normalizeConnection(value) : value;
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    if (contextCache) contextCache.set(ctx, wrapped);
    return wrapped;
  }

  function rewriteInject(exports) {
    if (!exports || !Array.isArray(exports.inject) || exports.inject.indexOf('settingsScope') === -1) return;
    exports.inject = exports.inject.filter(function(name){ return name !== 'settingsScope'; });
  }

  function patchLiveLoader(loader) {
    if (!loader || typeof loader.load !== 'function' || loader.load[FLAG]) return;
    var original = loader.load;
    function load(spec) {
      if (spec && spec.id === TARGET && typeof spec.factory === 'function') {
        var factory = spec.factory;
        spec = Object.assign({}, spec, {
          factory: function(require) {
            var exports = factory(require);
            rewriteInject(exports);
            if (exports && typeof exports.apply === 'function' && !exports.apply[FLAG]) {
              var apply = exports.apply;
              var wrappedApply = function(ctx) {
                var rest = Array.prototype.slice.call(arguments, 1);
                return apply.apply(exports, [wrapContext(ctx)].concat(rest));
              };
              Object.defineProperty(wrappedApply, FLAG, { value: true });
              exports.apply = wrappedApply;
            }
            return exports;
          }
        });
      }
      return original.call(this, spec);
    }
    Object.defineProperty(load, FLAG, { value: true });
    loader.load = load;
  }

  function patchCreate(loader) {
    if (!loader) return;
    patchLiveLoader(loader);
    if (typeof loader.create !== 'function' || loader.create[FLAG]) return;
    var originalCreate = loader.create;
    function create() {
      var result = originalCreate.apply(this, arguments);
      patchLiveLoader(loader);
      return result;
    }
    Object.defineProperty(create, FLAG, { value: true });
    loader.create = create;
  }

  function install() {
    if (window.__ModuleLoader__) {
      patchCreate(window.__ModuleLoader__);
      return;
    }
    var descriptor = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__');
    if (descriptor && descriptor.configurable === false) return;
    var previousGet = descriptor && descriptor.get;
    var previousSet = descriptor && descriptor.set;
    var stored = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
    Object.defineProperty(window, '__ModuleLoader__', {
      configurable: true,
      enumerable: !descriptor || descriptor.enumerable !== false,
      get: function(){ return previousGet ? previousGet.call(window) : stored; },
      set: function(value) {
        if (previousSet) previousSet.call(window, value); else stored = value;
        try { patchCreate(previousGet ? previousGet.call(window) : value); } catch (_) {}
      }
    });
    if (stored) patchCreate(stored);
  }

  try { install(); } catch (_) {}
})();`

export function injectSettingsConfigFormsCompatPrelude(html) {
  return injectClientCarrierHtml(html, SETTINGS_CONFIG_FORMS_MARK, SETTINGS_CONFIG_FORMS_CLIENT_PRELUDE)
}

export function installSettingsConfigFormsCompat(ctx) {
  installClientScriptCarriers(ctx, {
    marker: SETTINGS_CONFIG_FORMS_MARK,
    prelude: SETTINGS_CONFIG_FORMS_CLIENT_PRELUDE,
    label: 'vision-router: settings configForms compatibility',
    injectHtml: injectSettingsConfigFormsCompatPrelude,
  })
}

export function installVisionRemoteSettingsClient(ctx, logger) {
  installVisionRouterRemoteSettingsBridge(ctx, logger)
  installSettingsConfigFormsCompat(ctx)
  installSettingsClientLoaderLifecycle(ctx)
  return ctx
}
