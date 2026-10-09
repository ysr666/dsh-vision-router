import { injectClientCarrierHtml, installClientScriptCarriers } from './client-script-carrier.js'
const CLIENT_PRESENTATION_MARK = 'data-vision-router-presentation-boundary'
const VISION_MODE_WRAPPER_SOURCE = 'deepseek-official'

function visionModeGroup(groups, id) {
  if (!Array.isArray(groups) || typeof id !== 'string' || id === '') return undefined
  return groups.find((group) => group && group.id === id)
}

function visionModeHasModel(group, modelId) {
  return !!group && Array.isArray(group.models) && group.models.some(
    (model) => model && model.id === modelId,
  )
}

function visionModePairMatches(groups, sourceProvider, targetProvider, modelId, targetName) {
  const source = visionModeGroup(groups, sourceProvider)
  const target = visionModeGroup(groups, targetProvider)
  if (!source || !target) return false
  if (!visionModeHasModel(source, modelId) || !visionModeHasModel(target, modelId)) return false
  return target.name === targetName
}

function visionModeHasOwn(config, key) {
  return !!config && typeof config === 'object' && Object.prototype.hasOwnProperty.call(config, key)
}

function visionModeTwinIntended(config, sourceProvider, modelId) {
  if (!config || typeof config !== 'object') return true
  const entries = Array.isArray(config.wrappedProviders) ? config.wrappedProviders : []
  const explicit = entries.find((entry) => entry && entry.provider === sourceProvider)
  if (explicit) {
    const models = Array.isArray(explicit.models) ? explicit.models : []
    return models.length === 0 || models.includes(modelId)
  }
  return config.autoWrapProviders !== false
}

function visionModeOwnedTwin(groups, sourceProvider, twinProvider, modelId, config) {
  if (twinProvider !== `${sourceProvider}-vision`) return false
  // Keep client ownership identical to the core adapter registry: Vision Router
  // never generates a twin from a source route that already ends in "-vision".
  if (sourceProvider.endsWith('-vision')) return false
  if (!visionModeTwinIntended(config, sourceProvider, modelId)) return false
  const source = visionModeGroup(groups, sourceProvider)
  if (!source) return false
  const sourceName = typeof source.name === 'string' && source.name !== '' ? source.name : sourceProvider
  return visionModePairMatches(
    groups,
    sourceProvider,
    twinProvider,
    modelId,
    `${sourceName} + 自动识图`,
  )
}

function visionModeConfiguredWrapperRoute(config) {
  const route = config && typeof config.wrapperRoute === 'string' ? config.wrapperRoute.trim() : ''
  return route || undefined
}

function visionModeWrapperRoute(groups, config, modelId) {
  const configured = visionModeConfiguredWrapperRoute(config)
  if (visionModeHasOwn(config, 'wrapperRoute')) return configured
  const source = visionModeGroup(groups, VISION_MODE_WRAPPER_SOURCE)
  if (!source) return undefined
  const sourceName = typeof source.name === 'string' && source.name !== ''
    ? source.name
    : VISION_MODE_WRAPPER_SOURCE
  const expectedName = `${sourceName} + 自动识图`
  const candidates = Array.isArray(groups)
    ? groups.filter((group) =>
        group &&
        group.id !== VISION_MODE_WRAPPER_SOURCE &&
        group.name === expectedName &&
        visionModeHasModel(group, modelId),
      )
    : []
  return candidates.length === 1 ? candidates[0].id : undefined
}

