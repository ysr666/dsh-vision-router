import { htmlHasScriptMarker } from './html-script-marker.js'
import { LOCAL_SETTINGS_PATH } from './dsh-settings-017-compat.js'

const SETTINGS_017_MARK = 'data-vision-router-settings-017-compat'
const SETTINGS_017_STRUCTURED_MARK = `/* ${SETTINGS_017_MARK}:structured */`

export const SETTINGS_017_CLIENT_PRELUDE = String.raw`(function(){
  'use strict';
  var TARGET = 'dsh-vision-router';
  var ENDPOINT = '${LOCAL_SETTINGS_PATH}';
  var contextCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;
  var scopeCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;
  var binderCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;
  var connectionCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;

  function safeGet(ctx, name) {
    if (!ctx) return undefined;
    try {
      if (typeof ctx.get === 'function') {
        var value = ctx.get(name);
        if (value !== undefined && value !== null) return value;
      }
    } catch (_) {}
    try { return ctx[name]; } catch (_) { return undefined; }
  }

  function isLoopbackLocation(locationLike) {
    var hostname = locationLike && typeof locationLike.hostname === 'string'
      ? locationLike.hostname.toLowerCase().replace(/^\[|\]$/g, '')
      : '';
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1') return true;
    return /^127(?:\.\d{1,3}){3}$/.test(hostname);
  }

  function normalizeConnection(connection) {
    if (!connection || typeof connection !== 'object') return connection;
    var locationLike;
    try { locationLike = window && window.location; } catch (_) { locationLike = undefined; }
    if (!isLoopbackLocation(locationLike) || connection.isLoopback !== false) return connection;
    if (connectionCache && connectionCache.has(connection)) return connectionCache.get(connection);
    var wrapped = new Proxy(connection, {
      get: function(target, property) {
        if (property === 'isLoopback') return true;
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    if (connectionCache) connectionCache.set(connection, wrapped);
    return wrapped;
  }

  function errorOf(value, fallback) {
    var detail = value && value.error;
    var error = new Error(detail && detail.message ? detail.message : fallback);
    if (detail && detail.code) error.code = detail.code;
    if (detail && detail.details !== undefined) error.details = detail.details;
    return error;
  }

  function createScope() {
    var listeners = new Set();
    var writeTail = Promise.resolve();
    var inFlight;
    var snapshot = Object.freeze({
      status: 'loading', value: undefined, base: undefined, user: undefined,
      revision: undefined, writable: false, mode: 'host'
    });
    function publish(next) {
      snapshot = Object.freeze(next);
      listeners.forEach(function(listener){ try { listener(); } catch (_) {} });
    }
    function accept(view) {
      if (!view || !view.value || typeof view.value !== 'object' || Array.isArray(view.value)
          || !Number.isInteger(view.revision) || view.revision < 0) {
        throw new Error('Vision Router local settings returned an invalid view');
      }
      publish({
        status: 'ready', value: view.value, base: view.base, user: view.user,
        revision: view.revision, writable: view.writable === true, mode: 'host'
      });
    }
    async function request(method, payload) {
      if (typeof fetch !== 'function') throw new Error('Vision Router local settings transport is unavailable');
      var response = await fetch(ENDPOINT, {
        method: method,
        headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        cache: 'no-store',
        credentials: 'same-origin',
        ...(method === 'POST' ? { body: JSON.stringify(payload) } : {})
      });
      var body;
      try { body = await response.json(); } catch (_) { body = undefined; }
      if (!response.ok || !body || body.ok !== true) throw errorOf(body, 'Vision Router local settings request failed');
      return body.value;
    }
    function load(restart) {
      if (!restart && inFlight) return inFlight;
      var task = request('GET').then(accept, function(error){
        publish({
          status: 'unavailable', value: undefined, base: undefined, user: undefined,
          revision: undefined, writable: false, mode: 'host', error: error && error.message ? error.message : String(error)
        });
        throw error;
      });
      var held = task.finally(function(){ if (inFlight === held) inFlight = undefined; });
      inFlight = held;
      return held;
    }
    function writeOps(ops) {
      if (!Array.isArray(ops) || ops.length === 0) return Promise.reject(new TypeError('settings operations must be a non-empty array'));
      var task = writeTail.then(async function(){
        if (snapshot.status !== 'ready' || !Number.isInteger(snapshot.revision)) await load(true);
        if (snapshot.status !== 'ready' || !Number.isInteger(snapshot.revision)) throw new Error('Vision Router local settings are not ready');
        if (!snapshot.writable) throw new Error('Vision Router settings provider is read-only');
        try {
          // One ConfigEditor edit may reload DVR. Keep all fields from one UI
          // Save inside that single Host transaction so a second request cannot
          // get stranded between plugin generations.
          var view = await request('POST', { ops: ops, expectedRevision: snapshot.revision });
          accept(view);
        } catch (error) {
          try { await load(true); } catch (_) {}
          throw error;
        }
      });
      writeTail = task.catch(function(){});
      return task;
    }
    function planOps(items) {
      if (!Array.isArray(items) || items.length === 0) throw new TypeError('settings plan must be a non-empty array');
      return items.map(function(item){
        if (!item || typeof item.key !== 'string' || item.key.length === 0 || !item.run) {
          throw new TypeError('settings plan item is invalid');
        }
        return item.run.clear
          ? { op: 'unset', path: [item.key] }
          : { op: 'set', path: [item.key], value: item.run.value };
      });
    }
    var scope = {
      getSnapshot: function(){ return snapshot; },
      subscribe: function(listener){
        if (typeof listener !== 'function') return function(){};
        listeners.add(listener);
        return function(){ listeners.delete(listener); };
      },
      load: function(){ return load(false); },
      reload: function(){ return load(true); },
      set: function(field, value){ return writeOps([{ op: 'set', path: [field], value: value }]); },
      unset: function(field){ return writeOps([{ op: 'unset', path: [field] }]); },
      __visionRouterWritePlan: function(items){ return writeOps(planOps(items)); },
      dispose: async function(){ listeners.clear(); await Promise.allSettled([inFlight, writeTail].filter(Boolean)); }
    };
    void load(false).catch(function(){});
    return scope;
  }

  function scopeFor(ctx) {
    if (scopeCache && scopeCache.has(ctx)) return scopeCache.get(ctx);
    var scope = createScope();
    if (scopeCache) scopeCache.set(ctx, scope);
    return scope;
  }

  function syntheticBinder(ctx, original) {
    return {
      bind: function(spec) {
        if (spec && spec.namespace === 'vision-router') return scopeFor(ctx);
        if (original && typeof original.bind === 'function') return original.bind(spec);
        throw new Error('Settings scope ' + String(spec && spec.namespace) + ' is unavailable');
      }
    };
  }

  function configFormsBinder(ctx) {
    var forms = safeGet(ctx, 'configForms');
    if (!forms || typeof forms.get !== 'function') return undefined;
    if (binderCache && binderCache.has(forms)) return binderCache.get(forms);
    var binder = {
      bind: function(spec) {
        var namespace = spec && spec.namespace;
        if (typeof namespace !== 'string' || namespace.length === 0) {
          throw new TypeError('settings namespace must be a non-empty string');
        }
        return forms.get(namespace);
      }
    };
    if (binderCache) binderCache.set(forms, binder);
    return binder;
  }

  function wrapContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return ctx;
    if (contextCache && contextCache.has(ctx)) return contextCache.get(ctx);
    var wrapped = new Proxy(ctx, {
      get: function(target, property) {
        if (property === 'settingsScope') {
          var original = safeGet(target, 'settingsScope');
          if (original && typeof original.bind === 'function') return original;
          // DSH 0.1.7 configForms only mirrors Config fields declared volatile.
          // DVR must keep its public Config ordinary for the older supported Host
          // window, so its namespace intentionally uses the local-only ConfigEditor
          // bridge while other namespaces may still delegate to native configForms.
          var official = configFormsBinder(target);
          return syntheticBinder(ctx, official);
        }
        if (property === 'get') {
          var getter = Reflect.get(target, property, target);
          if (typeof getter !== 'function') return getter;
          return function(name) {
            var value = getter.call(target, name);
            return name === 'connection' ? normalizeConnection(value) : value;
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    if (contextCache) contextCache.set(ctx, wrapped);
    return wrapped;
  }

  function requireConfigForms(plugin) {
    if (!plugin || !Array.isArray(plugin.inject)) return plugin;
    var inject = [];
    var inserted = false;
    for (var index = 0; index < plugin.inject.length; index += 1) {
      var service = plugin.inject[index];
      if (service === 'settingsScope') {
        if (!inserted) {
          inject.push('configForms');
          inserted = true;
        }
        continue;
      }
      if (service === 'configForms') inserted = true;
      if (inject.indexOf(service) === -1) inject.push(service);
    }
    // Another loader compatibility layer may already have removed the legacy
    // dependency before this factory runs. DSH 0.1.7 still requires the native
    // configForms service to be activation-ready before Vision Router applies.
    if (!inserted) inject.unshift('configForms');
    try {
      plugin.inject = inject;
      return plugin;
    } catch (_) {
      return Object.assign({}, plugin, { inject: inject });
    }
  }

  function patchLoader(loader) {
    if (!loader || typeof loader.load !== 'function' || loader.load.__visionRouterSettings017Compat) return;
    var original = loader.load;
    function load(spec) {
      if (spec && spec.id === TARGET && typeof spec.factory === 'function') {
        var factory = spec.factory;
        spec = Object.assign({}, spec, {
          factory: function(require) {
            var plugin = requireConfigForms(factory(require));
            if (plugin && typeof plugin.apply === 'function' && !plugin.apply.__visionRouterSettings017Compat) {
              var apply = plugin.apply;
              var wrappedApply = function(ctx) {
                var rest = Array.prototype.slice.call(arguments, 1);
                return apply.apply(plugin, [wrapContext(ctx)].concat(rest));
              };
              Object.defineProperty(wrappedApply, '__visionRouterSettings017Compat', { value: true });
              plugin.apply = wrappedApply;
            }
            return plugin;
          }
        });
      }
      return original.call(this, spec);
    }
    Object.defineProperty(load, '__visionRouterSettings017Compat', { value: true });
    loader.load = load;
  }

  function patchCreate(loader) {
    if (!loader || typeof loader.create !== 'function' || loader.create.__visionRouterSettings017Compat) return;
    var original = loader.create;
    function create() {
      var result = original.apply(this, arguments);
      patchLoader(loader);
      if (result && result !== loader) patchLoader(result);
      return result;
    }
    Object.defineProperty(create, '__visionRouterSettings017Compat', { value: true });
    loader.create = create;
    if (loader.mode === 'live') patchLoader(loader);
  }

  function install() {
    var descriptor = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__');
    var stored = window.__ModuleLoader__;
    if (stored) patchCreate(stored);
    if (descriptor && descriptor.configurable === false) return;
    var previousGet = descriptor && descriptor.get;
    var previousSet = descriptor && descriptor.set;
    Object.defineProperty(window, '__ModuleLoader__', {
      configurable: true,
      enumerable: !descriptor || descriptor.enumerable !== false,
      get: function(){ return previousGet ? previousGet.call(window) : stored; },
      set: function(value) {
        if (previousSet) previousSet.call(window, value); else stored = value;
        try { patchCreate(previousGet ? previousGet.call(window) : value); } catch (_) {}
      }
    });
  }

  try { install(); } catch (_) {}
})();`

