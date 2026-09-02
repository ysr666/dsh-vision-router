import { htmlHasScriptMarker } from './html-script-marker.js'

const CLIENT_PRELUDE_MARK = 'data-vision-router-live-models'

/**
 * Browser prelude injected ahead of the DSH shell. It wraps only the
 * dsh-vision-router client factory, leaving the global llm.models contract and
 * every other client untouched. This avoids teaching the main chat model
 * picker about endpoint-discovered IDs that are intentionally executable only
 * through Vision Router's isolated compatibility path.
 */
export const LIVE_MODEL_CLIENT_PRELUDE = String.raw`(function(){
  'use strict';
  var ENDPOINT = '/_dsh/vision-router/live-models';
  var SETTINGS_SECTION_ID = 'vision-router';
  var SETTINGS_EXTENSION_ORDER_BASE = 1000000;
  var MANUAL_MODEL_ID = '__vision_router_manual_model__';
  var MANUAL_MODEL_LABEL = '手动输入模型 ID… / Enter model ID…';
  var contexts = typeof WeakMap === 'function' ? new WeakMap() : undefined;
  var manualModels = new Map();
  var manualNotifiers = new Set();
  var manualPickerInstalled = false;

  function stableIdHash(value) {
    var text = String(value || '');
    var hash = 2166136261;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash >>> 0;
  }

  function settingsSectionOrder(slots, id) {
    // Keep third-party settings in a dedicated high-order band, after DSH's
    // built-in General / Models / Plugins / Agent Presets rows. The full
    // stable 32-bit plugin-id hash makes an accidental same-order tie between
    // independent plugins extremely unlikely. If an already-registered plugin
    // still occupies that exact value, walk forward deterministically until a
    // free order is found. DSH currently sorts settings rows by numeric order
    // only, so this is the strongest conflict avoidance available to a plugin.
    var order = SETTINGS_EXTENSION_ORDER_BASE + stableIdHash(id);
    try {
      if (!slots || typeof slots.entries !== 'function') return order;
      var used = new Set();
      var entries = slots.entries('settings.section');
      if (entries && typeof entries[Symbol.iterator] === 'function') {
        Array.from(entries).forEach(function(entry) {
          var options = entry && entry.options;
          if (!options || options.id === id || !Number.isFinite(options.order)) return;
          used.add(options.order);
        });
      }
      while (used.has(order)) order += 1;
    } catch (_) {}
    return order;
  }

  function cleanProviders(snapshot) {
    return snapshot && snapshot.ok === true && Array.isArray(snapshot.providers) ? snapshot.providers : [];
  }

  function rpcValue(body) {
    if (body && typeof body === 'object' && body.result && typeof body.result === 'object') {
      return body.result.ok === true ? body.result.value : undefined;
    }
    return body;
  }

  function replaceCatalogValue(body, value) {
    if (body && typeof body === 'object' && body.result && typeof body.result === 'object') {
      return Object.assign({}, body, { result: Object.assign({}, body.result, { value: value }) });
    }
    return value;
  }

  function activeProviderDirectory(body) {
    var value = rpcValue(body);
    var rows = value && Array.isArray(value.providers) ? value.providers : [];
    return rows.filter(function(entry) {
      return entry && entry.active === true && typeof entry.provider === 'string' && entry.provider !== '';
    });
  }

  function manualModelsFor(provider) {
    var values = manualModels.get(provider);
    if (!values || values.size === 0) return [];
    return Array.from(values).map(function(id) {
      return { provider: provider, id: id, name: id, visionRouterManualModel: true };
    });
  }

  function rememberManualModel(provider, model) {
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string') return false;
    var id = model.trim();
    if (id === '' || id === MANUAL_MODEL_ID) return false;
    var values = manualModels.get(provider);
    if (!values) {
      values = new Set();
      manualModels.set(provider, values);
    }
    var size = values.size;
    values.add(id);
    return values.size !== size;
  }

  function notifyManualCatalogChanged() {
    manualNotifiers.forEach(function(notify) {
      try { notify(); } catch (_) {}
    });
  }

  function promptText() {
    try {
      var lang = document && document.documentElement && document.documentElement.lang;
      if (typeof lang === 'string' && lang.toLowerCase().startsWith('zh')) return '请输入模型 ID';
    } catch (_) {}
    return 'Enter model ID / 请输入模型 ID';
  }

  function installManualModelPicker() {
    if (manualPickerInstalled || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    manualPickerInstalled = true;
    document.addEventListener('change', function(event) {
      var select = event && event.target;
      if (!select || String(select.tagName || '').toUpperCase() !== 'SELECT' || select.value !== MANUAL_MODEL_ID) return;
      var row = typeof select.closest === 'function' ? select.closest('.vr-chain-row') : undefined;
      var selects = row && typeof row.querySelectorAll === 'function' ? row.querySelectorAll('select') : undefined;
      var provider = selects && selects[0] && typeof selects[0].value === 'string' ? selects[0].value.trim() : '';
      if (!provider) return;
      var entered = typeof window.prompt === 'function' ? window.prompt(promptText(), '') : '';
      var model = typeof entered === 'string' ? entered.trim() : '';
      if (!model || model === MANUAL_MODEL_ID) {
        try { event.preventDefault(); } catch (_) {}
        try { event.stopImmediatePropagation(); } catch (_) {}
        select.value = '';
        return;
      }
      rememberManualModel(provider, model);
      // React's handler runs after this capture listener. Add the entered value
      // to the live DOM select so event.target.value is the real model id, not
      // the synthetic manual-entry sentinel.
      try {
        var option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        var sentinel = typeof select.querySelector === 'function'
          ? select.querySelector('option[value="' + MANUAL_MODEL_ID + '"]')
          : undefined;
        if (sentinel && typeof select.insertBefore === 'function') select.insertBefore(option, sentinel);
        else if (typeof select.appendChild === 'function') select.appendChild(option);
        select.value = model;
      } catch (_) {}
      // Re-fetch after React records the draft. The next catalog includes this
      // manual id, so the controlled selector remains stable on re-render.
      setTimeout(notifyManualCatalogChanged, 0);
    }, true);
  }

  function mergeCatalog(body, snapshot, providerDirectoryBody) {
    var value = rpcValue(body);
    if (!value || typeof value !== 'object') return body;
    var originalGroups = Array.isArray(value.groups) ? value.groups : [];
    var groups = originalGroups.map(function(group) {
      if (!group || typeof group !== 'object') return group;
      return Object.assign({}, group, { models: Array.isArray(group.models) ? group.models.slice() : [] });
    });
    var groupByProvider = new Map();
    var hasEnumeratedModels = new Set();
    groups.forEach(function(group) {
      if (!group || typeof group.id !== 'string' || !group.id) return;
      groupByProvider.set(group.id, group);
      if (Array.isArray(group.models) && group.models.length > 0) hasEnumeratedModels.add(group.id);
    });

    var liveEntries = cleanProviders(snapshot);
    liveEntries.forEach(function(live) {
      if (!live || typeof live.provider !== 'string' || !live.provider || !Array.isArray(live.models)) return;
      var group = groupByProvider.get(live.provider);
      if (!group) {
        group = { id: live.provider, name: live.provider, models: [] };
        groupByProvider.set(live.provider, group);
        groups.push(group);
      }
      var seen = new Set((Array.isArray(group.models) ? group.models : []).map(function(model){ return model && model.id; }).filter(Boolean));
      live.models.forEach(function(model) {
        if (!model || typeof model.id !== 'string' || !model.id || seen.has(model.id)) return;
        seen.add(model.id);
        group.models.push({
          provider: live.provider,
          id: model.id,
          name: typeof model.name === 'string' && model.name ? model.name : model.id,
          visionRouterLiveDiscovered: true
        });
      });
      if (live.models.length > 0) hasEnumeratedModels.add(live.provider);
    });

    activeProviderDirectory(providerDirectoryBody).forEach(function(entry) {
      var provider = entry.provider;
      var group = groupByProvider.get(provider);
      if (!group) {
        group = {
          id: provider,
          name: typeof entry.displayName === 'string' && entry.displayName ? entry.displayName : provider,
          models: [],
          visionRouterProviderDirectory: true
        };
        groupByProvider.set(provider, group);
        groups.push(group);
      } else if ((!group.name || group.name === group.id) && typeof entry.displayName === 'string' && entry.displayName) {
        group.name = entry.displayName;
      }

      var seen = new Set((Array.isArray(group.models) ? group.models : []).map(function(model){ return model && model.id; }).filter(Boolean));
      manualModelsFor(provider).forEach(function(model) {
        if (seen.has(model.id)) return;
        seen.add(model.id);
        group.models.push(model);
      });

      // Provider presence and model enumeration are separate DSH contracts.
      // Keep an active provider selectable even when llm.models failed to list
      // its models. The sentinel opens a manual-id prompt; it is never intended
      // to be persisted or executed as a model id itself.
      if (!hasEnumeratedModels.has(provider) && !seen.has(MANUAL_MODEL_ID)) {
        group.models.push({
          provider: provider,
          id: MANUAL_MODEL_ID,
          name: MANUAL_MODEL_LABEL,
          visionRouterManualEntry: true
        });
      }
    });

    return replaceCatalogValue(body, Object.assign({}, value, { groups: groups }));
  }

  function createLiveClient() {
    var listeners = new Set();
    var snapshot;
    var inFlight;
    var pollTimer;
    var disposed = false;
    var pollBudget = 0;
    // Endpoint discovery updates refreshing on every queue/poll transition.
    // Treat those as transport progress, not catalog invalidations. Otherwise
    // the settings card receives a synthetic llm/adapters-updated event every
    // ~400ms, clears both model/capability state, and the dropdown visibly
    // jumps between loading/ready while the user is trying to select a model.
    // Accumulate real snapshot changes and publish exactly once when the batch
    // settles with refreshing === false.
    var pendingEmit = false;

    function emit() {
      listeners.forEach(function(listener) { try { listener(); } catch (_) {} });
    }
    manualNotifiers.add(emit);

    function sameSnapshot(left, right) {
      if (!left || !right) return left === right;
      // refreshing is deliberately ignored: it is progress state, not model
      // membership. Version/discoveredAt change only when usable catalog data
      // changes and therefore are the correct invalidation evidence.
      if (left.version !== right.version) return false;
      var a = cleanProviders(left);
      var b = cleanProviders(right);
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) {
        if (a[i].provider !== b[i].provider || a[i].discoveredAt !== b[i].discoveredAt) return false;
      }
      return true;
    }

    function schedulePoll() {
      if (disposed || pollTimer !== undefined) return;
      if (pollBudget <= 0) pollBudget = 30;
      if (pollBudget-- <= 0) return;
      pollTimer = setTimeout(function() {
        pollTimer = undefined;
        void refresh(false);
      }, 400);
    }

    async function refresh(requestRefresh) {
      if (disposed || typeof fetch !== 'function') return snapshot;
      if (inFlight) return inFlight;
      inFlight = (async function() {
        try {
          var controller = typeof AbortController === 'function' ? new AbortController() : undefined;
          var timer = controller ? setTimeout(function(){ controller.abort(); }, 1200) : undefined;
          var response;
          try {
            response = await fetch(ENDPOINT + '?refresh=' + (requestRefresh === false ? '0' : '1'), {
              method: 'GET',
              headers: { accept: 'application/json' },
              signal: controller && controller.signal
            });
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
          if (!response || !response.ok) return snapshot;
          var next = await response.json();
          if (!next || next.ok !== true) return snapshot;
          var changed = !sameSnapshot(snapshot, next);
          snapshot = next;
          if (changed) pendingEmit = true;
          if (next.refreshing) {
            schedulePoll();
          } else {
            pollBudget = 0;
            if (pendingEmit) {
              pendingEmit = false;
              emit();
            }
          }
          return snapshot;
        } catch (_) {
          return snapshot;
        } finally {
          inFlight = undefined;
        }
      })();
      return inFlight;
    }

    return {
      augment: function(body, providerDirectoryBody) {
        void refresh(true);
        return mergeCatalog(body, snapshot, providerDirectoryBody);
      },
      refresh: refresh,
      subscribe: function(listener) {
        if (typeof listener !== 'function') return function(){};
        listeners.add(listener);
        return function(){ listeners.delete(listener); };
      },
      dispose: function() {
        disposed = true;
        manualNotifiers.delete(emit);
        pendingEmit = false;
        if (pollTimer !== undefined) clearTimeout(pollTimer);
        pollTimer = undefined;
        listeners.clear();
      }
    };
  }

  function wrapRemote(remote, live) {
    if (!remote || (typeof remote !== 'object' && typeof remote !== 'function')) return remote;
    return new Proxy(remote, {
      get: function(target, property) {
        if (property === '$on') {
          var on = Reflect.get(target, property, target);
          if (typeof on !== 'function') return on;
          return function(event, listener) {
            var rest = Array.prototype.slice.call(arguments, 2);
            var disposeRemote = on.apply(target, [event, listener].concat(rest));
            var disposeLive = event === 'llm/adapters-updated' ? live.subscribe(listener) : function(){};
            return function() {
              try { if (typeof disposeRemote === 'function') disposeRemote(); } catch (_) {}
              try { disposeLive(); } catch (_) {}
            };
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  function wrapConnection(connection, live) {
    if (!connection || (typeof connection !== 'object' && typeof connection !== 'function')) return connection;
    var api = connection.api;
    var llm = api && api.llm;
    var models = llm && llm.models;
    var providers = llm && llm.providers;
    if (typeof models !== 'function') return connection;
    var wrappedLlm = new Proxy(llm, {
      get: function(target, property) {
        if (property === 'models') {
          return async function() {
            var args = arguments;
            var providerDirectoryPromise = typeof providers === 'function'
              ? Promise.resolve().then(function(){ return providers.call(target, {}); }).catch(function(){ return undefined; })
              : Promise.resolve(undefined);
            var results = await Promise.all([
              models.apply(target, args),
              providerDirectoryPromise
            ]);
            return live.augment(results[0], results[1]);
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    var wrappedApi = new Proxy(api, {
      get: function(target, property) {
        if (property === 'llm') return wrappedLlm;
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    return new Proxy(connection, {
      get: function(target, property) {
        if (property === 'api') return wrappedApi;
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  function patchVisionRouterCopy(namespace, dictionaries) {
    if (namespace !== 'vision-router' || !dictionaries || typeof dictionaries !== 'object') return dictionaries;
    var next = Object.assign({}, dictionaries);
    if (next.zh && typeof next.zh === 'object') {
      next.zh = Object.assign({}, next.zh, {
        catalogPartialFailure: '部分已配置供应商的模型目录加载失败：{detail}。供应商仍会保留在识图设置中；若无法枚举模型，可选择“手动输入模型 ID”。',
        chainHint: '请先在「设置 → 模型」中配置可用模型，再回到这里选择 Vision Router 用来读取图片的模型。将按从上到下的顺序尝试，失败时自动切换到下一个。',
      });
    }
    if (next.en && typeof next.en === 'object') {
      next.en = Object.assign({}, next.en, {
        catalogPartialFailure: 'Some configured providers failed to load their model catalog: {detail}. The provider stays available in Vision Router; choose “Enter model ID” when its models cannot be enumerated.',
        chainHint: 'Configure the model first in Settings → Models, then return here to choose which models Vision Router uses to read images. They are tried from top to bottom, with automatic failover.',
      });
    }
    return next;
  }

  function wrapLocale(locale) {
    if (!locale || (typeof locale !== 'object' && typeof locale !== 'function')) return locale;
    return new Proxy(locale, {
      get: function(target, property) {
        if (property === 'register') {
          var register = Reflect.get(target, property, target);
          if (typeof register !== 'function') return register;
          return function(namespace, dictionaries) {
            var rest = Array.prototype.slice.call(arguments, 2);
            return register.apply(target, [namespace, patchVisionRouterCopy(namespace, dictionaries)].concat(rest));
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  function wrapSlots(slots) {
    if (!slots || (typeof slots !== 'object' && typeof slots !== 'function')) return slots;
    return new Proxy(slots, {
      get: function(target, property) {
        if (property === 'register') {
          var register = Reflect.get(target, property, target);
          if (typeof register !== 'function') return register;
          return function(options) {
            var args = Array.prototype.slice.call(arguments);
            if (options && options.name === 'settings.section' && options.id === SETTINGS_SECTION_ID) {
              args[0] = Object.assign({}, options, {
                order: settingsSectionOrder(target, SETTINGS_SECTION_ID)
              });
            }
            return register.apply(target, args);
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  function wrapContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return ctx;
    if (contexts && contexts.has(ctx)) return contexts.get(ctx);
    installManualModelPicker();
    var live = createLiveClient();
    var connectionCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;
    var remote = wrapRemote(ctx.remote, live);
    var locale = wrapLocale(ctx.locale);
    var slots = wrapSlots(ctx.slots);
    var wrapped = new Proxy(ctx, {
      get: function(target, property) {
        if (property === 'remote') return remote;
        if (property === 'locale') return locale;
        if (property === 'slots') return slots;
        if (property === 'get') {
          var get = Reflect.get(target, property, target);
          if (typeof get !== 'function') return get;
          return function(name) {
            var rest = Array.prototype.slice.call(arguments, 1);
            var value = get.apply(target, [name].concat(rest));
            if (name !== 'connection' || !value || (typeof value !== 'object' && typeof value !== 'function')) return value;
            if (connectionCache && connectionCache.has(value)) return connectionCache.get(value);
            var next = wrapConnection(value, live);
            if (connectionCache) connectionCache.set(value, next);
            return next;
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    if (contexts) contexts.set(ctx, wrapped);
    try {
      if (typeof ctx.effect === 'function') ctx.effect(function(){ return function(){ live.dispose(); }; }, 'vision-router: live model catalog client');
    } catch (_) {}
    // Warm the Host cache as soon as the plugin activates. By the time the user
    // opens Settings, stale-while-revalidate normally has a snapshot ready.
    void live.refresh(true);
    return wrapped;
  }

  function patchLoader(loader) {
    if (!loader || (typeof loader !== 'object' && typeof loader !== 'function')) return;

    if (typeof loader.load === 'function' && !loader.load.__visionRouterLiveModels) {
      var original = loader.load;
      function load(spec) {
        if (spec && spec.id === 'dsh-vision-router' && typeof spec.factory === 'function') {
          var factory = spec.factory;
          spec = Object.assign({}, spec, {
            factory: function(require) {
              var exports = factory(require);
              if (exports && typeof exports.apply === 'function' && !exports.apply.__visionRouterLiveModels) {
                var apply = exports.apply;
                var wrappedApply = function(ctx) {
                  var rest = Array.prototype.slice.call(arguments, 1);
                  return apply.apply(exports, [wrapContext(ctx)].concat(rest));
                };
                Object.defineProperty(wrappedApply, '__visionRouterLiveModels', { value: true });
                exports.apply = wrappedApply;
              }
              return exports;
            }
          });
        }
        return original.call(loader, spec);
      }
      Object.defineProperty(load, '__visionRouterLiveModels', { value: true });
      loader.load = load;
    }

    // rc.8 boot has two loader phases on the same object. The parser first
    // exposes queue-mode load(); later ClientModuleSystem.create() assigns a
    // new live-mode load() before any lazy community bundle arrives. A wrapper
    // installed only during parsing is therefore silently discarded. Wrap the
    // transition itself and immediately re-apply this factory/context boundary
    // to the new live sink.
    if (typeof loader.create === 'function' && !loader.create.__visionRouterLiveModels) {
      var originalCreate = loader.create;
      function create() {
        var result = originalCreate.apply(this, arguments);
        patchLoader(loader);
        return result;
      }
      Object.defineProperty(create, '__visionRouterLiveModels', { value: true });
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

export function injectLiveModelClientPrelude(html) {
  if (typeof html !== 'string' || htmlHasScriptMarker(html, CLIENT_PRELUDE_MARK)) return html
  const script = `<script ${CLIENT_PRELUDE_MARK}>${LIVE_MODEL_CLIENT_PRELUDE.replace(/<\/script/gi, '<\\/script')}</script>`
  // DSH's client-modules index tap prepends its queue-mode facade immediately
  // after <head>. Run after that parser bootstrap so we can wrap both load()
  // and create(); the create wrapper then re-attaches us after rc.8 swaps in
  // its live registration sink, before lazy third-party bundles arrive.
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installLiveModelClientPrelude(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectLiveModelClientPrelude),
      'vision-router: live model client prelude',
    )
  })
}