function visionModeOwnedWrapper(groups, wrapperRoute, modelId) {
  if (typeof wrapperRoute !== 'string' || wrapperRoute === '') return false
  const source = visionModeGroup(groups, VISION_MODE_WRAPPER_SOURCE)
  if (!source) return false
  const sourceName = typeof source.name === 'string' && source.name !== ''
    ? source.name
    : VISION_MODE_WRAPPER_SOURCE
  return visionModePairMatches(
    groups,
    VISION_MODE_WRAPPER_SOURCE,
    wrapperRoute,
    modelId,
    `${sourceName} + 自动识图`,
  )
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
 * a Vision Router wrapper means ON, its source route means OFF.
 *
 * DeepSeek is a deliberate special case: the built-in source
 * `deepseek-official` maps to the configured `wrapperRoute`. When that setting
 * is not visible to the browser (for example on a remote Web client), the
 * resolver accepts only one unambiguous DeepSeek + 自动识图 mirror from the
 * directory and otherwise fails closed. Other providers keep the generated
 * `<provider>-vision` contract and honor autoWrapProviders/wrappedProviders
 * when those settings are available.
 */
export function resolveVisionModePair(groups, current, config = {}) {
  if (
    !current || typeof current !== 'object' ||
    typeof current.provider !== 'string' || current.provider === '' ||
    typeof current.model !== 'string' || current.model === ''
  ) {
    return { mode: 'unavailable' }
  }

  const wrapperRoute = visionModeWrapperRoute(groups, config, current.model)
  if (current.provider === VISION_MODE_WRAPPER_SOURCE) {
    if (!visionModeOwnedWrapper(groups, wrapperRoute, current.model)) {
      return { mode: 'unavailable' }
    }
    return { mode: 'off', target: visionModeTarget(current, wrapperRoute) }
  }

  if (wrapperRoute && current.provider === wrapperRoute) {
    if (!visionModeOwnedWrapper(groups, wrapperRoute, current.model)) {
      return { mode: 'unavailable' }
    }
    return { mode: 'on', target: visionModeTarget(current, VISION_MODE_WRAPPER_SOURCE) }
  }

  if (current.provider.endsWith('-vision')) {
    const sourceProvider = current.provider.slice(0, -'-vision'.length)
    if (
      sourceProvider &&
      visionModeOwnedTwin(groups, sourceProvider, current.provider, current.model, config)
    ) {
      return { mode: 'on', target: visionModeTarget(current, sourceProvider) }
    }
    // Core excludes source routes ending in "-vision" from both auto and
    // explicit twin registration. If this route is not a verified wrapper of
    // another source, do not manufacture a nested "-vision-vision" pair.
    return { mode: 'unavailable' }
  }

  const twinProvider = `${current.provider}-vision`
  if (!visionModeOwnedTwin(groups, current.provider, twinProvider, current.model, config)) {
    return { mode: 'unavailable' }
  }
  return { mode: 'off', target: visionModeTarget(current, twinProvider) }
}

const VISION_MODE_HELPER_SOURCE = [
  visionModeGroup,
  visionModeHasModel,
  visionModePairMatches,
  visionModeHasOwn,
  visionModeTwinIntended,
  visionModeOwnedTwin,
  visionModeConfiguredWrapperRoute,
  visionModeWrapperRoute,
  visionModeOwnedWrapper,
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
 * ordinary provider/model and the matching Vision Router wrapper route. This
 * makes the stock model picker and the new affordance share one source of truth
 * while preserving manual model changes and reasoning effort.
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
  var VISION_MODE_WRAPPER_SOURCE = 'deepseek-official';

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

  function patchVisionModeCopy(namespace, dictionaries) {
    if (namespace !== 'vision-router' || !dictionaries || typeof dictionaries !== 'object') return dictionaries;
    var next = Object.assign({}, dictionaries);
    if (next.zh && typeof next.zh === 'object') {
      next.zh = Object.assign({}, next.zh, {
        quickStartTitle: '聊天模型 + 识图模式',
        quickStartBody: '先选择你平时使用的聊天模型。需要看图时，点击输入框旁的「识图」；它变成选中态（高亮底色）表示已开启。开启后会持续生效；在同一模型组内切换到另一个支持识图模式的模型也会保持开启，直到你主动关闭或切到没有对应识图模式的普通模型。',
        onboardingStep1Title: '1 · 选择聊天模型并开启识图',
        onboardingStep1Body: '先在聊天页右下角选择你平时使用的模型。需要看图时，点击模型选择器左侧的「识图」；它变成选中态（高亮底色）表示已开启，不需要时再主动关闭。',
        guideStep1Title: '第 1 步 · 选择聊天模型并认识「识图」',
        guideStep1Body: '高亮的是聊天模型选择器；它左侧就是「识图」按钮。先选择你平时使用的聊天模型；需要看图时点击「识图」，它变成选中态（高亮底色）表示已开启。开启后会持续生效；在同一模型组内切换到另一个支持识图模式的模型也会保持开启，直到你主动关闭或切到没有对应识图模式的普通模型。选好后点击「下一步」。'
      });
    }
    if (next.en && typeof next.en === 'object') {
      next.en = Object.assign({}, next.en, {
        quickStartTitle: 'Chat model + Vision mode',
        quickStartBody: 'Choose the chat model you normally use first. When you need image understanding, click “Vision” beside the composer; the chip lights up in its selected state to mean it is on. It stays on when you switch to another Vision-enabled model in the same model group, until you turn it off or choose a normal model with no matching Vision route.',
        onboardingStep1Title: '1 · Choose your chat model and enable Vision',
        onboardingStep1Body: 'Choose the model you normally use from the lower-right chat selector. When you need image understanding, click “Vision” immediately to the left of the model selector; the chip lights up in its selected state to mean it is on. Turn it off again when you no longer need it.',
        guideStep1Title: 'Step 1 · Choose your chat model and find “Vision”',
        guideStep1Body: 'The highlighted control is the chat model selector; the “Vision” button is immediately to its left. Choose your normal chat model first, then click “Vision” when you need image understanding. The chip lights up in its selected state to mean it is on. It stays on when you switch to another Vision-enabled model in the same model group, until you turn it off or choose a normal model with no matching Vision route. Click “Next” when done.'
      });
    }
    return next;
  }

  function contextWithVisionModeCopy(ctx) {
    if (!ctx || typeof ctx !== 'object' || typeof Proxy !== 'function') return ctx;
    var locale = ctx.locale;
    if (!locale || (typeof locale !== 'object' && typeof locale !== 'function')) return ctx;
    var wrappedLocale = new Proxy(locale, {
      get: function(target, property) {
        if (property === 'register') {
          var register = Reflect.get(target, property, target);
          if (typeof register !== 'function') return register;
          return function(namespace, dictionaries) {
            var rest = Array.prototype.slice.call(arguments, 2);
            return register.apply(target, [namespace, patchVisionModeCopy(namespace, dictionaries)].concat(rest));
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    return new Proxy(ctx, {
      get: function(target, property) {
        if (property === 'locale') return wrappedLocale;
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  function bindVisionModeSettings(ctx) {
    try {
      var binder = ctx && ctx.settingsScope;
      if (!binder || typeof binder.bind !== 'function') return undefined;
      return binder.bind({ namespace: 'vision-router' });
    } catch (_) {
      return undefined;
    }
  }

  // #138 Windows clipboard compatibility: desktop clipboards may expose an
  // image as BMP/empty MIME, or may declare a supported MIME that disagrees with
  // the actual bytes (for example .png + image/png carrying JPEG bytes). DSH
  // validates the declaration before/while creating the draft, and its local
  // attachment store rejects declaration/content mismatches. Inspect image-like
  // clipboard files by magic bytes before Lexical's CRITICAL paste handler sees
  // them; canonical files keep the original File object and are never re-encoded.
  function installClipboardImagePasteCompat(ctx) {
    if (!ctx || typeof ctx.effect !== 'function') return;
    ctx.effect(function() {
      var doc = window.document;
      if (!doc || typeof doc.addEventListener !== 'function') return function(){};
      if (
        typeof window.DataTransfer !== 'function' ||
        typeof window.ClipboardEvent !== 'function' ||
        typeof window.File !== 'function' ||
        typeof WeakSet !== 'function'
      ) return function(){};

      var replayed = new WeakSet();
      var supported = {
        'image/png': true,
        'image/jpeg': true,
        'image/webp': true,
        'image/gif': true
      };
      var bitmapTypes = {
        'image/bmp': true,
        'image/x-bmp': true,
        'image/x-ms-bmp': true
      };

      function mediaType(value) {
        return typeof value === 'string' ? value.trim().toLowerCase() : '';
      }

      function imageLikeName(value) {
        return typeof value === 'string' && /\.(?:png|jpe?g|webp|gif|bmp|dib)$/i.test(value.trim());
      }

      function needsInspection(file) {
        if (!file) return false;
        var type = mediaType(file.type);
        return type === '' || type.indexOf('image/') === 0 || imageLikeName(file.name);
      }

      var normalizedBitmapFiles = new WeakSet();
      var maxExactDedupeBytes = 8 * 1024 * 1024;
      var maxVisualDedupeSourceBytes = 16 * 1024 * 1024;
      var maxVisualDedupeDimension = 4096;
      var maxVisualDedupePixels = 9000000;
      var visualDedupeTile = 256;

      function supportedImage(file) {
        return !!file && supported[mediaType(file.type)] === true;
      }

      function syntheticClipboardName(name) {
        var value = typeof name === 'string' ? name.trim() : '';
        if (value === '') return true;
        return /^(?:image|clipboard)(?:[ _-]?\d+)?\.(?:png|jpe?g|webp|gif)$/i.test(value);
      }

      function syntheticClipboardFile(file) {
        return !!file && (normalizedBitmapFiles.has(file) || syntheticClipboardName(file.name));
      }

      function hasDedupeSignal(files) {
        var images = files.filter(supportedImage);
        for (var i = 0; i < images.length; i += 1) {
          for (var j = i + 1; j < images.length; j += 1) {
            var left = images[i];
            var right = images[j];
            if (
              (Number.isFinite(left.size) && left.size > 0 && left.size === right.size) ||
              (mediaType(left.type) === mediaType(right.type) &&
                (syntheticClipboardFile(left) || syntheticClipboardFile(right)))
            ) return true;
          }
        }
        return false;
      }

      function bytesOf(file) {
        if (!file || typeof file.arrayBuffer !== 'function') return Promise.resolve(undefined);
        try {
          return Promise.resolve(file.arrayBuffer()).then(function(buffer) {
            return new Uint8Array(buffer);
          }, function(){ return undefined; });
        } catch (_) {
          return Promise.resolve(undefined);
        }
      }

      function sameBytes(left, right) {
        if (
          !left || !right ||
          !Number.isFinite(left.size) || left.size <= 0 || left.size !== right.size ||
          left.size > maxExactDedupeBytes
        ) return Promise.resolve(false);
        return Promise.all([bytesOf(left), bytesOf(right)]).then(function(values) {
          var a = values[0];
          var b = values[1];
          if (!a || !b || a.length !== b.length) return false;
          for (var i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
          return true;
        }, function(){ return false; });
      }

      function visualPairAllowed(left, right) {
        if (!left || !right) return false;
        if (mediaType(left.type) !== 'image/png' || mediaType(right.type) !== 'image/png') return false;
        if (!(syntheticClipboardFile(left) || syntheticClipboardFile(right))) return false;
        return Number.isFinite(left.size) && left.size > 0 && left.size <= maxVisualDedupeSourceBytes &&
          Number.isFinite(right.size) && right.size > 0 && right.size <= maxVisualDedupeSourceBytes;
      }

      function closeBitmap(bitmap) {
        try { if (bitmap && typeof bitmap.close === 'function') bitmap.close(); } catch (_) {}
      }

      function visualInfoAllowed(leftInfo, rightInfo) {
        if (!leftInfo || !rightInfo || leftInfo.type !== 'image/png' || rightInfo.type !== 'image/png') return false;
        var width = leftInfo.width;
        var height = leftInfo.height;
        return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 &&
          width === rightInfo.width && height === rightInfo.height &&
          width <= maxVisualDedupeDimension && height <= maxVisualDedupeDimension &&
          width * height <= maxVisualDedupePixels;
      }

      function bitmapPixelsMatch(left, right) {
        if (!visualPairAllowed(left, right) || typeof window.createImageBitmap !== 'function') return Promise.resolve(false);
        return Promise.all([headType(left), headType(right)]).then(function(infos) {
          if (!visualInfoAllowed(infos[0], infos[1])) return false;
          return Promise.resolve(window.createImageBitmap(left)).then(function(leftBitmap) {
          return Promise.resolve(window.createImageBitmap(right)).then(function(rightBitmap) {
            try {
              var width = leftBitmap && leftBitmap.width;
              var height = leftBitmap && leftBitmap.height;
              if (
                !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
                width !== rightBitmap.width || height !== rightBitmap.height ||
                width > maxVisualDedupeDimension || height > maxVisualDedupeDimension ||
                width * height > maxVisualDedupePixels
              ) return false;
              var canvas = doc.createElement('canvas');
              var context = canvas.getContext && canvas.getContext('2d', { willReadFrequently: true });
              if (!context || typeof context.drawImage !== 'function' || typeof context.getImageData !== 'function') return false;
              for (var y = 0; y < height; y += visualDedupeTile) {
                for (var x = 0; x < width; x += visualDedupeTile) {
                  var tileWidth = Math.min(visualDedupeTile, width - x);
                  var tileHeight = Math.min(visualDedupeTile, height - y);
                  canvas.width = tileWidth;
                  canvas.height = tileHeight;
                  context.drawImage(leftBitmap, x, y, tileWidth, tileHeight, 0, 0, tileWidth, tileHeight);
                  var leftPixels = context.getImageData(0, 0, tileWidth, tileHeight).data;
                  context.drawImage(rightBitmap, x, y, tileWidth, tileHeight, 0, 0, tileWidth, tileHeight);
                  var rightPixels = context.getImageData(0, 0, tileWidth, tileHeight).data;
                  if (!leftPixels || !rightPixels || leftPixels.length !== rightPixels.length) return false;
                  for (var i = 0; i < leftPixels.length; i += 1) {
                    if (leftPixels[i] !== rightPixels[i]) return false;
                  }
                }
              }
              return true;
            } catch (_) {
              return false;
            } finally {
              closeBitmap(leftBitmap);
              closeBitmap(rightBitmap);
            }
          }, function() {
            closeBitmap(leftBitmap);
            return false;
          });
          }, function(){ return false; });
        }, function(){ return false; });
      }

      function duplicatePair(left, right) {
        if (!supportedImage(left) || !supportedImage(right)) return Promise.resolve(false);
        return sameBytes(left, right).then(function(exact) {
          return exact ? true : bitmapPixelsMatch(left, right);
        }, function(){ return false; });
      }

      function preferredDuplicate(left, right) {
        if (syntheticClipboardFile(left) && !syntheticClipboardFile(right)) return right;
        return left;
      }

      function dedupeBatch(files) {
        if (!hasDedupeSignal(files)) return Promise.resolve(files);
        var kept = [];
        var chain = Promise.resolve();
        files.forEach(function(file) {
          chain = chain.then(function() {
            var index = 0;
            function compareNext() {
              if (index >= kept.length) {
                kept.push(file);
                return Promise.resolve();
              }
              var current = index;
              index += 1;
              return duplicatePair(kept[current], file).then(function(duplicate) {
                if (!duplicate) return compareNext();
                kept[current] = preferredDuplicate(kept[current], file);
                return undefined;
              }, function(){ return compareNext(); });
            }
            return compareNext();
          });
        });
        return chain.then(function(){ return kept; }, function(){ return files; });
      }

      function composerEditable(target) {
        var element = target && target.nodeType === 1
          ? target
          : target && target.parentElement;
        if (!element || typeof element.closest !== 'function') return null;
        var editable = element.closest('[data-composer-input]');
        if (!editable || typeof editable.closest !== 'function') return null;
        return editable.closest('[data-composer-card]') ? editable : null;
      }

      function snapshotText(data) {
        var entries = [];
        var types = data && data.types ? Array.from(data.types) : [];
        types.forEach(function(type) {
          if (type === 'Files') return;
          try {
            var value = data.getData(type);
            if (typeof value === 'string' && value !== '') entries.push([type, value]);
          } catch (_) {}
        });
        return entries;
      }

      var maxBitmapSourceBytes = 64 * 1024 * 1024;
      var maxBitmapDimension = 10000;
      var maxBitmapPixels = 100000000;

      function sniffImageInfo(bytes) {
        if (!bytes || bytes.length < 2) return undefined;
        if (
          bytes.length >= 8 &&
          bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
          bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
        ) {
          if (bytes.length < 24 || typeof DataView !== 'function') return { type: 'image/png' };
          try {
            var pngView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            return {
              type: 'image/png',
              width: pngView.getUint32(16, false),
              height: pngView.getUint32(20, false)
            };
          } catch (_) {
            return { type: 'image/png' };
          }
        }
        if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: 'image/jpeg' };
        if (
          bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
          bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
) return { type: 'image/gif' };
        if (
          bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
          bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
) return { type: 'image/webp' };
        if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
          if (bytes.length < 26 || typeof DataView !== 'function') return { type: 'image/bmp' };
          try {
            var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            var dibSize = bytes.length >= 18 ? view.getUint32(14, true) : 0;
            if (dibSize < 40) return { type: 'image/bmp' };
            return {
              type: 'image/bmp',
              width: Math.abs(view.getInt32(18, true)),
              height: Math.abs(view.getInt32(22, true))
            };
          } catch (_) {
            return { type: 'image/bmp' };
          }
        }
        return undefined;
      }

      function headType(file) {
        try {
          var blob = typeof file.slice === 'function' ? file.slice(0, 32) : file;
          if (!blob || typeof blob.arrayBuffer !== 'function') return Promise.resolve(undefined);
          return Promise.resolve(blob.arrayBuffer()).then(function(buffer) {
            return sniffImageInfo(new Uint8Array(buffer));
          }, function(){ return undefined; });
        } catch (_) {
          return Promise.resolve(undefined);
        }
      }

      function fileNameFor(type, original) {
        var name = typeof original === 'string' ? original : '';
        var suffix = type === 'image/png' ? '.png'
          : type === 'image/jpeg' ? '.jpg'
          : type === 'image/gif' ? '.gif'
          : type === 'image/webp' ? '.webp'
          : '';
        if (!name) return suffix ? 'clipboard' + suffix : 'clipboard-image';
        if (!suffix) return name;
        return /\.(?:png|jpe?g|webp|gif|bmp|dib)$/i.test(name)
          ? name.replace(/\.(?:png|jpe?g|webp|gif|bmp|dib)$/i, suffix)
          : name;
      }

      function retypeFile(file, type) {
        return new window.File([file], fileNameFor(type, file && file.name), {
          type: type,
          lastModified: file && Number.isFinite(file.lastModified) ? file.lastModified : Date.now()
        });
      }

      function bitmapDecodeAllowed(file, info) {
        if (!file || !info) return false;
        if (!Number.isFinite(file.size) || file.size <= 0 || file.size > maxBitmapSourceBytes) return false;
        if (!Number.isFinite(info.width) || !Number.isFinite(info.height) || info.width <= 0 || info.height <= 0) return false;
        if (info.width > maxBitmapDimension || info.height > maxBitmapDimension) return false;
        return info.width * info.height <= maxBitmapPixels;
      }

      function bitmapToPng(file) {
        if (typeof window.createImageBitmap !== 'function') return Promise.reject(new Error('createImageBitmap unavailable'));
        return Promise.resolve(window.createImageBitmap(file)).then(function(bitmap) {
          return new Promise(function(resolve, reject) {
            var close = function() {
              try { if (bitmap && typeof bitmap.close === 'function') bitmap.close(); } catch (_) {}
            };
            try {
              var canvas = doc.createElement('canvas');
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
              var context = canvas.getContext && canvas.getContext('2d');
              if (!context || typeof context.drawImage !== 'function' || typeof canvas.toBlob !== 'function') {
                close();
                reject(new Error('canvas PNG conversion unavailable'));
                return;
              }
              context.drawImage(bitmap, 0, 0);
              canvas.toBlob(function(blob) {
                close();
                if (!blob) {
                  reject(new Error('canvas PNG conversion failed'));
                  return;
                }
                try {
                  var normalized = new window.File([blob], fileNameFor('image/png', file && file.name), {
                    type: 'image/png',
                    lastModified: file && Number.isFinite(file.lastModified) ? file.lastModified : Date.now()
                  });
                  normalizedBitmapFiles.add(normalized);
                  resolve(normalized);
                } catch (error) {
                  reject(error);
                }
              }, 'image/png');
            } catch (error) {
              close();
              reject(error);
            }
          });
        });
      }

      function normalizeFile(file) {
        return headType(file).then(function(info) {
          var detected = info && info.type;
          if (detected && supported[detected]) {
            return mediaType(file && file.type) === detected ? file : retypeFile(file, detected);
          }
          if (detected === 'image/bmp' && bitmapDecodeAllowed(file, info)) return bitmapToPng(file);
          return file;
        }, function(){ return file; });
      }

      function replayEvent(files, textEntries) {
        try {
          var transfer = new window.DataTransfer();
          if (!transfer.items || typeof transfer.items.add !== 'function') return null;
          files.forEach(function(file){ transfer.items.add(file); });
          textEntries.forEach(function(entry){ transfer.setData(entry[0], entry[1]); });
          var event = new window.ClipboardEvent('paste', {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true,
            composed: true
          });
          return event && event.clipboardData === transfer ? event : null;
        } catch (_) {
          return null;
        }
      }

      function dispatchReplay(target, preferred, fallback) {
        var event = preferred || fallback;
        if (!event || !target || typeof target.dispatchEvent !== 'function') return;
        replayed.add(event);
        try {
          target.dispatchEvent(event);
        } catch (_) {
          if (fallback && fallback !== event) {
            replayed.add(fallback);
            try { target.dispatchEvent(fallback); } catch (_) {}
          }
        }
      }

      function onPaste(event) {
        if (!event || replayed.has(event)) return;
        var target = composerEditable(event.target);
        if (!target) return;
        var data = event.clipboardData;
        if (!data || !data.items) return;
        var files = Array.from(data.items)
          .filter(function(item){ return item && item.kind === 'file'; })
          .map(function(item){ try { return item.getAsFile(); } catch (_) { return null; } })
          .filter(function(file){ return !!file; });
        if (!files.some(needsInspection) && !hasDedupeSignal(files)) return;

        // Snapshot every string flavor while the trusted paste event still owns
        // a readable clipboard data store. Build a known-good fallback replay
        // before canceling the original event so conversion failure never eats
        // the user's text or files.
        var textEntries = snapshotText(data);
        var fallback = replayEvent(files, textEntries);
        if (!fallback) return;

        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();

        Promise.all(files.map(function(file){
          return needsInspection(file)
            ? normalizeFile(file).catch(function(){ return file; })
            : Promise.resolve(file);
        })).then(function(normalized) {
          return dedupeBatch(normalized).then(function(deduped) {
            dispatchReplay(target, replayEvent(deduped, textEntries), fallback);
          });
        }, function() {
          dispatchReplay(target, fallback, null);
        });
      }

      doc.addEventListener('paste', onPaste, true);
      return function(){ doc.removeEventListener('paste', onPaste, true); };
    }, 'vision-router: clipboard image paste normalization');
  }

  // The composer chip chrome follows the shipped mode chips (ui-plan's PlanChip and the
  // access-mode trigger): 28px tall, token radius, no border, token hover fill, the shipped
  // focus ring, and the shipped "selected chip" treatment while Vision is on. The composer row
  // is a size container (InputBar .row), so the label collapses to the 14px glyph below the
  // shipped 460px cut — the same cut the access-mode trigger uses — instead of squeezing the
  // model trigger on narrow windows.
  var VISION_TOGGLE_CSS = '' +
    '.vr-vision-toggle{display:inline-flex;align-items:center;gap:4px;min-width:0;height:28px;' +
    'padding:0 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;' +
    'color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;' +
    'line-height:20px;cursor:pointer;white-space:nowrap}' +
    '.vr-vision-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}' +
    '.vr-vision-toggle:focus-visible{outline:var(--dsw-focus-ring-width) solid ' +
    'var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}' +
    '.vr-vision-toggle:disabled{cursor:default}' +
    // Dim only the states that read as "cannot be used right now". A disabled chip that is
    // merely waiting for this toggle's own selection keeps full opacity, so the composer does
    // not flash a greyed control while the model swap it owns is still settling.
    '.vr-vision-toggle[data-dimmed="true"]{opacity:.45}' +
    '.vr-vision-toggle[data-active="true"]{color:var(--dsw-alias-label-primary);' +
    'background:var(--dsw-alias-button-ghost-active-fill);' +
    'box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border)}' +
    '.vr-vision-toggle[data-active="true"]:hover:not(:disabled){' +
    'background:var(--dsw-alias-button-ghost-active-hover)}' +
    '.vr-vision-toggle-glyph{display:inline-flex;align-items:center;justify-content:center;' +
    'flex:0 0 auto;width:14px;height:14px;font-size:13px;line-height:1;color:currentColor}' +
    '.vr-vision-toggle-glyph-part{display:inline-flex;align-items:center;justify-content:center;' +
    'width:14px;height:14px}' +
    // The check carries the state only while the label is there to explain it. Once the label
    // collapses (the shipped 460px cut below) a bare check means nothing, so the Vision eye —
    // the only thing that still says what the chip does — stays, and the chip's selected chrome
    // marks on/off on its own.
    '.vr-vision-toggle-glyph-check{display:none}' +
    '@container (min-width:460.01px){' +
    '.vr-vision-toggle[data-active="true"] .vr-vision-toggle-glyph-eye{display:none}' +
    '.vr-vision-toggle[data-active="true"] .vr-vision-toggle-glyph-check{display:inline-flex}}' +
    '@container (max-width:460px){.vr-vision-toggle-label{display:none}}';

  function installVisionToggleStyles() {
    if (typeof document === 'undefined' || !document.head) return undefined;
    var tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-vision-router';
    tag.dataset.pluginCss = 'dsh-vision-router/mode-toggle';
    tag.textContent = VISION_TOGGLE_CSS;
    document.head.appendChild(tag);
    return function(){ tag.remove(); };
  }

  // A fresh presented image below the reader is the same as not being shown. Centre only that
  // card; visible cards and history on either side of a restored viewport stay untouched.
  function focusPresentedCard(node, viewportHeight) {
    if (!node || typeof node.getBoundingClientRect !== 'function') return false;
    var rect = node.getBoundingClientRect();
    if (rect.top <= viewportHeight) return false;
    var scroller = node.parentElement;
    var hops = 0;
    while (scroller && hops < 20) {
      var style = typeof getComputedStyle === 'function' ? getComputedStyle(scroller) : undefined;
      var scrollable = /(auto|scroll)/.test(String(style && style.overflowY)) &&
        scroller.scrollHeight > scroller.clientHeight + 4;
      if (scrollable) {
        var box = scroller.getBoundingClientRect();
        scroller.scrollTop += (rect.top - box.top) - (box.height / 2 - rect.height / 2);
        return true;
      }
      scroller = scroller.parentElement;
      hops += 1;
    }
    return false;
  }

  // New Hosts expose phase; supported DSH 0.1.5 instead marks settled blocks as
  // 'tool-result'. Normalize the [phase, block kind] tuple without raising the Host floor.
  function isPresentedResultState(state) {
    var phase = state && state[0];
    return phase !== undefined ? phase === 'result' : !!state && state[1] === 'tool-result';
  }

  // Restored history starts settled on both sides of the comparison. Only a live transition into
  // an image-bearing result is fresh presentation.
  function shouldFocusPresentedCard(previousState, state, imageCount) {
    return imageCount > 0 &&
      isPresentedResultState(state) &&
      !isPresentedResultState(previousState);
  }

  try {
    globalThis.__dvrPresentFocus = function (node, previousState, state, imageCount) {
      return shouldFocusPresentedCard(previousState, state, imageCount) &&
        focusPresentedCard(node, globalThis.innerHeight || 0);
    };
  } catch (_) {}

  function installVisionModeToggle(ctx, React, primitives) {
    if (!ctx || typeof ctx.inject !== 'function' || !React) return;
    var zh = {
      label: '识图',
      enable: '开启识图模式',
      disable: '关闭识图模式',
      unavailable: '当前模型没有对应的「+ 自动识图」版本',
      loading: '正在读取模型信息…',
      switching: '正在切换识图模式…',
      failed: '模型操作失败：{message}',
      failedUnknown: '未知错误'
    };
    var en = {
      label: 'Vision',
      enable: 'Enable Vision mode',
      disable: 'Disable Vision mode',
      unavailable: 'No matching “+ Auto Vision” model is available',
      loading: 'Loading model information…',
      switching: 'Switching Vision mode…',
      failed: 'Model action failed: {message}',
      failedUnknown: 'Unknown error'
    };

    try {
      ctx.effect(function(){ return ctx.locale.register(VISION_MODE_NS, { zh: zh, en: en }); }, 'vision-router: mode toggle locale');
    } catch (_) {}
    try {
      ctx.effect(function(){ return installVisionToggleStyles(); }, 'vision-router: mode toggle styles');
    } catch (_) {}

    function FallbackToast(props) {
      React.useEffect(function(){
        if (typeof setTimeout !== 'function') return undefined;
        var timer = setTimeout(props.onDone, 4000);
        return function(){ if (typeof clearTimeout === 'function') clearTimeout(timer); };
      }, [props.text]);
      return React.createElement('div', {
        role: 'alert',
        style: {
          position: 'fixed',
          top: 36,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 12000,
          maxWidth: 'min(760px, calc(100vw - 32px))',
          boxSizing: 'border-box',
          padding: '12px 16px',
          borderRadius: 12,
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-2)',
          color: 'var(--dsw-alias-label-primary)',
          boxShadow: '0 12px 40px #0005',
          fontSize: 13,
          lineHeight: 1.5
        }
      }, '⚠ ', props.text);
    }

    var ToastComponent = primitives && typeof primitives.Toast === 'function' ? primitives.Toast : FallbackToast;
    // The product icon set names weights, not sizes (IconWarningOutlineRegular); the old
    // "…16" spelling never existed, so the toast silently fell back to a text glyph.
    var WarningIcon = primitives && typeof primitives.IconWarningOutlineRegular === 'function'
      ? primitives.IconWarningOutlineRegular
      : primitives && typeof primitives.IconWarningOutline16 === 'function'
        ? primitives.IconWarningOutline16
        : undefined;

    var settings = bindVisionModeSettings(ctx);
    var unavailableSettingsState = { value: undefined };
    ctx.inject(['slots', 'modelDirectories', 'sessions', 'remote'], function(scope) {
      // Cold directoryFor calls use the caller's Cordis context, including its
      // remote.session declaration. Probe only once modelDirectories is ready;
      // older Hosts must not acquire a hard dependency on the alpha namespace.
      var session;
      try {
        session = typeof scope.get === 'function' ? scope.get('remote.session') : undefined;
      } catch (_) {}
      if (session) scope.inject(['remote.session'], installToggle);
      else installToggle(scope);
    });

    function installToggle(scope) {
      var models;
      try {
        models = scope.modelDirectories || (typeof scope.get === 'function' ? scope.get('modelDirectories') : undefined);
      } catch (_) {
        models = undefined;
      }
      if (!models || typeof models.directoryFor !== 'function') return;

      function fallbackTranslate(active) {
        return function(key, params) {
          var template = zh[key] || (active ? zh.disable : zh.enable);
          if (!params) return template;
          return template.replace(/\{(\w+)\}/g, function(match, name) {
            return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
          });
        };
      }

      function VisionModeToggle(props) {
        var directory = props.directory;
        var store = directory && directory.store;
        var fallbackState = { current: null, groups: [], status: 'idle', error: null };
        var state = React.useSyncExternalStore(
          store && typeof store.subscribe === 'function' ? function(listener){ return store.subscribe(listener); } : function(){ return function(){}; },
          store && typeof store.getSnapshot === 'function' ? function(){ return store.getSnapshot(); } : function(){ return fallbackState; }
        );
        var settingsState = React.useSyncExternalStore(
          settings && typeof settings.subscribe === 'function' ? function(listener){ return settings.subscribe(listener); } : function(){ return function(){}; },
          settings && typeof settings.getSnapshot === 'function'
            ? function(){ return settings.getSnapshot(); }
            : function(){ return unavailableSettingsState; }
        );
        var visionConfig = settingsState && settingsState.value && typeof settingsState.value === 'object'
          ? settingsState.value
          : {};
        // A Vision click may briefly drive this same Host directory through
        // selecting -> idle/loading while its projection is recomputed. Smooth
        // only that owned transaction: unrelated Host reloads (connection,
        // adapters, settings, credentials) must keep their loading authority.
        var usable = !!(state.current &&
          typeof state.current.provider === 'string' && state.current.provider !== '') &&
          Array.isArray(state.groups) && state.groups.length > 0;
        var settling = state.status === 'idle' || state.status === 'loading';
        var livePair = resolveVisionModePair(state.groups, state.current, visionConfig);
        var complete = usable && livePair.mode !== 'unavailable';
        var settledMode = React.useRef(null);
        var toggleTransition = React.useRef(null);
        // The Host may render a ready directory while the RPC that selected
        // it is still in flight. Keep only an in-flight transaction fence here,
        // never a second source of truth for Vision ON/OFF.
        var selectionTransaction = React.useRef(null);
        var refreshSelection = React.useState(0)[1];
        var selectionInFlight = !!(selectionTransaction.current &&
          selectionTransaction.current.directory === directory);
        if (settledMode.current && settledMode.current.directory !== directory) settledMode.current = null;
        if (toggleTransition.current && toggleTransition.current.directory !== directory) toggleTransition.current = null;
        if (complete) settledMode.current = { directory: directory, mode: livePair.mode };
        var transition = toggleTransition.current;
        if (transition && state.status === 'selecting') {
          var pending = state.pending;
          var matchesPending = !!(pending &&
            pending.provider === transition.target.provider &&
            pending.model === transition.target.model &&
            pending.reasoningEffort === transition.target.reasoningEffort);
          if (matchesPending) transition.seenSelecting = true;
          else toggleTransition.current = null;
        }
        transition = toggleTransition.current;
        var ownSettling = !!(transition && transition.seenSelecting && settling && settledMode.current);
        if (!ownSettling && transition && state.status !== 'selecting' &&
          (state.status === 'error' || state.status === 'ready')) {
          toggleTransition.current = null;
        }
        var pair = ownSettling ? { mode: settledMode.current.mode } : livePair;
        var active = pair.mode === 'on';
        var toastState = React.useState(null);
        var toast = toastState[0];
        var setToast = toastState[1];
        var busy = state.status === 'selecting' || selectionInFlight;
        var loading = settling;
        var removed = props.session && props.session.removed === true;
        var disabled = props.available !== true || removed || busy || loading || livePair.mode === 'unavailable';
        var t = typeof props.t === 'function' ? props.t : fallbackTranslate(active);
        var title = busy || ownSettling
          ? t('switching')
          : loading
            ? t('loading')
            : livePair.mode === 'unavailable'
              ? t('unavailable')
              : active ? t('disable') : t('enable');
        function announceRejectedSelection() {
          var latest;
          try {
            latest = store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : undefined;
          } catch (_) {
            latest = undefined;
          }
          var message = latest && typeof latest.error === 'string' && latest.error !== ''
            ? latest.error
            : t('failedUnknown');
          setToast(function(previous){
            return {
              seq: previous && Number.isFinite(previous.seq) ? previous.seq + 1 : 1,
              text: t('failed', { message: message })
            };
          });
        }

        var button = React.createElement('button', {
          type: 'button',
          'data-vision-router-mode-toggle': 'true',
          'aria-pressed': active,
          'aria-label': title,
          'aria-busy': busy || loading,
          title: title,
          disabled: disabled,
          className: 'vr-vision-toggle',
          'data-active': active ? 'true' : 'false',
          'data-dimmed': disabled && !ownSettling && (livePair.mode === 'unavailable' || loading) ? 'true' : 'false',
          onClick: function() {
            if (disabled || !pair.target || typeof props.select !== 'function' ||
              (selectionTransaction.current && selectionTransaction.current.directory === directory)) return;
            var target = pair.target;
            var ticket = { directory: directory, target: target };
            selectionTransaction.current = ticket;
            refreshSelection(function(revision){ return revision + 1; });
            toggleTransition.current = {
              directory: directory,
              target: target,
              seenSelecting: false
            };
            setToast(null);
            var pending;
            try { pending = props.select(target); }
            catch (error) { pending = Promise.reject(error); }
            void Promise.resolve(pending).then(function(accepted){
              if (selectionTransaction.current !== ticket) return;
              if (!accepted) {
                toggleTransition.current = null;
                announceRejectedSelection();
                return;
              }
              var latest;
              try { latest = store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : undefined; } catch (_) {}
              if (!latest || (latest.status !== 'selecting' && latest.status !== 'idle' && latest.status !== 'loading')) {
                toggleTransition.current = null;
              }
            }, function(error){
              if (selectionTransaction.current !== ticket) return;
              toggleTransition.current = null;
              announceRejectedSelection();
            }).finally(function(){
              if (selectionTransaction.current !== ticket) return;
              selectionTransaction.current = null;
              refreshSelection(function(revision){ return revision + 1; });
            });
          }
        },
          // One fixed 14px leading slot carries both glyphs: the Vision eye and the check that
          // marks the enabled state. The stylesheet shows the check only while the label is
          // present (the same 460px container cut that collapses the label), because a bare check
          // tells a reader nothing — once the label is gone the eye, which still says what the
          // chip does, stays. The slot is a fixed 14px box either way, so the chip width never
          // changes with the state.
          React.createElement('span', {
            'aria-hidden': 'true',
            className: 'vr-vision-toggle-glyph'
          },
          React.createElement('span', { className: 'vr-vision-toggle-glyph-part vr-vision-toggle-glyph-eye' }, '👁'),
          React.createElement('span', { className: 'vr-vision-toggle-glyph-part vr-vision-toggle-glyph-check' }, '✓')),
          React.createElement('span', { className: 'vr-vision-toggle-label' }, t('label'))
        );

        var toastNode = toast
          ? React.createElement(ToastComponent, {
              key: toast.seq,
              text: toast.text,
              icon: WarningIcon
                ? React.createElement(WarningIcon)
                : React.createElement('span', { 'aria-hidden': 'true' }, '⚠'),
              anchor: typeof document !== 'undefined'
                ? document.querySelector('[data-composer-card]')
                : null,
              onDone: function(){ setToast(null); }
            })
          : null;
        return React.createElement(React.Fragment, null, button, toastNode);
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
              return {
                directory: directory,
                available: available,
                select: function(selection) {
                  if (!available || !directory || typeof directory.select !== 'function') {
                    return Promise.resolve(false);
                  }
                  try {
                    return Promise.resolve(directory.select(selection)).then(
                      function(result){ return !result || result.ok !== false; },
                      function(){ return false; }
                    );
                  } catch (_) {
                    return Promise.resolve(false);
                  }
                }
              };
            }
          }, VisionModeToggle);
        });
      }, 'vision-router: composer vision mode toggle');
    }
  }

  function decorateVisionRouterPlugin(plugin, React, primitives) {
    if (!plugin || typeof plugin !== 'object' || typeof plugin.apply !== 'function') return plugin;
    if (plugin.apply.__visionRouterModeToggle) return plugin;
    var originalApply = plugin.apply;
    function apply(ctx) {
      var decoratedCtx = contextWithVisionModeCopy(ctx);
      var args = Array.prototype.slice.call(arguments);
      args[0] = decoratedCtx;
      var result = originalApply.apply(this, args);
      try {
        installClipboardImagePasteCompat(decoratedCtx);
      } catch (error) {
        try { console.warn('vision-router: failed to install clipboard image paste compatibility', error); } catch (_) {}
      }
      try {
        installVisionModeToggle(decoratedCtx, React, primitives);
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
              var primitives;
              try {
                primitives = require('@deepseek-ai/dsh-client-ui-primitives');
              } catch (_) {
                primitives = undefined;
              }
              var presentation = createPresentation(React);
              function scopedRequire(id) {
                if (id === LEGACY_ATTACHMENT_VALUE) return presentation;
                return require(id);
              }
              return decorateVisionRouterPlugin(factory(scopedRequire), React, primitives);
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
  return injectClientCarrierHtml(html, CLIENT_PRESENTATION_MARK, CLIENT_PRESENTATION_PRELUDE)
}

export function installClientPresentationBoundary(ctx) {
  installClientScriptCarriers(ctx, {
    marker: CLIENT_PRESENTATION_MARK,
    prelude: CLIENT_PRESENTATION_PRELUDE,
    label: 'vision-router: client presentation boundary',
    injectHtml: injectClientPresentationBoundary,
  })
}
