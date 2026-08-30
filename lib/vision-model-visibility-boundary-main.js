const VISION_MODE_WRAPPER_SOURCE = 'deepseek-official'
const DEFAULT_WRAPPER_ROUTE = 'deepseek-vision'
const MODEL_SELECTION_TARGET = '@deepseek-ai/dsh-client-ui-model-selection'
const VISIBILITY_MARK = 'data-vision-router-model-visibility-boundary'

function visionPresentationGroup(groups, id) {
  if (!Array.isArray(groups) || typeof id !== 'string' || id === '') return undefined
  return groups.find((group) => group && group.id === id)
}

function visionPresentationHasModel(group, modelId) {
  return !!group && Array.isArray(group.models) && group.models.some(
    (model) => model && model.id === modelId,
  )
}

function visionPresentationSourceName(group, fallback) {
  return group && typeof group.name === 'string' && group.name !== '' ? group.name : fallback
}

function visionPresentationHasOwn(config, key) {
  return !!config && typeof config === 'object' && Object.prototype.hasOwnProperty.call(config, key)
}

function visionPresentationTwinIntended(config, sourceProvider, modelId) {
  if (!config || typeof config !== 'object') return false
  const entries = Array.isArray(config.wrappedProviders) ? config.wrappedProviders : []
  const explicit = entries.find((entry) => entry && entry.provider === sourceProvider)
  if (explicit) {
    const models = Array.isArray(explicit.models) ? explicit.models : []
    return models.length === 0 || models.includes(modelId)
  }
  return config.autoWrapProviders !== false
}

function visionPresentationAllModelsMirrored(source, target, allowModel) {
  if (!source || !target || !Array.isArray(target.models) || target.models.length === 0) return false
  return target.models.every((model) =>
    model &&
    typeof model.id === 'string' &&
    model.id !== '' &&
    visionPresentationHasModel(source, model.id) &&
    (!allowModel || allowModel(model.id)),
  )
}

function visionPresentationGeneratedTwinSource(groups, target, config) {
  if (!config || typeof config !== 'object') return undefined
  if (!target || typeof target.id !== 'string' || !target.id.endsWith('-vision')) return undefined
  const sourceProvider = target.id.slice(0, -'-vision'.length)
  // DeepSeek's primary wrapper is deliberately special and may have a custom
  // route name. Never infer a generated DeepSeek twin from a suffix alone.
  if (!sourceProvider || sourceProvider === VISION_MODE_WRAPPER_SOURCE) return undefined
  // Core excludes sources whose route id already ends in "-vision" from both
  // automatic and explicit twin registration. Mirrored third-party routes such
  // as foo-vision/foo-vision-vision therefore have uncertain provenance and
  // must remain visible rather than being mistaken for plugin-owned wrappers.
  if (sourceProvider.endsWith('-vision')) return undefined
  const source = visionPresentationGroup(groups, sourceProvider)
  if (!source) return undefined
  const expectedName = `${visionPresentationSourceName(source, sourceProvider)} + 自动识图`
  if (target.name !== expectedName) return undefined
  const mirrored = visionPresentationAllModelsMirrored(
    source,
    target,
    (modelId) => visionPresentationTwinIntended(config, sourceProvider, modelId),
  )
  return mirrored ? sourceProvider : undefined
}

function visionPresentationConfiguredWrapperSource(groups, target, config) {
  if (!config || typeof config !== 'object' || !target) return undefined
  const configured = typeof config.wrapperRoute === 'string' ? config.wrapperRoute.trim() : ''
  if (visionPresentationHasOwn(config, 'wrapperRoute') && configured === '') return undefined
  const wrapperRoute = configured || DEFAULT_WRAPPER_ROUTE
  if (target.id !== wrapperRoute || wrapperRoute === VISION_MODE_WRAPPER_SOURCE) return undefined
  const source = visionPresentationGroup(groups, VISION_MODE_WRAPPER_SOURCE)
  if (!source) return undefined
  const expectedName = `${visionPresentationSourceName(source, VISION_MODE_WRAPPER_SOURCE)} + 自动识图`
  if (target.name !== expectedName) return undefined
  return visionPresentationAllModelsMirrored(source, target)
    ? VISION_MODE_WRAPPER_SOURCE
    : undefined
}

