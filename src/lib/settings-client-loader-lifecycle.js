import { injectClientCarrierHtml, installClientScriptCarriers } from './client-script-carrier.js'
import {
  LOCAL_PERMISSION_CLIENT_BOUNDARY_SOURCE,
  LOCAL_REMOTE_SETTINGS_PERMISSION_FIELD,
  LOCAL_REMOTE_SETTINGS_PERMISSION_PATH,
} from './local-remote-settings-permission.js'
import { REMOTE_SETTINGS_RISK_CLIENT_BOUNDARY_SOURCE } from './remote-settings-risk-client-boundary.js'

// Keep the legacy marker value so mixed-generation/HMR pages do not install
// a second lifecycle wrapper after the source/API rename.
const SETTINGS_CLIENT_LOADER_LIFECYCLE_MARK = 'data-vision-router-settings-rc8-lifecycle'

/**
 * Supported Hosts can replace ModuleLoader.load() inside loader.create(). This
 * compatibility owner only re-attaches the current local-permission and
 * remote-risk product boundaries after that queue-to-live transition; product
 * semantics stay in their capability owners.
 */
export const SETTINGS_CLIENT_LOADER_LIFECYCLE_PRELUDE = String.raw`(function(){
  'use strict';
  var TARGET = 'dsh-vision-router';
  ${LOCAL_PERMISSION_CLIENT_BOUNDARY_SOURCE}
  var localPermissionBoundary = createLocalRemoteSettingsPermissionClientBoundary({
    endpoint: '${LOCAL_REMOTE_SETTINGS_PERMISSION_PATH}',
    field: '${LOCAL_REMOTE_SETTINGS_PERMISSION_FIELD}',
    fetchImpl: typeof fetch === 'function'
      ? function(url, options) { return fetch(url, options); }
      : undefined
  });

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
                var nextCtx = riskBoundary.wrapContext(localPermissionBoundary.wrapContext(ctx));
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

export function injectSettingsClientLoaderLifecyclePrelude(html) {
  return injectClientCarrierHtml(html, SETTINGS_CLIENT_LOADER_LIFECYCLE_MARK, SETTINGS_CLIENT_LOADER_LIFECYCLE_PRELUDE)
}

export function installSettingsClientLoaderLifecycle(ctx) {
  installClientScriptCarriers(ctx, {
    marker: SETTINGS_CLIENT_LOADER_LIFECYCLE_MARK,
    prelude: SETTINGS_CLIENT_LOADER_LIFECYCLE_PRELUDE,
    label: 'vision-router: settings client loader lifecycle',
    injectHtml: injectSettingsClientLoaderLifecyclePrelude,
  })
}
