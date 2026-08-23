const CLIENT_PRESENTATION_MARK = 'data-vision-router-presentation-boundary'

function visionModeGroup(groups, id) {
  if (!Array.isArray(groups) || typeof id !== 'string' || id === '') return undefined
  return groups.find((group) => group && group.id === id)
}

function visionModeHasModel(group, modelId) {
  return !!group && Array.isArray(group.models) && group.models.some(
    (model) => model && model.id === modelId,
  )
}

function visionModeOwnedTwin(groups, sourceProvider, twinProvider, modelId) {
  const source = visionModeGroup(groups, sourceProvider)
  const twin = visionModeGroup(groups, twinProvider)
  if (!source || !twin) return false
  if (twinProvider !== `${sourceProvider}-vision`) return false
  if (!visionModeHasModel(source, modelId) || !visionModeHasModel(twin, modelId)) return false
  const sourceName = typeof source.name === 'string' && source.name !== '' ? source.name : sourceProvider
  return twin.name === `${sourceName} + 自动识图`
}

function visionModeTarget(current, provider) {
  return {
    provider,
    model: current.model,
    ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }),
  }
}

/**
 * Derive the explicit composer vision-mode action from DSH's one authoritative
 * per-session model directory. There is deliberately no second boolean state:
 * a generated `<provider>-vision` twin means ON, its source route means OFF.
 *
 * A `-vision` suffix alone is not ownership evidence. The generated twin must
 * mirror the exact model and carry Vision Router's provider display-name
 * contract (`<source name> + 自动识图`), otherwise the button stays unavailable
 * rather than switching into a third-party lookalike route.
 */
export function resolveVisionModePair(groups, current) {
  if (
    !current || typeof current !== 'object' ||
    typeof current.provider !== 'string' || current.provider === '' ||
    typeof current.model !== 'string' || current.model === ''
  ) {
    return { mode: 'unavailable' }
  }

  if (current.provider.endsWith('-vision')) {
    const sourceProvider = current.provider.slice(0, -'-vision'.length)
    if (!sourceProvider || !visionModeOwnedTwin(groups, sourceProvider, current.provider, current.model)) {
      return { mode: 'unavailable' }
    }
    return { mode: 'on', target: visionModeTarget(current, sourceProvider) }
  }

  const twinProvider = `${current.provider}-vision`
  if (!visionModeOwnedTwin(groups, current.provider, twinProvider, current.model)) {
    return { mode: 'unavailable' }
  }
  return { mode: 'off', target: visionModeTarget(current, twinProvider) }
}

const VISION_MODE_HELPER_SOURCE = [
  visionModeGroup,
  visionModeHasModel,
  visionModeOwnedTwin,
  visionModeTarget,
  resolveVisionModePair,
].map((fn) => fn.toString()).join('\n')

/**
 * Browser prelude for the two compatibility surfaces still owned by the
 * hand-maintained 1.7.x client factory.
 *
 * 1. DSH rc.8 made @deepseek-ai/dsh-client-ui-attachment a dynamic
 * presentation plugin and deliberately stopped exporting its React
 * implementation as package values. Vision Router therefore supplies its own
 * narrow ImageGallery value only to its own legacy factory.
 *
 * 2. Issue #284 adds a composer-side explicit Vision mode control. The control
 * does not own a boolean, watch images, or hook send lifecycle. It subscribes
 * to DSH's shared per-session ModelDirectory and switches only between an
 * ordinary provider/model and the exact generated `<provider>-vision` twin.
 * This makes the stock model picker and the new affordance share one source of
 * truth while preserving manual model changes and reasoning effort.
 *
 * Rewriting the entire generated client artifact for either concern would
 * create a much larger compatibility diff. This boundary intercepts only the
 * dsh-vision-router factory before it reaches the DSH module table and survives
 * rc.8's queue -> live loader replacement.
 */
