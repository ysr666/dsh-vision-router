import { htmlHasScriptMarker } from './html-script-marker.js'

const ROUTING_SETTINGS_PRELUDE_MARK = 'data-vision-router-routing-settings'

export const VISION_ROUTING_SETTINGS_PRELUDE = String.raw`(function(){
  'use strict';
  var MODULE_ID = 'dsh-vision-router';
  var CHAIN_ROOT = '#vr-vision-backend-chain';
  var PANEL_ATTR = 'data-vr-routing-settings-panel';
  var STYLE_ATTR = 'data-vr-routing-settings-style';
  var MODE_VALUES = ['ordered', 'auto'];
  var PREFERENCE_VALUES = ['balanced', 'quality', 'speed', 'local'];
  var BACKGROUND_VALUES = ['off', 'local-free', 'all'];
  var states = typeof WeakMap === 'function' ? new WeakMap() : undefined;

  function zh() {
    try {
      var lang = document && document.documentElement && document.documentElement.lang;
      return typeof lang === 'string' && lang.toLowerCase().startsWith('zh');
    } catch (_) { return true; }
  }
  function text(zhText, enText) { return zh() ? zhText : enText; }
  function allowed(value, values, fallback) { return values.indexOf(value) >= 0 ? value : fallback; }

  function installStyle() {
    if (typeof document === 'undefined' || !document.head || document.querySelector('[' + STYLE_ATTR + ']')) return;
    var style = document.createElement('style');
    style.setAttribute(STYLE_ATTR, '1');
    style.textContent =
      '.vr-routing-panel{margin:0 0 12px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3)}' +
      '.vr-routing-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}' +
      '.vr-routing-title{font-size:14px;font-weight:650;color:var(--dsw-alias-label-primary)}' +
      '.vr-routing-sub{margin:3px 0 0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary)}' +
      '.vr-routing-badge{flex:0 0 auto;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 8px;font-size:11px;color:var(--dsw-alias-label-secondary)}' +
      '.vr-routing-label{margin:10px 0 6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}' +
      '.vr-routing-segment{display:flex;flex-wrap:wrap;gap:6px}' +
      '.vr-routing-choice{font:inherit;font-size:12px;line-height:1.2;padding:7px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}' +
      '.vr-routing-choice[data-active="1"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}' +
      '.vr-routing-choice:disabled{opacity:.45;cursor:not-allowed}' +
      '.vr-routing-note{margin:8px 0 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}' +
      '.vr-routing-error{margin:8px 0 0;font-size:11px;color:var(--dsw-alias-label-error)}';
    document.head.appendChild(style);
  }

  function button(label, value, active, disabled, onClick) {
    var node = document.createElement('button');
    node.type = 'button';
    node.className = 'vr-routing-choice';
    node.dataset.active = active ? '1' : '0';
    node.dataset.value = value;
    node.disabled = disabled === true;
    node.textContent = label;
    node.addEventListener('click', onClick);
    return node;
  }

  function modeLabel(value) {
    return value === 'auto' ? text('自动选择', 'Auto select') : text('按设置顺序', 'Fixed order');
  }
  function preferenceLabel(value) {
    if (value === 'quality') return text('质量', 'Quality');
    if (value === 'speed') return text('速度', 'Speed');
    if (value === 'local') return text('本地', 'Local');
    return text('综合', 'Balanced');
  }
  function backgroundLabel(value) {
    if (value === 'all') return text('所有模型', 'All models');
    if (value === 'off') return text('关闭', 'Off');
    return text('仅免费/本地', 'Free/local only');
  }
  function snapshotOf(scope) {
    try { return scope && typeof scope.getSnapshot === 'function' ? scope.getSnapshot() : undefined; }
    catch (_) { return undefined; }
  }
  function settingsOf(state) {
    var snapshot = snapshotOf(state.scope);
    var value = snapshot && snapshot.value && typeof snapshot.value === 'object' ? snapshot.value : {};
    return {
      ready: !!snapshot && snapshot.status === 'ready',
      writable: !!snapshot && snapshot.status === 'ready' && snapshot.writable === true,
      mode: allowed(value.routingMode, MODE_VALUES, 'ordered'),
      preference: allowed(value.routingPreference, PREFERENCE_VALUES, 'balanced'),
      background: allowed(value.backgroundBenchmarking, BACKGROUND_VALUES, 'off')
    };
  }

  async function writeField(state, key, value) {
    if (state.saving) return;
    state.saving = key;
    state.error = '';
    render(state);
    try {
      if (typeof state.helpers.commitSettingsPlan === 'function') {
        var outcome = await state.helpers.commitSettingsPlan(
          state.scope,
          [{ key: key, run: { value: value } }],
          {}
        );
        if (!outcome || outcome.landed !== true) {
          var fields = outcome && Array.isArray(outcome.failures)
            ? outcome.failures.map(function(item){ return item && item.field; }).filter(Boolean).join(', ')
            : '';
          throw new Error(fields ? 'settings readback failed: ' + fields : 'settings readback failed');
        }
      } else if (state.scope && typeof state.scope.set === 'function') {
        await state.scope.set(key, value);
      } else {
        throw new Error('settings scope is unavailable');
      }
    } catch (error) {
      state.error = text('保存路由设置失败：', 'Failed to save routing setting: ') + String(error && error.message || error);
    } finally {
      state.saving = '';
      render(state);
    }
  }

  function render(state) {
    var panel = state.panel;
    if (!panel || panel.isConnected === false) return;
    var settings = settingsOf(state);
    panel.replaceChildren();
    panel.className = 'vr-routing-panel';

    var head = document.createElement('div');
    head.className = 'vr-routing-head';
    var textWrap = document.createElement('div');
    var title = document.createElement('div');
    title.className = 'vr-routing-title';
    title.textContent = text('模型选择方式', 'Model selection');
    var sub = document.createElement('p');
    sub.className = 'vr-routing-sub';
    sub.textContent = text(
      'Auto只使用已有实测数据；未测能力保持你的设置顺序。你可以手动测评，也可以选择在空闲时自动补充能力数据。',
      'Auto uses only existing measurements; unmeasured capabilities keep your configured order. Benchmark manually or optionally allow idle-time capability profiling.'
    );
    textWrap.appendChild(title);
    textWrap.appendChild(sub);
    var status = document.createElement('span');
    status.className = 'vr-routing-badge';
    status.textContent = settings.mode === 'auto'
      ? text('Auto · 执行已启用', 'Auto · execution active')
      : text('固定顺序', 'Fixed order');
    head.appendChild(textWrap);
    head.appendChild(status);
    panel.appendChild(head);

    var modeLabelNode = document.createElement('div');
    modeLabelNode.className = 'vr-routing-label';
    modeLabelNode.textContent = text('选择方式', 'Selection mode');
    panel.appendChild(modeLabelNode);
    var modeRow = document.createElement('div');
    modeRow.className = 'vr-routing-segment';
    MODE_VALUES.forEach(function(value) {
      modeRow.appendChild(button(
        modeLabel(value), value, settings.mode === value,
        !settings.writable || !!state.saving,
        function(){ if (settings.mode !== value) void writeField(state, 'routingMode', value); }
      ));
    });
    panel.appendChild(modeRow);

    var prefLabelNode = document.createElement('div');
    prefLabelNode.className = 'vr-routing-label';
    prefLabelNode.textContent = text('自动选择偏好', 'Auto selection preference');
    panel.appendChild(prefLabelNode);
    var prefRow = document.createElement('div');
    prefRow.className = 'vr-routing-segment';
    PREFERENCE_VALUES.forEach(function(value) {
      prefRow.appendChild(button(
        preferenceLabel(value), value, settings.preference === value,
        settings.mode !== 'auto' || !settings.writable || !!state.saving,
        function(){ if (settings.preference !== value) void writeField(state, 'routingPreference', value); }
      ));
    });
    panel.appendChild(prefRow);

    var backgroundLabelNode = document.createElement('div');
    backgroundLabelNode.className = 'vr-routing-label';
    backgroundLabelNode.textContent = text('后台补充能力数据', 'Background capability profiling');
    panel.appendChild(backgroundLabelNode);
    var backgroundRow = document.createElement('div');
    backgroundRow.className = 'vr-routing-segment';
    BACKGROUND_VALUES.forEach(function(value) {
      backgroundRow.appendChild(button(
        backgroundLabel(value), value, settings.background === value,
        !settings.writable || !!state.saving,
        function(){ if (settings.background !== value) void writeField(state, 'backgroundBenchmarking', value); }
      ));
    });
    panel.appendChild(backgroundRow);
    var backgroundNote = document.createElement('p');
    backgroundNote.className = 'vr-routing-note';
    backgroundNote.textContent = settings.background === 'all'
      ? text('Auto开启时会在空闲时补测所有已配置模型；云端API可能产生费用。真实识图任务开始时，后台测评会立即让路。', 'When Auto is enabled, idle-time profiling may benchmark all configured models; cloud APIs may incur charges. Background work yields when a real vision task starts.')
      : settings.background === 'off'
        ? text('自动补测已关闭；未测模型仍按你的设置顺序执行，你仍可随时手动测评。', 'Automatic profiling is off. Unmeasured models keep your configured order, and manual benchmarks remain available.')
        : text('Auto开启时仅在空闲时补测本地或免费后端，不会自动消耗收费云API额度。真实识图任务开始时会立即让路。', 'When Auto is enabled, only local/free backends are profiled while idle, so paid cloud API credits are not spent automatically. Real vision work always takes priority.');
    panel.appendChild(backgroundNote);

    if (!settings.ready) {
      var loading = document.createElement('p');
      loading.className = 'vr-routing-note';
      loading.textContent = text('路由设置正在加载…', 'Routing settings are loading…');
      panel.appendChild(loading);
    } else if (!settings.writable) {
      var readonly = document.createElement('p');
      readonly.className = 'vr-routing-note';
      readonly.textContent = text('当前设置提供方只读。', 'The active settings provider is read-only.');
      panel.appendChild(readonly);
    }

    if (state.error) {
      var error = document.createElement('p');
      error.className = 'vr-routing-error';
      error.textContent = state.error;
      panel.appendChild(error);
    }
  }

  function ensurePanel(state) {
    if (typeof document === 'undefined') return;
    var chain = document.querySelector(CHAIN_ROOT);
    if (!chain) return;
    var panel = chain.querySelector('[' + PANEL_ATTR + ']');
    if (!panel) {
      panel = document.createElement('div');
      panel.setAttribute(PANEL_ATTR, '1');
      chain.insertBefore(panel, chain.firstChild);
    }
    state.panel = panel;
    render(state);
  }

  function installRoutingSettings(ctx, helpers) {
    if (!ctx || typeof ctx !== 'object' || typeof document === 'undefined') return;
    if (states && states.has(ctx)) return;
    installStyle();
    var getConnection = function() {
      try { return ctx.get && ctx.get('connection'); } catch (_) { return undefined; }
    };
    var remote = false;
    try {
      remote = typeof helpers.shouldUseRemoteSettings === 'function'
        ? helpers.shouldUseRemoteSettings(getConnection)
        : false;
    } catch (_) { remote = false; }
    var scope = remote && typeof helpers.createRemoteSettingsScope === 'function'
      ? helpers.createRemoteSettingsScope(getConnection)
      : ctx.settingsScope.bind({ namespace: 'vision-router' });
    var state = {
      ctx: ctx,
      helpers: helpers,
      scope: scope,
      remote: remote,
      panel: undefined,
      saving: '',
      error: '',
      disposed: false,
      scanTimer: undefined,
      unsubscribe: undefined,
      observer: undefined,
      remoteDisposers: []
    };
    if (states) states.set(ctx, state);

    function schedule() {
      if (state.disposed || state.scanTimer !== undefined) return;
      state.scanTimer = setTimeout(function() {
        state.scanTimer = undefined;
        ensurePanel(state);
      }, 40);
    }
    function reloadRemote() {
      if (!remote || !scope || typeof scope.reload !== 'function') return;
      void scope.reload().catch(function(){});
    }
    try {
      state.unsubscribe = scope && typeof scope.subscribe === 'function' ? scope.subscribe(function(){
        schedule();
      }) : undefined;
      if (scope && typeof scope.load === 'function') void scope.load().then(schedule).catch(schedule);
      if (remote && ctx && typeof ctx.on === 'function') {
        var stopReset = ctx.on('connection/reset', reloadRemote);
        if (typeof stopReset === 'function') state.remoteDisposers.push(stopReset);
      }
      if (remote && ctx.remote && typeof ctx.remote.$on === 'function') {
        var stopSettings = ctx.remote.$on('settings/document-updated', function(namespace) {
          if (namespace === undefined || namespace === 'vision-router') reloadRemote();
        });
        if (typeof stopSettings === 'function') state.remoteDisposers.push(stopSettings);
      }
    } catch (_) {}
    if (typeof MutationObserver === 'function' && document.documentElement) {
      state.observer = new MutationObserver(function() {
        // React may rebuild the chain container. Reinstall only when our panel
        // was actually detached; never schedule from mutations caused by our
        // own render()/replaceChildren(), which would create a self-refresh loop.
        if (!state.panel || state.panel.isConnected === false) schedule();
      });
      state.observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    schedule();

    var dispose = function() {
      state.disposed = true;
      if (state.scanTimer !== undefined) clearTimeout(state.scanTimer);
      if (state.observer) state.observer.disconnect();
      if (typeof state.unsubscribe === 'function') state.unsubscribe();
      state.remoteDisposers.forEach(function(disposeRemote) {
        try { disposeRemote(); } catch (_) {}
      });
      state.remoteDisposers.length = 0;
      if (remote && scope && typeof scope.dispose === 'function') void scope.dispose();
      if (state.panel && state.panel.parentNode) state.panel.parentNode.removeChild(state.panel);
      if (states) states.delete(ctx);
    };
    try {
      if (typeof ctx.effect === 'function') ctx.effect(function(){ return dispose; }, 'vision-router: routing settings product panel');
    } catch (_) {}
  }

  function patchLoader(loader) {
    if (!loader || (typeof loader !== 'object' && typeof loader !== 'function')) return;
    if (typeof loader.load === 'function' && !loader.load.__visionRouterRoutingSettings) {
      var original = loader.load;
      function load(spec) {
        if (spec && spec.id === MODULE_ID && typeof spec.factory === 'function') {
          var factory = spec.factory;
          spec = Object.assign({}, spec, {
            factory: function(require) {
              var exports = factory(require);
              if (exports && typeof exports.apply === 'function' && !exports.apply.__visionRouterRoutingSettings) {
                var apply = exports.apply;
                var wrappedApply = function(ctx) {
                  var rest = Array.prototype.slice.call(arguments, 1);
                  var result = apply.apply(exports, [ctx].concat(rest));
                  try { installRoutingSettings(ctx, exports); } catch (_) {}
                  return result;
                };
                Object.defineProperty(wrappedApply, '__visionRouterRoutingSettings', { value: true });
                exports.apply = wrappedApply;
              }
              return exports;
            }
          });
        }
        return original.call(loader, spec);
      }
      Object.defineProperty(load, '__visionRouterRoutingSettings', { value: true });
      loader.load = load;
    }
    if (typeof loader.create === 'function' && !loader.create.__visionRouterRoutingSettings) {
      var originalCreate = loader.create;
      function create() {
        var result = originalCreate.apply(this, arguments);
        patchLoader(loader);
        return result;
      }
      Object.defineProperty(create, '__visionRouterRoutingSettings', { value: true });
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

  try { install(); } catch (_) {}
})();`

export function injectVisionRoutingSettingsPrelude(html) {
  if (typeof html !== 'string' || htmlHasScriptMarker(html, ROUTING_SETTINGS_PRELUDE_MARK)) return html
  const script = `<script ${ROUTING_SETTINGS_PRELUDE_MARK}>${VISION_ROUTING_SETTINGS_PRELUDE.replace(/<\/script/gi, '<\\/script')}</script>`
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installVisionRoutingSettingsPrelude(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectVisionRoutingSettingsPrelude),
      'vision-router: v2 routing settings product panel',
    )
  })
}