function visionPresentationSourceForGroup(groups, target, config) {
  return visionPresentationConfiguredWrapperSource(groups, target, config) ??
    visionPresentationGeneratedTwinSource(groups, target, config)
}

function visionPresentationHiddenSources(state, config) {
  const hidden = new Map()
  if (!state || typeof state !== 'object' || !Array.isArray(state.groups)) return hidden
  if (!config || typeof config !== 'object') return hidden
  for (const group of state.groups) {
    const sourceProvider = visionPresentationSourceForGroup(state.groups, group, config)
    if (sourceProvider) hidden.set(group.id, sourceProvider)
  }
  return hidden
}

/**
 * Presentation-only projection for DSH's stock model selector.
 *
 * The Host and Vision Router keep the real wrapper route as the authoritative
 * current selection. Only the model-selection plugin sees this filtered view:
 * confirmed internal wrapper groups disappear and an active wrapper projects
 * back to its ordinary source provider. Missing browser settings fail open so
 * an uncertain provider is shown rather than accidentally hidden.
 */
export function projectVisionModeDirectoryState(state, config) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.groups)) return state
  if (!config || typeof config !== 'object') return state

  const sourceByHiddenProvider = visionPresentationHiddenSources(state, config)
  if (sourceByHiddenProvider.size === 0) return state
  const visibleGroups = state.groups.filter((group) => !sourceByHiddenProvider.has(group.id))

  const current = state.current
  let visibleCurrent = current
  if (current && typeof current === 'object') {
    const sourceProvider = sourceByHiddenProvider.get(current.provider)
    if (sourceProvider) {
      const source = visionPresentationGroup(state.groups, sourceProvider)
      if (visionPresentationHasModel(source, current.model)) {
        visibleCurrent = {
          provider: sourceProvider,
          model: current.model,
          ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }),
        }
      }
    }
  }

  return {
    ...state,
    groups: visibleGroups,
    current: visibleCurrent,
  }
}

/**
 * Translate a presentation-layer selection back to the real current wrapper
 * only when the user is editing the same visible model (for example changing
 * reasoning effort). Picking a different model/provider deliberately leaves
 * the wrapper and therefore turns Vision mode off.
 */
export function mapVisionPresentationSelection(state, selection, config) {
  if (!selection || typeof selection !== 'object') return selection
  if (!state || typeof state !== 'object' || !Array.isArray(state.groups)) return selection
  if (!config || typeof config !== 'object') return selection
  const current = state.current
  if (!current || typeof current !== 'object') return selection
  const currentGroup = visionPresentationGroup(state.groups, current.provider)
  const sourceProvider = visionPresentationSourceForGroup(state.groups, currentGroup, config)
  if (!sourceProvider) return selection
  if (selection.provider !== sourceProvider || selection.model !== current.model) return selection
  return {
    ...selection,
    provider: current.provider,
  }
}

const VISIBILITY_HELPER_SOURCE = [
  visionPresentationGroup,
  visionPresentationHasModel,
  visionPresentationSourceName,
  visionPresentationHasOwn,
  visionPresentationTwinIntended,
  visionPresentationAllModelsMirrored,
  visionPresentationGeneratedTwinSource,
  visionPresentationConfiguredWrapperSource,
  visionPresentationSourceForGroup,
  visionPresentationHiddenSources,
  projectVisionModeDirectoryState,
  mapVisionPresentationSelection,
].map((fn) => fn.toString()).join('\n')

