import {
  SETTINGS_IA_CLIENT_PRELUDE,
  injectSettingsIaClientPrelude,
} from './settings-ia-client-prelude.js'
import {
  SETTINGS_LIMIT_CLIENT_PRELUDE,
  injectSettingsLimitClientPrelude,
} from './settings-limit-client-prelude.js'
import {
  SETTINGS_NATIVE_CARD_IA_PRELUDE,
  injectSettingsNativeCardStyle,
} from './settings-native-card-layout.js'

const CLIENT_MARK = 'data-vision-router-settings-factory-lifecycle'
const IA_SCRIPT_MARK = 'data-vision-router-settings-ia'
const LIMIT_SCRIPT_MARK = 'data-vision-router-settings-limit-hardening'

function scriptMarkup(mark, source) {
  const safe = source.replace(/<\/script/gi, '<\\/script')
  return `<script ${mark}>${safe}</script>`
}

const IA_SCRIPT = scriptMarkup(IA_SCRIPT_MARK, SETTINGS_IA_CLIENT_PRELUDE)
const LIMIT_SCRIPT = scriptMarkup(LIMIT_SCRIPT_MARK, SETTINGS_LIMIT_CLIENT_PRELUDE)

/**
 * One lifecycle owner for every decorator that shapes the Vision Router
 * settings factory.
 *
 * DSH 0.1.2-alpha.1 keeps the bootstrap facade object but replaces its
 * `load()` sink inside `create()`. A decorator installed only against the
 * queue sink therefore disappears silently before the DVR bundle registers.
 * Keep the mature IA/numeric implementations intact; the card composition
 * layer changes only their presentation shell and guide replay affordance.
 *
 * Order is intentional: Limit installs first, card-composed IA second. This
 * makes the IA replacement reach the original settings.section registration
 * before the Limit wrapper adds validation/diagnostics around the final IA
 * component.
 */
export const SETTINGS_FACTORY_LIFECYCLE_PRELUDE = String.raw`(function(){
  'use strict';

  var installers = [
    function installLimit(){
      ${SETTINGS_LIMIT_CLIENT_PRELUDE}
    },
    function installIa(){
      ${SETTINGS_NATIVE_CARD_IA_PRELUDE}
    }
  ];

  function arm() {
    for (var i = 0; i < installers.length; i += 1) {
      try { installers[i](); } catch (_) {}
    }
  }

  function patchCreate(loader) {
    if (!loader || (typeof loader !== 'object' && typeof loader !== 'function')) return;
    if (typeof loader.create !== 'function' || loader.create.__visionRouterSettingsFactoryLifecycle) return;
    var originalCreate = loader.create;
    function create() {
      var result = originalCreate.apply(this, arguments);
      // alpha.1 assigns a brand-new live load() inside create(). Re-arm the
      // exact same Settings decorators immediately after that official switch.
      arm();
      return result;
    }
    try {
      Object.defineProperty(create, '__visionRouterSettingsFactoryLifecycle', { value: true });
    } catch (_) {}
    loader.create = create;
  }

  function attach(loader) {
    if (!loader || (typeof loader !== 'object' && typeof loader !== 'function')) return;
    arm();
    patchCreate(loader);
  }

  function install() {
    if (window.__ModuleLoader__) {
      attach(window.__ModuleLoader__);
      return;
    }
    var descriptor = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__');
    if (descriptor && descriptor.configurable === false) return;
    var previousGet = descriptor && descriptor.get;
    var previousSet = descriptor && descriptor.set;
    var stored = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : undefined;
    Object.defineProperty(window, '__ModuleLoader__', {
      configurable: true,
      enumerable: descriptor ? descriptor.enumerable === true : true,
      get: function() {
        return typeof previousGet === 'function' ? previousGet.call(window) : stored;
      },
      set: function(value) {
        if (typeof previousSet === 'function') previousSet.call(window, value);
        else stored = value;
        var resolved = typeof previousGet === 'function' ? previousGet.call(window) : stored;
        if (!resolved) resolved = value;
        attach(resolved);
      }
    });
  }

  try { install(); } catch (_) {}
})();`

/**
 * Collapse the two historical Settings factory scripts into one lifecycle-
 * aware script while preserving the IA stylesheet and adding the lightweight
 * DSH-style disclosure-card chrome. Calling the historical injectors first
 * keeps this transform self-sufficient if installer ordering changes later;
 * their executable tags are then removed deterministically.
 */
export function injectSettingsFactoryLifecycle(html) {
  if (typeof html !== 'string' || html.includes(CLIENT_MARK)) return html

  let next = injectSettingsLimitClientPrelude(html)
  next = injectSettingsIaClientPrelude(next)
  next = injectSettingsNativeCardStyle(next)
  next = next.split(LIMIT_SCRIPT).join('')
  next = next.split(IA_SCRIPT).join('')

  const safe = SETTINGS_FACTORY_LIFECYCLE_PRELUDE.replace(/<\/script/gi, '<\\/script')
  const script = `<script ${CLIENT_MARK}>${safe}</script>`
  const closeHead = next.indexOf('</head>')
  return closeHead === -1
    ? `${next}${script}`
    : `${next.slice(0, closeHead)}${script}${next.slice(closeHead)}`
}

export function installSettingsFactoryLifecycle(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectSettingsFactoryLifecycle),
      'vision-router: converged settings client factory lifecycle',
    )
  })
}
