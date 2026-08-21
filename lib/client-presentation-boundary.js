const CLIENT_PRESENTATION_MARK = 'data-vision-router-presentation-boundary'

/**
 * Browser prelude for the one legacy value edge left in lib/client.js.
 *
 * DSH rc.8 made @deepseek-ai/dsh-client-ui-attachment a dynamic presentation
 * plugin and deliberately stopped exporting its React implementation as
 * package values. Vision Router must therefore own the presentation of its
 * `vision_present` tool card instead of reaching into that package.
 *
 * The current 1.7.x browser artifact is a hand-maintained self-registering
 * factory. Rewriting the entire artifact just to replace one value edge would
 * create a much larger compatibility diff, so this boundary intercepts that
 * exact legacy require *before it can reach the DSH module table* and supplies
 * a small plugin-owned gallery with the same narrow props the card already
 * passes. No DSH attachment UI code or CSS is copied.
 *
 * This is intentionally a compatibility boundary, not a general module alias:
 * only dsh-vision-router's own factory and only the historical attachment
 * specifier are intercepted. A future modular client can move these components
 * into its source directly and delete this prelude without changing card data
 * loading or Host attachment ownership.
 */
export const CLIENT_PRESENTATION_PRELUDE = String.raw`(function(){
  'use strict';
  var TARGET = 'dsh-vision-router';
  var LEGACY_ATTACHMENT_VALUE = '@deepseek-ai/dsh-client-ui-attachment';

  // #271 pre-release regression fence: #210 made the walkthrough runtime lazy,
  // but its document.body MutationObserver still invalidates the 250ms target
  // cache for every class mutation. DSH toggles transient scroll/shadow classes
  // while the settings modal moves, turning an otherwise cheap rAF scroll frame
  // back into several querySelectorAll passes + forced layout. Keep the observer
  // fully authoritative for child-list and aria mutations, but suppress class-
  // only batches for the one exact Vision Router guide observer. Normal scroll
  // frames will still refresh the cached geometry at the existing 250ms bound.
  function installGuideMutationFence() {
    var NativeObserver = window.MutationObserver;
    var doc = window.document;
    if (
      typeof NativeObserver !== 'function' ||
      NativeObserver.__visionRouterGuideMutationFence ||
      !doc || !doc.body ||
      typeof Proxy !== 'function'
    ) return;

    function isGuideObservation(callback, target, options) {
      if (!callback || callback.name !== 'resolveSync') return false;
      if (
        target !== doc.body || !options ||
        options.childList !== true || options.subtree !== true || options.attributes !== true
      ) return false;
      var filter = Array.isArray(options.attributeFilter) ? options.attributeFilter.slice().sort() : [];
      return filter.length === 3 &&
        filter[0] === 'aria-expanded' && filter[1] === 'aria-hidden' && filter[2] === 'class';
    }

    function withoutTransientClassMutations(records) {
      if (!records || typeof records.filter !== 'function') return records;
      return records.filter(function(record){
        return !(record && record.type === 'attributes' && record.attributeName === 'class');
      });
    }

    var WrappedObserver = new Proxy(NativeObserver, {
      construct: function(Target, args) {
        var callback = args && args[0];
        var guideObservation = false;
        var wrappedObserver;
        var nativeObserver = new Target(function(records) {
          var next = guideObservation ? withoutTransientClassMutations(records) : records;
          if (!next || next.length === 0) return;
          return callback(next, wrappedObserver || nativeObserver);
        });
        wrappedObserver = new Proxy(nativeObserver, {
          get: function(target, property) {
            if (property === 'observe') {
              return function(node, options) {
                guideObservation = isGuideObservation(callback, node, options);
                return target.observe(node, options);
              };
            }
            if (property === 'takeRecords') {
              return function() {
                var records = target.takeRecords();
                return guideObservation ? withoutTransientClassMutations(records) : records;
              };
            }
            var value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
        return wrappedObserver;
      }
    });
    Object.defineProperty(WrappedObserver, '__visionRouterGuideMutationFence', { value: true });
    window.MutationObserver = WrappedObserver;
  }

  function createPresentation(React) {
    function PresentedImage(props) {
      var attachment = props.attachment;
      var load = props.load;
      var labels = props.labels;
      var tile = props.tile === true;
      var state = React.useState(null);
      var src = state[0];
      var setSrc = state[1];
      var failedState = React.useState(false);
      var failed = failedState[0];
      var setFailed = failedState[1];
      var attemptState = React.useState(0);
      var attempt = attemptState[0];
      var setAttempt = attemptState[1];
      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];

      React.useEffect(function(){
        var live = true;
        setSrc(null);
        setFailed(false);
        Promise.resolve().then(function(){ return load(attachment); }).then(
          function(url){ if (live) setSrc(url); },
          function(){ if (live) setFailed(true); }
        );
        return function(){ live = false; };
      }, [attachment, load, attempt]);

      React.useEffect(function(){
        if (!open || typeof document === 'undefined') return undefined;
        var onKeyDown = function(event){ if (event && event.key === 'Escape') setOpen(false); };
        document.addEventListener('keydown', onKeyDown);
        return function(){ document.removeEventListener('keydown', onKeyDown); };
      }, [open]);

      var label = attachment && attachment.name ? attachment.name : labels.image;
      var box = tile
        ? { width: 64, height: 64 }
        : { maxWidth: 240, maxHeight: 240 };
      var frameStyle = Object.assign({
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-3)',
        padding: 0,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: src ? 'zoom-in' : failed ? 'pointer' : 'default'
      }, box);

      if (failed) {
        return React.createElement('button', {
          type: 'button',
          title: labels.loadFailed,
          onClick: function(){ setAttempt(function(value){ return value + 1; }); },
          style: Object.assign({}, frameStyle, {
            minWidth: tile ? 64 : 120,
            minHeight: tile ? 64 : 72,
            color: 'var(--dsw-alias-label-tertiary)',
            font: 'inherit',
            fontSize: 12,
            padding: 8
          })
        }, labels.loadFailed);
      }

      var thumb = React.createElement('button', {
        type: 'button',
        title: labels.open,
        'aria-label': labels.openNamed(label),
        disabled: !src,
        onClick: function(){ if (src) setOpen(true); },
        style: frameStyle
      }, src
        ? React.createElement('img', {
            src: src,
            alt: label,
            style: tile
              ? { width: '100%', height: '100%', objectFit: 'cover', display: 'block' }
              : { maxWidth: 240, maxHeight: 240, width: 'auto', height: 'auto', display: 'block' }
          })
        : React.createElement('span', {
            style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, padding: 10 }
          }, labels.loading)
      );

      if (!open || !src) return thumb;
      var overlay = React.createElement('div', {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': labels.lightbox.dialog,
        onClick: function(event){ if (event.target === event.currentTarget) setOpen(false); },
        style: {
          position: 'fixed', inset: 0, zIndex: 11000, background: '#000b',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
          boxSizing: 'border-box'
        }
      },
        React.createElement('img', {
          src: src,
          alt: label,
          style: { maxWidth: '92vw', maxHeight: '88vh', objectFit: 'contain', borderRadius: 8 }
        }),
        React.createElement('button', {
          type: 'button',
          'aria-label': labels.lightbox.close,
          title: labels.lightbox.close,
          onClick: function(){ setOpen(false); },
          style: {
            position: 'fixed', top: 16, right: 18, width: 36, height: 36,
            borderRadius: 18, border: '1px solid #ffffff55', background: '#111c',
            color: '#fff', font: 'inherit', fontSize: 22, cursor: 'pointer'
          }
        }, '×')
      );
      return React.createElement(React.Fragment, null, thumb, overlay);
    }

    function ImageGallery(props) {
      var images = Array.isArray(props.images) ? props.images : [];
      if (images.length === 0) return null;
      var tile = images.length > 1;
      return React.createElement('div', {
        style: {
          display: 'flex', flexWrap: 'wrap', gap: 6,
          justifyContent: props.align === 'end' ? 'flex-end' : 'flex-start',
          alignItems: 'flex-start', maxWidth: '100%'
        }
      }, images.map(function(image, index){
        var attachment = image && image.attachment;
        var key = attachment && attachment.attachmentId
          ? String(attachment.attachmentId) + ':' + index
          : String(index);
        return React.createElement(PresentedImage, {
          key: key,
          attachment: attachment,
          load: props.load,
          labels: props.labels,
          tile: tile
        });
      }));
    }

    return { ImageGallery: ImageGallery };
  }

  function patchLoader(loader) {
    if (!loader || (typeof loader !== 'object' && typeof loader !== 'function')) return;

    if (typeof loader.load === 'function' && !loader.load.__visionRouterPresentationBoundary) {
      var original = loader.load;
      function load(spec) {
        if (spec && spec.id === TARGET && typeof spec.factory === 'function') {
          var factory = spec.factory;
          spec = Object.assign({}, spec, {
            factory: function(require) {
              var React = require('react');
              var presentation = createPresentation(React);
              function scopedRequire(id) {
                if (id === LEGACY_ATTACHMENT_VALUE) return presentation;
                return require(id);
              }
              return factory(scopedRequire);
            }
          });
        }
        return original.call(this, spec);
      }
      Object.defineProperty(load, '__visionRouterPresentationBoundary', { value: true });
      loader.load = load;
    }

    // rc.8's parser installs a queue-mode facade first. When the Web shell
    // later calls create(), ClientModuleSystem switches that *same object* to
    // live mode by assigning a brand-new loader.load function. That assignment
    // necessarily erases every queue-time wrapper. Wrap create itself so the
    // boundary is re-applied immediately after the official queue -> live
    // transition and before lazy third-party bundles can register.
    if (typeof loader.create === 'function' && !loader.create.__visionRouterPresentationBoundary) {
      var originalCreate = loader.create;
      function create() {
        var result = originalCreate.apply(this, arguments);
        patchLoader(loader);
        return result;
      }
      Object.defineProperty(create, '__visionRouterPresentationBoundary', { value: true });
      loader.create = create;
    }
  }

  function install() {
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
  }

  install();
})();`

export function injectClientPresentationBoundary(html) {
  if (typeof html !== 'string' || html.includes(CLIENT_PRESENTATION_MARK)) return html
  const safe = CLIENT_PRESENTATION_PRELUDE.replace(/<\/script/gi, '<\\/script')
  const script = `<script ${CLIENT_PRESENTATION_MARK}>${safe}</script>`
  // DSH's client-modules index tap prepends the queue-mode loader bootstrap at
  // <head>. Run after that parser bootstrap so we can wrap both load() and the
  // later create() transition. The create wrapper re-applies the boundary when
  // rc.8 replaces loader.load while entering live mode.
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installClientPresentationBoundary(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectClientPresentationBoundary),
      'vision-router: client presentation boundary',
    )
  })
}
