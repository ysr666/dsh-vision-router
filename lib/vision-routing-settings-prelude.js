const ROUTING_SETTINGS_PRELUDE_MARK = 'data-vision-router-routing-settings'

export const VISION_ROUTING_SETTINGS_PRELUDE = String.raw`(function(){
  'use strict';
  var MODULE_ID = 'dsh-vision-router';
  var CHAIN_ROOT = '#vr-vision-backend-chain';
  var PANEL_ATTR = 'data-vr-routing-settings-panel';
  var STYLE_ATTR = 'data-vr-routing-settings-style';
  var PREVIEW_ENDPOINT = '/_dsh/vision-router/routing-preview';
  var MODE_VALUES = ['ordered', 'auto'];
  var PREFERENCE_VALUES = ['balanced', 'quality', 'speed', 'local'];
  var BACKGROUND_VALUES = ['local-free', 'all', 'off'];
  var states = typeof WeakMap === 'function' ? new WeakMap() : undefined;

  function zh() {
    try {
      var lang = document && document.documentElement && document.documentElement.lang;
      return typeof lang === 'string' && lang.toLowerCase().startsWith('zh');
    } catch (_) { return true; }
  }
  function text(zhText, enText) { return zh() ? zhText : enText; }
  function allowed(value, values, fallback) { return values.indexOf(value) >= 0 ? value : fallback; }
  function compactKey(value) {
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }

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
      '.vr-routing-preview{margin-top:12px;padding:10px 11px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}' +
      '.vr-routing-preview-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}' +
      '.vr-routing-preview-title{font-size:12px;font-weight:650;color:var(--dsw-alias-label-primary)}' +
      '.vr-routing-preview-row{display:grid;grid-template-columns:minmax(66px,.7fr) minmax(0,1.8fr) auto;gap:8px;align-items:center;padding:5px 0;border-top:1px solid var(--dsw-alias-border-l2);font-size:12px}' +
      '.vr-routing-preview-row:first-of-type{border-top:0}' +
      '.vr-routing-intent{color:var(--dsw-alias-label-secondary)}' +
      '.vr-routing-backend{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}' +
      '.vr-routing-reason{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}' +
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
    if (value === 'all') return text('所有已配置模型', 'All configured models');
    if (value === 'off') return text('关闭', 'Off');
    return text('仅免费/本地', 'Free/local only');
  }
  function intentLabel(value) {
    if (value === 'structured') return text('结构化', 'Structured');
    if (value === 'ocr') return 'OCR';
    if (value === 'document') return text('文档', 'Document');
    if (value === 'grounding') return text('定位', 'Grounding');
    return text('通用', 'General');
  }
  function reasonLabel(value) {
    if (value === 'measured-advantage') return text('实测领先', 'Measured lead');
    if (value === 'local-preference') return text('本地优先', 'Local first');
    if (value === 'insufficient-comparable-evidence') return text('证据不足，保持顺序', 'Keep order');
    return text('保持顺序', 'Keep order');
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
      background: allowed(value.backgroundBenchmarking, BACKGROUND_VALUES, 'local-free'),
      providers: Array.isArray(value.providers) ? value.providers : [],
      revision: snapshot && snapshot.revision
    };
  }

  function previewSettingsKey(settings) {
    return compactKey([settings.mode, settings.preference, settings.background, settings.providers, settings.revision]);
  }

  async function refreshPreview(state, force) {
    var settings = settingsOf(state);
    var key = previewSettingsKey(settings);
    if (!force && state.previewKey === key && (state.preview || state.previewLoading)) return;
    state.previewKey = key;
    state.previewLoading = true;
    render(state);
    try {
      var response = await fetch(PREVIEW_ENDPOINT, {
        method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store'
      });
      var body = await response.json().catch(function(){ return undefined; });
      if (!response.ok || !body || body.ok !== true || !Array.isArray(body.previews)) {
        throw new Error(body && body.error ? String(body.error) : 'HTTP ' + response.status);
      }
      state.preview = body;
      state.error = '';
    } catch (error) {
      state.preview = undefined;
      state.error = text('Auto选择预览暂不可用：', 'Auto preview unavailable: ') + String(error && error.message || error);
    } finally {
      state.previewLoading = false;
      render(state);
    }
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
      state.previewKey = '';
      await refreshPreview(state, true);
    } catch (error) {
      state.error = text('保存路由设置失败：', 'Failed to save routing setting: ') + String(error && error.message || error);
    } finally {
      state.saving = '';
      render(state);
    }
  }

  function buildPreview(state, settings) {
    var wrap = document.createElement('div');
    wrap.className = 'vr-routing-preview';
    var head = document.createElement('div');
    head.className = 'vr-routing-preview-head';
    var title = document.createElement('div');
    title.className = 'vr-routing-preview-title';
    title.textContent = settings.mode === 'auto'
      ? text('Auto选择预览', 'Auto selection preview')
      : text('Auto选择预览（若开启）', 'Auto selection preview (if enabled)');
    var count = document.createElement('span');
    count.className = 'vr-routing-badge';
    var measured = state.preview && Array.isArray(state.preview.freshMeasuredBackends)
      ? state.preview.freshMeasuredBackends.length : 0;
    count.textContent = text('新鲜实测 ' + measured, measured + ' fresh measured');
    head.appendChild(title);
    head.appendChild(count);
    wrap.appendChild(head);

    if (state.previewLoading && !state.preview) {
      var loading = document.createElement('div');
      loading.className = 'vr-routing-note';
      loading.textContent = text('正在计算预览…', 'Calculating preview…');
      wrap.appendChild(loading);
      return wrap;
    }

    var previews = state.preview && Array.isArray(state.preview.previews) ? state.preview.previews : [];
    if (previews.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'vr-routing-note';
      empty.textContent = text('暂无可用预览。', 'No preview available yet.');
      wrap.appendChild(empty);
      return wrap;
    }

    previews.forEach(function(item) {
      var row = document.createElement('div');
      row.className = 'vr-routing-preview-row';
      var intent = document.createElement('span');
      intent.className = 'vr-routing-intent';
      intent.textContent = intentLabel(item.intent);
      var backend = document.createElement('span');
      backend.className = 'vr-routing-backend';
      backend.title = item.first || '';
      backend.textContent = item.first || text('无候选', 'No candidate');
      var reason = document.createElement('span');
      reason.className = 'vr-routing-reason';
      reason.textContent = reasonLabel(item.reason);
      row.appendChild(intent);
      row.appendChild(backend);
      row.appendChild(reason);
      wrap.appendChild(row);
    });

    var note = document.createElement('p');
    note.className = 'vr-routing-note';
    note.textContent = text(
      '只使用7天内的直接Benchmark结果；未测或不可直接比较时保持你的设置顺序。当前2.0 Draft只显示预览，不会改变实际识图执行顺序。',
      'Uses direct Benchmark results from the last 7 days only. Unmeasured or incomparable routes keep your configured order. This 2.0 Draft is preview-only and does not change actual vision execution.'
    );
    wrap.appendChild(note);
    return wrap;
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
      '设置顺序始终是基础；自动选择会在后台渐进建立能力数据，未测能力仍保持你的设置顺序。',
      'Configured order remains the baseline. Auto select progressively builds measurements in the background; unmeasured abilities still keep your configured order.'
    );
    textWrap.appendChild(title);
    textWrap.appendChild(sub);
    var status = document.createElement('span');
    status.className = 'vr-routing-badge';
    status.textContent = settings.mode === 'auto'
      ? text('Auto · 预览阶段', 'Auto · preview')
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
    backgroundLabelNode.textContent = text('后台能力测评', 'Background capability profiling');
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
      ? text('已允许对所有已配置模型后台补测；云端API可能产生费用。真实识图任务开始时，后台测评会立即让路。', 'Background profiling is allowed for all configured models; cloud APIs may incur charges. Background work yields when a real vision task starts.')
      : settings.background === 'off'
        ? text('后台测评已关闭；你仍可手动测评任意模型。', 'Background profiling is off; manual benchmarks remain available.')
        : text('默认只在空闲时测本地或免费后端，不会自动消耗收费云API额度。真实识图任务开始时会立即让路。', 'Default: only local/free backends are profiled while idle, so paid cloud API credits are not spent automatically. Real vision work always takes priority.');
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

    panel.appendChild(buildPreview(state, settings));
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
    void refreshPreview(state, false);
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
      preview: undefined,
      previewKey: '',
      previewLoading: false,
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
        state.previewKey = '';
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
  if (typeof html !== 'string' || html.includes(ROUTING_SETTINGS_PRELUDE_MARK)) return html
  const script = `<script ${ROUTING_SETTINGS_PRELUDE_MARK}>${VISION_ROUTING_SETTINGS_PRELUDE.replace(/<\/script/gi, '<\\/script')}</script>`
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installVisionRoutingSettingsPrelude(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectVisionRoutingSettingsPrelude),
      'vision-router: routing mode settings client prelude',
    )
  })
}