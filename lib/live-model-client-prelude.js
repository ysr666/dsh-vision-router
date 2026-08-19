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
  var contexts = typeof WeakMap === 'function' ? new WeakMap() : undefined;

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

  function catalogValue(body) {
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

  function mergeCatalog(body, snapshot) {
    var value = catalogValue(body);
    if (!value || typeof value !== 'object') return body;
    var originalGroups = Array.isArray(value.groups) ? value.groups : [];
    var liveEntries = cleanProviders(snapshot);
    if (liveEntries.length === 0) return body;
    var byProvider = new Map();
    liveEntries.forEach(function(entry) {
      if (entry && typeof entry.provider === 'string' && entry.provider) byProvider.set(entry.provider, entry);
    });
    var groups = originalGroups.map(function(group) {
      var live = group && byProvider.get(group.id);
      if (!live || !Array.isArray(live.models) || live.models.length === 0) return group;
      byProvider.delete(group.id);
      var originalModels = Array.isArray(group.models) ? group.models : [];
      var seen = new Set(originalModels.map(function(model){ return model && model.id; }).filter(Boolean));
      var appended = [];
      live.models.forEach(function(model) {
        if (!model || typeof model.id !== 'string' || !model.id || seen.has(model.id)) return;
        seen.add(model.id);
        appended.push({
          provider: group.id,
          id: model.id,
          name: typeof model.name === 'string' && model.name ? model.name : model.id,
          visionRouterLiveDiscovered: true
        });
      });
      return appended.length ? Object.assign({}, group, { models: originalModels.concat(appended) }) : group;
    });
    byProvider.forEach(function(live) {
      if (!live || !Array.isArray(live.models)) return;
      var models = [];
      var seen = new Set();
      live.models.forEach(function(model) {
        if (!model || typeof model.id !== 'string' || !model.id || seen.has(model.id)) return;
        seen.add(model.id);
        models.push({
          provider: live.provider,
          id: model.id,
          name: typeof model.name === 'string' && model.name ? model.name : model.id,
          visionRouterLiveDiscovered: true
        });
      });
      if (models.length) groups.push({ id: live.provider, name: live.provider, models: models });
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
    // Endpoint discovery updates `refreshing` on every queue/poll transition.
    // Treat those as transport progress, not catalog invalidations. Otherwise
    // the settings card receives a synthetic llm/adapters-updated event every
    // ~400ms, clears both model/capability state, and the dropdown visibly
    // jumps between loading/ready while the user is trying to select a model.
    // Accumulate real snapshot changes and publish exactly once when the batch
    // settles (`refreshing === false`).
    var pendingEmit = false;

    function emit() {
      listeners.forEach(function(listener) { try { listener(); } catch (_) {} });
    }

    function sameSnapshot(left, right) {
      if (!left || !right) return left === right;
      // `refreshing` is deliberately ignored: it is progress state, not model
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
      augment: function(body) {
        void refresh(true);
        return mergeCatalog(body, snapshot);
      },
      refresh: refresh,
      subscribe: function(listener) {
        if (typeof listener !== 'function') return function(){};
        listeners.add(listener);
        return function(){ listeners.delete(listener); };
      },
      dispose: function() {
        disposed = true;
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
    if (typeof models !== 'function') return connection;
    var wrappedLlm = new Proxy(llm, {
      get: function(target, property) {
        if (property === 'models') {
          return async function() {
            var body = await models.apply(target, arguments);
            return live.augment(body);
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
        visionDepthStandard: '标准（最多再细看 2 次，默认）',
        visionDepthDeep: '细致（最多再细看 4 次）',
        hintVisionDepth: '结构化预识别之后：快速最多再细看 1 次、标准最多 2 次、细致最多 4 次；自定义可自行设置上限。档位只限制追加的证据深挖次数，具体看什么仍由模型按你的问题决定。',
        hintVisionDepthMaxCalls: '选择「自定义」后填写 0-100：1-100 = 最多深挖对应次数；留空或填 0 = 不限制。bootstrap 预识别不计入，失败调用也不占次数。标准档仍固定最多 2 次。'
      });
    }
    if (next.en && typeof next.en === 'object') {
      next.en = Object.assign({}, next.en, {
        visionDepthStandard: 'Standard (at most 2 more looks, default)',
        visionDepthDeep: 'Thorough (at most 4 more looks)',
        hintVisionDepth: 'After the structured pre-scan: Quick allows at most 1 more evidence look, Standard 2, Thorough 4, and Custom lets you set the cap. The tier limits only additional evidence calls; the model still decides what to inspect from your request.',
        hintVisionDepthMaxCalls: 'With Custom selected, enter 0-100: 1-100 caps successful deep-dive evidence calls; blank or 0 = unlimited. The bootstrap pre-scan and failed calls do not consume the quota. Standard remains capped at 2.'
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
    if (!loader || typeof loader.load !== 'function' || loader.load.__visionRouterLiveModels) return;
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
  if (typeof html !== 'string' || html.includes(CLIENT_PRELUDE_MARK)) return html
  const script = `<script ${CLIENT_PRELUDE_MARK}>${LIVE_MODEL_CLIENT_PRELUDE.replace(/<\/script/gi, '<\\/script')}</script>`
  const head = html.indexOf('<head>')
  return head === -1 ? `${script}${html}` : `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
}

export function installLiveModelClientPrelude(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectLiveModelClientPrelude),
      'vision-router: live model client prelude',
    )
  })
}
