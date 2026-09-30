import { htmlHasScriptMarker } from './html-script-marker.js'
import { REMOTE_SETTINGS_RISK_CLIENT_BOUNDARY_SOURCE } from './remote-settings-risk-client-boundary.js'

const RISK_PRELUDE_MARK = 'data-vision-router-remote-settings-risk-confirmation'

export const REMOTE_SETTINGS_RISK_CLIENT_PRELUDE = String.raw`(function(){
  'use strict';
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
    }
  });

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
                return apply.apply(exports, [riskBoundary.wrapContext(ctx)].concat(rest));
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