export const VISION_MODEL_VISIBILITY_PRELUDE = String.raw`(function(){
  'use strict';
  var TARGET = '${MODEL_SELECTION_TARGET}';
  var VISION_MODE_WRAPPER_SOURCE = '${VISION_MODE_WRAPPER_SOURCE}';
  var DEFAULT_WRAPPER_ROUTE = '${DEFAULT_WRAPPER_ROUTE}';

  ${VISIBILITY_HELPER_SOURCE}

  function bindVisionSettings(ctx) {
    try {
      var binder = ctx && ctx.settingsScope;
      if (!binder || typeof binder.bind !== 'function') return undefined;
      return binder.bind({ namespace: 'vision-router' });
    } catch (_) {
      return undefined;
    }
  }

  function currentVisionConfig(settings) {
    try {
      if (!settings || typeof settings.getSnapshot !== 'function') return undefined;
      var snapshot = settings.getSnapshot();
      var value = snapshot && snapshot.value;
      return value && typeof value === 'object' ? value : undefined;
    } catch (_) {
      return undefined;
    }
  }

  function configKey(config) {
    if (!config || typeof config !== 'object') return 'unavailable';
    var wrapped = Array.isArray(config.wrappedProviders)
      ? config.wrappedProviders.map(function(entry){
          return {
            provider: entry && typeof entry.provider === 'string' ? entry.provider : '',
            models: entry && Array.isArray(entry.models) ? entry.models.slice() : []
          };
        })
      : [];
    try {
      return JSON.stringify({
        wrapperRoute: typeof config.wrapperRoute === 'string' ? config.wrapperRoute : '',
        autoWrapProviders: config.autoWrapProviders !== false,
        wrappedProviders: wrapped
      });
    } catch (_) {
      return 'invalid';
    }
  }

  function wrapStore(store, settings) {
    if (!store || typeof store !== 'object') return store;
    var lastRaw;
    var lastConfigKey;
    var lastProjected;
    function getSnapshot() {
      var raw = typeof store.getSnapshot === 'function' ? store.getSnapshot() : undefined;
      var config = currentVisionConfig(settings);
      var key = configKey(config);
      if (raw === lastRaw && key === lastConfigKey && lastProjected !== undefined) return lastProjected;
      lastRaw = raw;
      lastConfigKey = key;
      lastProjected = projectVisionModeDirectoryState(raw, config);
      return lastProjected;
    }
    return {
      subscribe: function(listener) {
        var stops = [];
        if (typeof store.subscribe === 'function') stops.push(store.subscribe(listener));
        if (settings && typeof settings.subscribe === 'function') stops.push(settings.subscribe(listener));
        return function(){
          for (var i = 0; i < stops.length; i++) {
            try { if (typeof stops[i] === 'function') stops[i](); } catch (_) {}
          }
        };
      },
      getSnapshot: getSnapshot
    };
  }

  function wrapDirectory(directory, settings) {
    if (!directory || typeof directory !== 'object' || typeof Proxy !== 'function') return directory;
    var store = wrapStore(directory.store, settings);
    return new Proxy(directory, {
      get: function(target, property) {
        if (property === 'store') return store;
        if (property === 'load') {
          var load = Reflect.get(target, property, target);
          if (typeof load !== 'function') return load;
          return function(){
            return Promise.resolve(load.apply(target, arguments)).then(function(value){
              return projectVisionModeDirectoryState(value, currentVisionConfig(settings));
            });
          };
        }
        if (property === 'select') {
          var select = Reflect.get(target, property, target);
          if (typeof select !== 'function') return select;
          return function(selection) {
            var raw;
            try {
              raw = target.store && typeof target.store.getSnapshot === 'function'
                ? target.store.getSnapshot()
                : undefined;
            } catch (_) {
              raw = undefined;
            }
            var mapped = mapVisionPresentationSelection(raw, selection, currentVisionConfig(settings));
            var args = Array.prototype.slice.call(arguments);
            args[0] = mapped;
            return select.apply(target, args);
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  function wrapModelDirectories(models, settings) {
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
            var wrapped = wrapDirectory(directory, settings);
            if (cache) cache.set(directory, wrapped);
            return wrapped;
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  function contextWithModelVisibility(ctx) {
    if (!ctx || typeof ctx !== 'object' || typeof Proxy !== 'function') return ctx;
    var settings = bindVisionSettings(ctx);
    var modelCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;
    function modelsView(models) {
      if (!models || (typeof models !== 'object' && typeof models !== 'function')) return models;
      if (modelCache && modelCache.has(models)) return modelCache.get(models);
      var wrapped = wrapModelDirectories(models, settings);
      if (modelCache) modelCache.set(models, wrapped);
      return wrapped;
    }
    function scopeView(scope) {
      if (!scope || typeof scope !== 'object') return scope;
      return new Proxy(scope, {
        get: function(target, property) {
          if (property === 'modelDirectories') return modelsView(Reflect.get(target, property, target));
          if (property === 'get') {
            var get = Reflect.get(target, property, target);
            if (typeof get !== 'function') return get;
            return function(name) {
              var args = Array.prototype.slice.call(arguments, 1);
              var value = get.apply(target, [name].concat(args));
              return name === 'modelDirectories' ? modelsView(value) : value;
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
        if (property === 'get') {
          var get = Reflect.get(target, property, target);
          if (typeof get !== 'function') return get;
          return function(name) {
            var args = Array.prototype.slice.call(arguments, 1);
            var value = get.apply(target, [name].concat(args));
            return name === 'modelDirectories' ? modelsView(value) : value;
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

  function decorate(plugin) {
    if (!plugin || typeof plugin !== 'object' || typeof plugin.apply !== 'function') return plugin;
    if (plugin.apply.__visionRouterModelVisibility) return plugin;
    try {
      if (Array.isArray(plugin.inject) && !plugin.inject.includes('settingsScope')) {
        plugin.inject = plugin.inject.concat('settingsScope');
      }
    } catch (_) {}
    var originalApply = plugin.apply;
    function apply(ctx) {
      var args = Array.prototype.slice.call(arguments);
      args[0] = contextWithModelVisibility(ctx);
      return originalApply.apply(this, args);
    }
    try { Object.defineProperty(apply, '__visionRouterModelVisibility', { value: true }); } catch (_) {}
    plugin.apply = apply;
    return plugin;
  }

  function patchLoader(loader) {
    if (!loader || (typeof loader !== 'object' && typeof loader !== 'function')) return;
    if (typeof loader.load === 'function' && !loader.load.__visionRouterModelVisibility) {
      var original = loader.load;
      function load(spec) {
        if (spec && spec.id === TARGET && typeof spec.factory === 'function') {
          var factory = spec.factory;
          spec = Object.assign({}, spec, {
            factory: function(require) { return decorate(factory(require)); }
          });
        }
        return original.call(this, spec);
      }
      try { Object.defineProperty(load, '__visionRouterModelVisibility', { value: true }); } catch (_) {}
      loader.load = load;
    }
    if (typeof loader.create === 'function' && !loader.create.__visionRouterModelVisibility) {
      var originalCreate = loader.create;
      function create() {
        var result = originalCreate.apply(this, arguments);
        patchLoader(loader);
        return result;
      }
      try { Object.defineProperty(create, '__visionRouterModelVisibility', { value: true }); } catch (_) {}
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

  install();
})();`

export function injectVisionModelVisibilityBoundary(html) {
  if (typeof html !== 'string' || html.includes(VISIBILITY_MARK)) return html
  const safe = VISION_MODEL_VISIBILITY_PRELUDE.replace(/<\/script/gi, '<\\/script')
  const script = `<script ${VISIBILITY_MARK}>${safe}</script>`
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installVisionModelVisibilityBoundary(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectVisionModelVisibilityBoundary),
      'vision-router: model visibility boundary',
    )
  })
}
