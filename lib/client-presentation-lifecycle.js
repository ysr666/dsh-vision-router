import { CLIENT_PRESENTATION_PRELUDE } from './client-presentation-boundary.js'

const CLIENT_PRESENTATION_MARK = 'data-vision-router-presentation-boundary'

const OLD_CREATE = `      function create() {
        var result = originalCreate.apply(this, arguments);
        patchLoader(loader);
        return result;
      }`

const NEW_CREATE = `      function create() {
        var result = originalCreate.apply(this, arguments);
        patchLoader(loader);
        if (result && result !== loader) patchLoader(result);
        return result;
      }`

const OLD_INSTALL = `  function install() {
    installGuideMutationFence();
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
  }`

const NEW_INSTALL = `  function install() {
    installGuideMutationFence();
    var descriptor = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__');
    var stored = window.__ModuleLoader__;
    if (stored) patchLoader(stored);
    // A non-configurable Host slot cannot be trapped. The currently installed
    // loader is still patched above; future full-slot replacement is then a
    // Host contract change rather than something this compatibility layer can
    // safely intercept.
    if (descriptor && descriptor.configurable === false) return;
    Object.defineProperty(window, '__ModuleLoader__', {
      configurable: true,
      enumerable: true,
      get: function(){ return stored; },
      set: function(value) {
        stored = value;
        patchLoader(value);
      }
    });
  }`

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`vision-router: client presentation ${label} seam drifted`)
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`
}

/**
 * Keep the large hand-maintained 1.7.x presentation prelude single-sourced.
 * This compatibility shim changes only its ModuleLoader lifecycle seam:
 * create() may return a new loader object, and the global loader slot may be
 * replaced more than once. Exact-source guards make any future refactor fail
 * loudly in tests instead of silently dropping the Vision control.
 */
export function hardenedClientPresentationPrelude(source = CLIENT_PRESENTATION_PRELUDE) {
  return replaceExactlyOnce(
    replaceExactlyOnce(source, OLD_CREATE, NEW_CREATE, 'create()'),
    OLD_INSTALL,
    NEW_INSTALL,
    'install()',
  )
}

export const HARDENED_CLIENT_PRESENTATION_PRELUDE = hardenedClientPresentationPrelude()

export function injectHardenedClientPresentationBoundary(html) {
  if (typeof html !== 'string' || html.includes(CLIENT_PRESENTATION_MARK)) return html
  const safe = HARDENED_CLIENT_PRESENTATION_PRELUDE.replace(/<\/script/gi, '<\\/script')
  const script = `<script ${CLIENT_PRESENTATION_MARK}>${safe}</script>`
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installHardenedClientPresentationBoundary(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectHardenedClientPresentationBoundary),
      'vision-router: client presentation boundary',
    )
  })
}
