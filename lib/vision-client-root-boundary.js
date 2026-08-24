const ROOT_MARK = 'data-vision-router-client-root-boundary'

export const VISION_CLIENT_ROOT_PRELUDE = String.raw`(function(){
  'use strict';
  var TOGGLE_TARGET = 'dsh-vision-router';
  var MODEL_TARGET = '@deepseek-ai/dsh-client-ui-model-selection';
  var AUTO_SUFFIX = ' + 自动识图';
  var ROOT_PATCH_MARK = '__visionRouterRootHardening';
  var FALLBACK_OWNERSHIP = Object.freeze({ available: false, revision: 0, routes: Object.freeze([]) });
  var fallbackRecoveries = typeof WeakMap === 'function' ? new WeakMap() : null;

  function ownershipApi() {
    return window.__dshVisionRouterRouteOwnership;
  }

  function ownershipSnapshot() {
    var api = ownershipApi();
    try {
      var value = api && typeof api.getSnapshot === 'function' ? api.getSnapshot() : undefined;
      return value && typeof value === 'object' ? value : FALLBACK_OWNERSHIP;
    } catch (_) {
      return FALLBACK_OWNERSHIP;
    }
  }

  function ownedSource(snapshot, provider) {
    var routes = snapshot && Array.isArray(snapshot.routes) ? snapshot.routes : [];
    for (var i = 0; i < routes.length; i++) {
      var route = routes[i];
      if (route && route.provider === provider) return route.source;
    }
    return undefined;
  }

  function groupById(groups, id) {
    if (!Array.isArray(groups) || typeof id !== 'string' || id === '') return undefined;
    return groups.find(function(group){ return group && group.id === id; });
  }

  function hasModel(group, model) {
    return !!group && Array.isArray(group.models) && group.models.some(function(entry){
      return entry && entry.id === model;
    });
  }

  function wrapperLooking(group) {
    return !!group && typeof group.name === 'string' && group.name.endsWith(AUTO_SUFFIX);
  }

  // The Vision button may keep its legacy resolver for 1.7.x compatibility,
  // but it never receives an unowned wrapper-looking group. Ownership missing
  // therefore fails closed for the button without hiding anything from DSH's
  // actual model selector.
  function projectToggleState(raw, ownership) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.groups)) return raw;
    var available = ownership && ownership.available === true;
    var groups = raw.groups.filter(function(group){
      if (!wrapperLooking(group)) return true;
      return available && ownedSource(ownership, group.id) !== undefined;
    });
    if (groups.length === raw.groups.length) return raw;
    return Object.assign({}, raw, { groups: groups });
  }

  // Stock model selection is presentation-only: only Host-confirmed wrappers
  // are hidden, and only when the advertised model set still mirrors a visible
  // source. Ownership unavailable fails open.
  function projectModelState(raw, ownership) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.groups)) return raw;
    if (!ownership || ownership.available !== true) return raw;
    var hidden = new Map();
    var routes = Array.isArray(ownership.routes) ? ownership.routes : [];
    for (var i = 0; i < routes.length; i++) {
      var route = routes[i];
      if (!route) continue;
      var target = groupById(raw.groups, route.provider);
      var source = groupById(raw.groups, route.source);
      if (!target || !source || !Array.isArray(target.models) || target.models.length === 0) continue;
      var mirrored = target.models.every(function(model){
        return model && typeof model.id === 'string' && model.id !== '' && hasModel(source, model.id);
      });
      if (mirrored) hidden.set(route.provider, route.source);
    }
    if (hidden.size === 0) return raw;
    var groups = raw.groups.filter(function(group){ return !hidden.has(group && group.id); });
    var current = raw.current;
    var visibleCurrent = current;
    if (current && typeof current === 'object') {
      var sourceProvider = hidden.get(current.provider);
      var sourceGroup = sourceProvider ? groupById(raw.groups, sourceProvider) : undefined;
      if (sourceProvider && hasModel(sourceGroup, current.model)) {
        visibleCurrent = {
          provider: sourceProvider,
          model: current.model
        };
        if (current.reasoningEffort !== undefined) {
          visibleCurrent.reasoningEffort = current.reasoningEffort;
        }
      }
    }
    return Object.assign({}, raw, { groups: groups, current: visibleCurrent });
  }

  function mapModelSelection(raw, selection, ownership) {
    if (!raw || typeof raw !== 'object' || !selection || typeof selection !== 'object') return selection;
    if (!ownership || ownership.available !== true) return selection;
    var current = raw.current;
    if (!current || typeof current !== 'object') return selection;
    var source = ownedSource(ownership, current.provider);
    if (!source || selection.provider !== source || selection.model !== current.model) return selection;
    return Object.assign({}, selection, { provider: current.provider });
  }

  function fallbackRecoveryFor(directory) {
    if (!fallbackRecoveries || !directory || (typeof directory !== 'object' && typeof directory !== 'function')) return undefined;
    var existing = fallbackRecoveries.get(directory);
    if (existing) return existing;
    var error = null;
    var listeners = new Set();
    var state = {
      getSnapshot: function(){ return error; },
      subscribe: function(listener){ listeners.add(listener); return function(){ listeners.delete(listener); }; },
      fail: function(value){
        error = value instanceof Error ? value : new Error(value && value.message ? value.message : String(value || 'model operation failed'));
        listeners.forEach(function(listener){ try { listener(); } catch (_) {} });
      },
      clear: function(){
        if (error === null) return;
        error = null;
        listeners.forEach(function(listener){ try { listener(); } catch (_) {} });
      }
    };
    fallbackRecoveries.set(directory, state);
    return state;
  }

  function recoveryFor(directory) {
    var api = ownershipApi();
    try {
      if (api && typeof api.recoveryFor === 'function') return api.recoveryFor(directory);
    } catch (_) {}
    return fallbackRecoveryFor(directory);
  }

  function recoveryError(recovery) {
    try {
      return recovery && typeof recovery.getSnapshot === 'function' ? recovery.getSnapshot() : null;
    } catch (_) {
      return null;
    }
  }

  // Upstream ModelDirectory currently leaves loading/selecting set when the
  // transport Promise rejects before an RPC result arrives. Do not mutate its
  // private store: overlay that one impossible terminal state as error so both
  // selectors expose retry immediately. A successful later operation clears it.
  function overlayTransportFailure(raw, error) {
    if (!error || !raw || typeof raw !== 'object') return raw;
    if (raw.status !== 'loading' && raw.status !== 'selecting') return raw;
    var message = error && error.message ? error.message : String(error);
    return Object.assign({}, raw, { status: 'error', error: message || 'model operation failed' });
  }

  function stableStore(directory, purpose) {
    var store = directory && directory.store;
    if (!store || typeof store !== 'object') return store;
    var recovery = recoveryFor(directory);
    var lastRaw;
    var lastOwnership;
    var lastRecovery;
    var lastProjected;

    function getSnapshot() {
      var raw;
      try { raw = typeof store.getSnapshot === 'function' ? store.getSnapshot() : undefined; }
      catch (_) { raw = undefined; }
      var ownership = ownershipSnapshot();
      var failure = recoveryError(recovery);
      if (raw === lastRaw && ownership === lastOwnership && failure === lastRecovery && lastProjected !== undefined) {
        return lastProjected;
      }
      var next = overlayTransportFailure(raw, failure);
      next = purpose === 'toggle'
        ? projectToggleState(next, ownership)
        : projectModelState(next, ownership);
      lastRaw = raw;
      lastOwnership = ownership;
      lastRecovery = failure;
      lastProjected = next;
      return next;
    }

    return {
      subscribe: function(listener) {
        var stops = [];
        if (typeof store.subscribe === 'function') {
          stops.push(store.subscribe(function(){
            var api = ownershipApi();
            try { if (api && typeof api.refresh === 'function') void api.refresh(true); } catch (_) {}
            listener();
          }));
        }
        var api = ownershipApi();
        try {
          if (api && typeof api.subscribe === 'function') stops.push(api.subscribe(listener));
        } catch (_) {}
        try {
          if (recovery && typeof recovery.subscribe === 'function') stops.push(recovery.subscribe(listener));
        } catch (_) {}
        return function(){
          for (var i = 0; i < stops.length; i++) {
            try { if (typeof stops[i] === 'function') stops[i](); } catch (_) {}
          }
        };
      },
      getSnapshot: getSnapshot
    };
  }

  function operationError(value) {
    if (value instanceof Error) return value;
    return new Error(value && value.message ? value.message : String(value || 'model operation failed'));
  }

  function wrapDirectory(directory, purpose) {
    if (!directory || typeof directory !== 'object' || typeof Proxy !== 'function') return directory;
    var store = stableStore(directory, purpose);
    var recovery = recoveryFor(directory);
    var pending = new Map();
    var generation = 0;

    function run(kind, args) {
      var method = Reflect.get(directory, kind, directory);
      if (typeof method !== 'function') return method;
      var effectiveArgs = Array.prototype.slice.call(args);
      if (kind === 'select' && purpose === 'model' && effectiveArgs[0]) {
        var raw;
        try {
          raw = directory.store && typeof directory.store.getSnapshot === 'function'
            ? directory.store.getSnapshot()
            : undefined;
        } catch (_) { raw = undefined; }
        effectiveArgs[0] = mapModelSelection(raw, effectiveArgs[0], ownershipSnapshot());
      }
      var key;
      try { key = kind + ':' + JSON.stringify(effectiveArgs[0] === undefined ? null : effectiveArgs[0]); }
      catch (_) { key = kind; }
      if (pending.has(key)) return pending.get(key);

      var myGeneration = ++generation;
      try { if (recovery && typeof recovery.clear === 'function') recovery.clear(); } catch (_) {}
      var promise = Promise.resolve().then(function(){
        return method.apply(directory, effectiveArgs);
      }).then(function(value){
        if (myGeneration === generation) {
          try { if (recovery && typeof recovery.clear === 'function') recovery.clear(); } catch (_) {}
          var api = ownershipApi();
          try { if (api && typeof api.refresh === 'function') void api.refresh(true); } catch (_) {}
        }
        return value;
      }, function(error){
        var failure = operationError(error);
        if (myGeneration === generation) {
          try { if (recovery && typeof recovery.fail === 'function') recovery.fail(failure); } catch (_) {}
          var api = ownershipApi();
          try { if (api && typeof api.refresh === 'function') void api.refresh(true); } catch (_) {}
        }
        throw failure;
      }).finally(function(){
        if (pending.get(key) === promise) pending.delete(key);
      });
      pending.set(key, promise);
      return promise;
    }

    return new Proxy(directory, {
      get: function(target, property) {
        if (property === 'store') return store;
        if (property === 'load' || property === 'select') {
          return function(){ return run(property, arguments); };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  function wrapModelDirectories(models, purpose) {
    if (!models || (typeof models !== 'object' && typeof models !== 'function') || typeof Proxy !== 'function') return models;
    var cache = typeof WeakMap === 'function' ? new WeakMap() : undefined;
    return new Proxy(models, {
      get: function(target, property) {
        if (property === 'directoryFor') {
          var directoryFor = Reflect.get(target, property, target);
          if (typeof directoryFor !== 'function') return directoryFor;
          return function(){
            var directory = directoryFor.apply(target, arguments);
            if (!directory || typeof directory !== 'object') return directory;
            if (cache && cache.has(directory)) return cache.get(directory);
            var wrapped = wrapDirectory(directory, purpose);
            if (cache) cache.set(directory, wrapped);
            return wrapped;
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  function contextView(ctx, purpose) {
    if (!ctx || typeof ctx !== 'object' || typeof Proxy !== 'function') return ctx;
    var modelsCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;
    function modelsView(models) {
      if (!models || (typeof models !== 'object' && typeof models !== 'function')) return models;
      if (modelsCache && modelsCache.has(models)) return modelsCache.get(models);
      var wrapped = wrapModelDirectories(models, purpose);
      if (modelsCache) modelsCache.set(models, wrapped);
      return wrapped;
    }
    function scopeView(scope) {
      if (!scope || typeof scope !== 'object') return scope;
      return new Proxy(scope, {
        get: function(target, property) {
          if (property === 'modelDirectories') return modelsView(Reflect.get(target, property, target));
          if (property === 'settingsScope' && purpose === 'model') return undefined;
          if (property === 'get') {
            var get = Reflect.get(target, property, target);
            if (typeof get !== 'function') return get;
            return function(name) {
              if (name === 'modelDirectories') return modelsView(get.call(target, name));
              if (name === 'settingsScope' && purpose === 'model') return undefined;
              var rest = Array.prototype.slice.call(arguments, 1);
              return get.apply(target, [name].concat(rest));
            };
          }
          var value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
    return new Proxy(ctx, {
      get: function(target, property) {
        if (property === 'modelDirectories') return modelsView(Reflect.get(target, property, target));
        if (property === 'settingsScope' && purpose === 'model') return undefined;
        if (property === 'get') {
          var get = Reflect.get(target, property, target);
          if (typeof get !== 'function') return get;
          return function(name) {
            if (name === 'modelDirectories') return modelsView(get.call(target, name));
            if (name === 'settingsScope' && purpose === 'model') return undefined;
            var rest = Array.prototype.slice.call(arguments, 1);
            return get.apply(target, [name].concat(rest));
          };
        }
        if (property === 'inject') {
          var inject = Reflect.get(target, property, target);
          if (typeof inject !== 'function') return inject;
          return function(dependencies, callback) {
            var rest = Array.prototype.slice.call(arguments, 2);
            if (typeof callback !== 'function') return inject.apply(target, [dependencies, callback].concat(rest));
            return inject.apply(target, [dependencies, function(scope){ return callback(scopeView(scope)); }].concat(rest));
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  function decorate(plugin, purpose) {
    if (!plugin || typeof plugin !== 'object' || typeof plugin.apply !== 'function') return plugin;
    if (plugin.apply && plugin.apply[ROOT_PATCH_MARK + purpose]) return plugin;
    // The legacy visibility decorator used settingsScope only to guess wrapper
    // identity. Root ownership replaces that guess, so do not turn the official
    // model selector's optional settings service into a hard dependency.
    if (purpose === 'model') {
      try {
        if (Array.isArray(plugin.inject)) {
          plugin.inject = plugin.inject.filter(function(name){ return name !== 'settingsScope'; });
        }
      } catch (_) {}
    }
    var originalApply = plugin.apply;
    function apply(ctx) {
      var args = Array.prototype.slice.call(arguments);
      args[0] = contextView(ctx, purpose);
      return originalApply.apply(this, args);
    }
    try { Object.defineProperty(apply, ROOT_PATCH_MARK + purpose, { value: true }); } catch (_) {}
    plugin.apply = apply;
    return plugin;
  }

  function patchLoader(loader) {
    if (!loader || (typeof loader !== 'object' && typeof loader !== 'function')) return;
    if (typeof loader.load === 'function' && !loader.load[ROOT_PATCH_MARK]) {
      var originalLoad = loader.load;
      function load(spec) {
        var purpose = spec && spec.id === TOGGLE_TARGET
          ? 'toggle'
          : spec && spec.id === MODEL_TARGET
            ? 'model'
            : undefined;
        if (purpose && spec && typeof spec.factory === 'function') {
          var factory = spec.factory;
          spec = Object.assign({}, spec, {
            factory: function(require){ return decorate(factory(require), purpose); }
          });
        }
        return originalLoad.call(this, spec);
      }
      try { Object.defineProperty(load, ROOT_PATCH_MARK, { value: true }); } catch (_) {}
      loader.load = load;
    }
    if (typeof loader.create === 'function' && !loader.create[ROOT_PATCH_MARK]) {
      var originalCreate = loader.create;
      function create() {
        var result = originalCreate.apply(this, arguments);
        var registry = window.__dshVisionRouterLoaderPatches;
        if (registry && typeof registry.patch === 'function') {
          registry.patch(loader);
          if (result && result !== loader) registry.patch(result);
        } else {
          patchLoader(loader);
          if (result && result !== loader) patchLoader(result);
        }
        return result;
      }
      try { Object.defineProperty(create, ROOT_PATCH_MARK, { value: true }); } catch (_) {}
      loader.create = create;
    }
  }

  function installLoaderRegistry() {
    var existing = window.__dshVisionRouterLoaderPatches;
    if (existing && typeof existing.register === 'function' && typeof existing.patch === 'function') {
      existing.register(patchLoader);
      return;
    }
    var patches = new Set();
    var descriptor = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__');
    var stored = window.__ModuleLoader__;
    function patchAll(loader) {
      patches.forEach(function(patch){
        try { patch(loader); } catch (_) {}
      });
    }
    var registry = Object.freeze({
      register: function(patch) {
        if (typeof patch !== 'function') return;
        patches.add(patch);
        try { patch(stored); } catch (_) {}
      },
      patch: patchAll
    });
    Object.defineProperty(window, '__dshVisionRouterLoaderPatches', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: registry
    });
    patches.add(patchLoader);
    patchAll(stored);
    if (descriptor && descriptor.configurable === false) return;
    Object.defineProperty(window, '__ModuleLoader__', {
      configurable: true,
      enumerable: true,
      get: function(){ return stored; },
      set: function(value) {
        stored = value;
        patchAll(value);
      }
    });
  }

  installLoaderRegistry();
})();`

export function injectVisionClientRootBoundary(html) {
  if (typeof html !== 'string' || html.includes(ROOT_MARK)) return html
  const safe = VISION_CLIENT_ROOT_PRELUDE.replace(/<\/script/gi, '<\\/script')
  const script = `<script ${ROOT_MARK}>${safe}</script>`
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installVisionClientRootBoundary(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectVisionClientRootBoundary),
      'vision-router: client route ownership and model recovery boundary',
    )
  })
}