export const CLIENT_PRESENTATION_PRELUDE = String.raw`(function(){
  'use strict';
  var TARGET = 'dsh-vision-router';
  var LEGACY_ATTACHMENT_VALUE = '@deepseek-ai/dsh-client-ui-attachment';
  var VISION_MODE_NS = 'vision-router-mode';

  ${VISION_MODE_HELPER_SOURCE}

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

  function installVisionModeToggle(ctx, React) {
    if (!ctx || typeof ctx.inject !== 'function' || !React) return;
    var zh = {
      label: '识图',
      enable: '开启识图模式',
      disable: '关闭识图模式',
      unavailable: '当前模型没有对应的「+ 自动识图」版本',
      switching: '正在切换识图模式…'
    };
    var en = {
      label: 'Vision',
      enable: 'Enable Vision mode',
      disable: 'Disable Vision mode',
      unavailable: 'No matching “+ Auto Vision” model is available',
      switching: 'Switching Vision mode…'
    };

    try {
      ctx.effect(function(){ return ctx.locale.register(VISION_MODE_NS, { zh: zh, en: en }); }, 'vision-router: mode toggle locale');
    } catch (_) {}

    ctx.inject(['slots', 'modelDirectories'], function(scope) {
      var models;
      try {
        models = scope.modelDirectories || (typeof scope.get === 'function' ? scope.get('modelDirectories') : undefined);
      } catch (_) {
        models = undefined;
      }
      if (!models || typeof models.directoryFor !== 'function') return;

      function VisionModeToggle(props) {
        var directory = props.directory;
        var store = directory && directory.store;
        var fallbackState = { current: null, groups: [], status: 'idle', error: null };
        var state = React.useSyncExternalStore(
          store && typeof store.subscribe === 'function' ? function(listener){ return store.subscribe(listener); } : function(){ return function(){}; },
          store && typeof store.getSnapshot === 'function' ? function(){ return store.getSnapshot(); } : function(){ return fallbackState; }
        );
        var pair = resolveVisionModePair(state.groups, state.current);
        var active = pair.mode === 'on';
        var busy = state.status === 'selecting';
        var removed = props.session && props.session.removed === true;
        var disabled = props.available !== true || removed || busy || pair.mode === 'unavailable';
        var t = typeof props.t === 'function'
          ? props.t
          : function(key){ return (active ? zh.disable : zh.enable); };
        var title = busy
          ? t('switching')
          : pair.mode === 'unavailable'
            ? t('unavailable')
            : active ? t('disable') : t('enable');
        var style = {
          appearance: 'none',
          minHeight: 28,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '4px 8px',
          borderRadius: 8,
          border: '1px solid ' + (active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'),
          background: active ? 'var(--dsw-alias-bg-module-platform)' : 'transparent',
          color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
          font: 'inherit',
          fontSize: 12,
          lineHeight: 1.4,
          fontWeight: active ? 600 : 500,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled && pair.mode === 'unavailable' ? 0.45 : 1,
          whiteSpace: 'nowrap'
        };
        return React.createElement('button', {
          type: 'button',
          'aria-pressed': active,
          'aria-label': title,
          title: title,
          disabled: disabled,
          style: style,
          onClick: function() {
            if (disabled || !pair.target || !directory || typeof directory.select !== 'function') return;
            void directory.select(pair.target).catch(function(){});
          }
        },
          React.createElement('span', { 'aria-hidden': 'true', style: { fontSize: 13, lineHeight: 1 } }, '👁'),
          React.createElement('span', null, t('label'))
        );
      }

      scope.effect(function() {
        return scope.slots.inject('conversation.input.right', function*() {
          yield scope.slots.register({
            name: 'conversation.input.right',
            id: 'vision-router-mode-toggle',
            order: 40,
            locale: VISION_MODE_NS,
            inject: function(sessionId) {
              var directory = models.directoryFor(sessionId);
              var available = true;
              try {
                available = !scope.sessions || typeof scope.sessions.subagentAddress !== 'function'
                  ? true
                  : scope.sessions.subagentAddress(sessionId) === undefined;
              } catch (_) {
                available = false;
              }
              return { directory: directory, available: available };
            }
          }, VisionModeToggle);
        });
      }, 'vision-router: composer vision mode toggle');
    });
  }

  function decorateVisionRouterPlugin(plugin, React) {
    if (!plugin || typeof plugin !== 'object' || typeof plugin.apply !== 'function') return plugin;
    if (plugin.apply.__visionRouterModeToggle) return plugin;
    var originalApply = plugin.apply;
    function apply(ctx) {
      var result = originalApply.apply(this, arguments);
      try {
        installVisionModeToggle(ctx, React);
      } catch (error) {
        try { console.warn('vision-router: failed to install composer vision mode toggle', error); } catch (_) {}
      }
      return result;
    }
    try { Object.defineProperty(apply, '__visionRouterModeToggle', { value: true }); } catch (_) {}
    plugin.apply = apply;
    return plugin;
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
              return decorateVisionRouterPlugin(factory(scopedRequire), React);
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
