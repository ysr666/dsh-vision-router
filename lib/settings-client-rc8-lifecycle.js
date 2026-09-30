import { injectClientCarrierHtml, installClientScriptCarriers } from './client-script-carrier.js'
import { REMOTE_SETTINGS_RISK_CLIENT_BOUNDARY_SOURCE } from './remote-settings-risk-client-boundary.js'

const SETTINGS_RC8_MARK = 'data-vision-router-settings-rc8-lifecycle'

/**
 * Supported Hosts can replace ModuleLoader.load() inside loader.create(). This
 * compatibility owner re-attaches the local permission wrapper and the shared
 * remote-risk product boundary after that queue-to-live transition. Remote-risk
 * semantics themselves live in remote-settings-risk-client-boundary.js.
 */
export const SETTINGS_RC8_CLIENT_PRELUDE = String.raw`(function(){
  'use strict';
  var TARGET = 'dsh-vision-router';
  var FIELD = 'allowRemoteSettings';
  var ENDPOINT = '/_dsh/vision-router/remote-settings-permission';
  var scopeCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;
  var binderCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;
  var localContextCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;

  function normalizePermissionValue(value) {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  }

  async function writePermission(operation, value, revision) {
    if (typeof fetch !== 'function') throw new Error('Vision Router local settings transport is unavailable');
    var payload = { operation: operation };
    if (operation === 'set') payload.value = value;
    if (Number.isInteger(revision) && revision >= 0) payload.expectedRevision = revision;
    var response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload)
    });
    var body;
    try { body = await response.json(); } catch (_) { body = undefined; }
    if (!response.ok || !body || body.ok !== true) {
      var message = body && body.error && body.error.message ? body.error.message : ('HTTP ' + response.status);
      var error = new Error(message);
      if (body && body.error && body.error.code) error.code = body.error.code;
      throw error;
    }
    return body.value;
  }

  function wrapScope(scope) {
    if (!scope || (typeof scope !== 'object' && typeof scope !== 'function')) return scope;
    if (scopeCache && scopeCache.has(scope)) return scopeCache.get(scope);
    var overlay;
    var cachedRawSnapshot;
    var cachedOverlayKey;
    var cachedClientSnapshot;

    function overlayKey() {
      if (!overlay) return 'none';
      return (overlay.present ? '1' : '0') + ':' + String(overlay.value) + ':' + String(overlay.revision);
    }

    function rawSnapshot() {
      try { return typeof scope.getSnapshot === 'function' ? scope.getSnapshot() : undefined; } catch (_) { return undefined; }
    }

    function snapshotWithOverlay(snapshot) {
      if (!overlay || !snapshot || typeof snapshot !== 'object') return snapshot;
      var user = snapshot.user && typeof snapshot.user === 'object' && !Array.isArray(snapshot.user) ? snapshot.user : {};
      var present = Object.prototype.hasOwnProperty.call(user, FIELD);
      var matches = overlay.present ? present && user[FIELD] === overlay.value : !present;
      if (matches && (!Number.isInteger(overlay.revision) || !Number.isInteger(snapshot.revision) || snapshot.revision >= overlay.revision)) {
        overlay = undefined;
        return snapshot;
      }
      var nextUser = Object.assign({}, user);
      if (overlay.present) nextUser[FIELD] = overlay.value;
      else delete nextUser[FIELD];
      var nextValue = snapshot.value && typeof snapshot.value === 'object' && !Array.isArray(snapshot.value)
        ? Object.assign({}, snapshot.value)
        : snapshot.value;
      if (nextValue && typeof nextValue === 'object') nextValue[FIELD] = overlay.present ? overlay.value : false;
      return Object.assign({}, snapshot, {
        user: nextUser,
        value: nextValue,
        revision: Number.isInteger(overlay.revision) ? overlay.revision : snapshot.revision
      });
    }

    function snapshotForClient(snapshot) {
      var keyBefore = overlayKey();
      if (snapshot === cachedRawSnapshot && keyBefore === cachedOverlayKey) return cachedClientSnapshot;
      var effective = snapshotWithOverlay(snapshot);
      var keyAfter = overlayKey();
      if (snapshot === cachedRawSnapshot && keyAfter === cachedOverlayKey) return cachedClientSnapshot;
      if (!effective || typeof effective !== 'object' || effective.mode !== 'host') {
        cachedRawSnapshot = snapshot;
        cachedOverlayKey = keyAfter;
        cachedClientSnapshot = effective;
        return effective;
      }
      var next = effective;
      var value = effective.value;
      if (value && typeof value === 'object' && !Array.isArray(value)
          && Object.prototype.hasOwnProperty.call(value, FIELD)
          && typeof value[FIELD] === 'boolean') {
        value = Object.assign({}, value, { [FIELD]: value[FIELD] ? 'true' : '' });
        next = Object.assign({}, next, { value: value });
      }
      var user = effective.user;
      if (user && typeof user === 'object' && !Array.isArray(user)
          && Object.prototype.hasOwnProperty.call(user, FIELD)
          && typeof user[FIELD] === 'boolean') {
        user = Object.assign({}, user, { [FIELD]: user[FIELD] ? 'true' : 'false' });
        next = Object.assign({}, next, { user: user });
      }
      cachedRawSnapshot = snapshot;
      cachedOverlayKey = keyAfter;
      cachedClientSnapshot = next;
      return next;
    }

    var wrapped = new Proxy(scope, {
      get: function(target, property) {
        if (property === 'getSnapshot') return function(){ return snapshotForClient(rawSnapshot()); };
        if (property === 'set') {
          var set = Reflect.get(target, property, target);
          return async function(field, value) {
            var snapshot = rawSnapshot();
            if (field === FIELD && snapshot && snapshot.mode === 'host') {
              var normalized = normalizePermissionValue(value);
              if (normalized === undefined) throw new TypeError('allowRemoteSettings must be boolean');
              var result = await writePermission('set', normalized, snapshot.revision);
              overlay = { present: true, value: normalized, revision: result && result.revision };
              cachedRawSnapshot = undefined;
              if (typeof target.load === 'function') await target.load();
              return;
            }
            return typeof set === 'function' ? set.apply(target, arguments) : undefined;
          };
        }
        if (property === 'unset') {
          var unset = Reflect.get(target, property, target);
          return async function(field) {
            var snapshot = rawSnapshot();
            if (field === FIELD && snapshot && snapshot.mode === 'host') {
              var result = await writePermission('unset', undefined, snapshot.revision);
              overlay = { present: false, revision: result && result.revision };
              cachedRawSnapshot = undefined;
              if (typeof target.load === 'function') await target.load();
              return;
            }
            return typeof unset === 'function' ? unset.apply(target, arguments) : undefined;
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    if (scopeCache) scopeCache.set(scope, wrapped);
    return wrapped;
  }

  function wrapBinder(binder) {
    if (!binder || (typeof binder !== 'object' && typeof binder !== 'function')) return binder;
    if (binderCache && binderCache.has(binder)) return binderCache.get(binder);
    var wrapped = new Proxy(binder, {
      get: function(target, property) {
        if (property === 'bind') {
          var bind = Reflect.get(target, property, target);
          if (typeof bind !== 'function') return bind;
          return function(spec) {
            var scope = bind.apply(target, arguments);
            return spec && spec.namespace === 'vision-router' ? wrapScope(scope) : scope;
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    if (binderCache) binderCache.set(binder, wrapped);
    return wrapped;
  }

  function wrapLocalContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return ctx;
    if (localContextCache && localContextCache.has(ctx)) return localContextCache.get(ctx);
    var wrapped = new Proxy(ctx, {
      get: function(target, property) {
        if (property === 'settingsScope') return wrapBinder(Reflect.get(target, property, target));
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    if (localContextCache) localContextCache.set(ctx, wrapped);
    return wrapped;
  }

  ${REMOTE_SETTINGS_RISK_CLIENT_BOUNDARY_SOURCE}
  var riskBoundary = createRemoteSettingsRiskClientBoundary({
    confirmImpl: function(message) {
      return typeof window.confirm === 'function' && window.confirm(message) === true;
    },
    alertImpl: function(message) {
      try { if (typeof window.alert === 'function') window.alert(message); } catch (_) {}
    },
    locale: function() {
      try {
        return String((document && document.documentElement && document.documentElement.lang)
          || (navigator && navigator.language) || '');
      } catch (_) { return ''; }
    },
    location: function() {
      try { return window && window.location; } catch (_) { return undefined; }
    },
    normalizeLoopback: true
  });

  function patchLiveLoader(loader) {
    if (!loader || typeof loader.load !== 'function' || loader.load.__visionRouterSettingsRc8Lifecycle) return;
    var original = loader.load;
    function load(spec) {
      if (spec && spec.id === TARGET && typeof spec.factory === 'function') {
        var factory = spec.factory;
        spec = Object.assign({}, spec, {
          factory: function(require) {
            var exports = factory(require);
            if (exports && typeof exports.apply === 'function' && !exports.apply.__visionRouterSettingsRc8Lifecycle) {
              var apply = exports.apply;
              var wrappedApply = function(ctx) {
                var rest = Array.prototype.slice.call(arguments, 1);
                var nextCtx = riskBoundary.wrapContext(wrapLocalContext(ctx));
                return apply.apply(exports, [nextCtx].concat(rest));
              };
              Object.defineProperty(wrappedApply, '__visionRouterSettingsRc8Lifecycle', { value: true });
              exports.apply = wrappedApply;
            }
            return exports;
          }
        });
      }
      return original.call(this, spec);
    }
    Object.defineProperty(load, '__visionRouterSettingsRc8Lifecycle', { value: true });
    loader.load = load;
  }

  function patchCreate(loader) {
    if (!loader || typeof loader.create !== 'function' || loader.create.__visionRouterSettingsRc8Lifecycle) return;
    var originalCreate = loader.create;
    function create() {
      var result = originalCreate.apply(this, arguments);
      patchLiveLoader(loader);
      return result;
    }
    Object.defineProperty(create, '__visionRouterSettingsRc8Lifecycle', { value: true });
    loader.create = create;
    if (loader.mode === 'live') patchLiveLoader(loader);
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

export function injectSettingsRc8ClientPrelude(html) {
  return injectClientCarrierHtml(html, SETTINGS_RC8_MARK, SETTINGS_RC8_CLIENT_PRELUDE)
}

export function installSettingsRc8ClientLifecycle(ctx) {
  installClientScriptCarriers(ctx, {
    marker: SETTINGS_RC8_MARK,
    prelude: SETTINGS_RC8_CLIENT_PRELUDE,
    label: 'vision-router: rc8 settings client lifecycle',
    injectHtml: injectSettingsRc8ClientPrelude,
  })
}