export function injectSettings017ClientPrelude(html) {
  if (typeof html !== 'string'
    || htmlHasScriptMarker(html, SETTINGS_017_MARK)
    || html.includes(SETTINGS_017_STRUCTURED_MARK)) return html
  const safe = SETTINGS_017_CLIENT_PRELUDE.replace(/<\/script/gi, '<\\/script')
  const script = `<script ${SETTINGS_017_MARK}>${safe}</script>`
  const closeHead = html.indexOf('</head>')
  return closeHead === -1 ? `${html}${script}` : `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
}

export function installSettings017ClientCompatibility(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return
  // ConfigEditor is the generation fence: old supported Hosts keep their native
  // settingsScope activation contract and never see this client shim. DSH 0.1.7
  // Desktop serves dsh-app:// from static assets and receives Host bootstrap
  // state only through the structured index-injection table; raw tapIndex()
  // transforms are HTTP-only and would leave the Desktop client parked on the
  // retired settingsScope dependency.
  ctx.inject(['configEditor', 'webServer'], (webCtx) => {
    if (typeof webCtx.on === 'function') {
      webCtx.on('webserver/index-inject', (table) => {
        if (!Array.isArray(table)) return
        table.push({
          kind: 'script',
          placement: 'head',
          text: `${SETTINGS_017_STRUCTURED_MARK}\n${SETTINGS_017_CLIENT_PRELUDE}`,
        })
      })
    }

    // Keep the served-HTML carrier too. On 0.1.7 the structured row renders
    // first and the marker makes this a no-op; on a transitional Host that
    // has ConfigEditor but never emits index-inject, tapIndex remains the
    // compatibility fallback instead of silently losing the prelude.
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectSettings017ClientPrelude),
      'vision-router: DSH 0.1.7 settings client compatibility',
    )
  })
}
