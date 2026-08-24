const DEFAULT_WRAPPER_ROUTE = 'deepseek-vision'
const DEFAULT_CHAIN_ROUTE = 'vision-chain'
const DEEPSEEK_SOURCE = 'deepseek-official'
const AUTO_VISION_SUFFIX = ' + 自动识图'
const OWNERSHIP_PATH = '/_dsh/vision-router/route-ownership'
const OWNERSHIP_MARK = 'data-vision-router-root-ownership'

function routeOf(config, key, fallback) {
  const value = config && typeof config[key] === 'string' ? config[key].trim() : ''
  return value || fallback
}

function hasRoute(llm, route) {
  try {
    return !!llm && typeof llm.registration === 'function' && llm.registration(route) !== undefined
  } catch {
    return false
  }
}

function wrapperSource(route, adapter, config) {
  if (route === routeOf(config, 'wrapperRoute', DEFAULT_WRAPPER_ROUTE)) return DEEPSEEK_SOURCE
  if (!route.endsWith('-vision')) return undefined
  const source = route.slice(0, -'-vision'.length)
  if (!source || source.endsWith('-vision')) return undefined
  try {
    const info = typeof adapter?.providerInfo === 'function' ? adapter.providerInfo(route) : undefined
    return typeof info?.name === 'string' && info.name.endsWith(AUTO_VISION_SUFFIX) ? source : undefined
  } catch {
    return undefined
  }
}

function activeConfig(ctx, fallback) {
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  } catch {}
  return fallback && typeof fallback === 'object' ? fallback : {}
}

function createOwnership() {
  const owned = new Set()
  const wrappers = new Map()
  let revision = 0
  const add = (routes, adapter, config) => {
    let changed = false
    for (const route of routes) {
      if (!owned.has(route)) {
        owned.add(route)
        changed = true
      }
      const source = wrapperSource(route, adapter, config)
      if (source !== undefined && wrappers.get(route) !== source) {
        wrappers.set(route, source)
        changed = true
      }
    }
    if (changed) revision += 1
  }
  const remove = (routes) => {
    let changed = false
    for (const route of routes) {
      if (owned.delete(route)) changed = true
      if (wrappers.delete(route)) changed = true
    }
    if (changed) revision += 1
  }
  return {
    owns: (route) => owned.has(route),
    sourceFor: (route) => wrappers.get(route),
    add,
    remove,
    snapshot: () => ({
      revision,
      routes: [...wrappers]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([provider, source]) => ({ provider, source })),
    }),
  }
}

function projectedConfig(value, llm, ownership) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const next = { ...value }
  let changed = false
  for (const [key, fallback] of [
    ['wrapperRoute', DEFAULT_WRAPPER_ROUTE],
    ['chainRoute', DEFAULT_CHAIN_ROUTE],
  ]) {
    const route = routeOf(value, key, fallback)
    if (hasRoute(llm, route) && !ownership.owns(route)) {
      next[key] = ''
      changed = true
    }
  }
  return changed ? next : value
}

function scopeView(scope, llm, ownership) {
  if (!scope || typeof scope !== 'object') return scope
  return new Proxy(scope, {
    get(target, property) {
      if (property === 'get') {
        const get = Reflect.get(target, property, target)
        return typeof get !== 'function'
          ? get
          : (...args) => projectedConfig(get.apply(target, args), llm, ownership)
      }
      if (property === 'watch') {
        const watch = Reflect.get(target, property, target)
        return typeof watch !== 'function'
          ? watch
          : (callback, ...rest) => watch.call(
              target,
              (value, ...tail) =>
                typeof callback === 'function'
                  ? callback(projectedConfig(value, llm, ownership), ...tail)
                  : undefined,
              ...rest,
            )
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function settingsView(settings, llm, ownership) {
  if (!settings || typeof settings !== 'object') return settings
  return new Proxy(settings, {
    get(target, property) {
      if (property === 'get') {
        const get = Reflect.get(target, property, target)
        return typeof get !== 'function'
          ? get
          : (namespace, ...rest) => {
              const value = get.call(target, namespace, ...rest)
              return namespace === 'vision-router'
                ? projectedConfig(value, llm, ownership)
                : value
            }
      }
      if (property === 'register') {
        const register = Reflect.get(target, property, target)
        return typeof register !== 'function'
          ? register
          : (namespace, ...rest) => {
              const scope = register.call(target, namespace, ...rest)
              return namespace === 'vision-router' ? scopeView(scope, llm, ownership) : scope
            }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function contextView(ctx, fallbackConfig, ownership) {
  const realLlm = ctx?.llm
  if (!ctx || typeof ctx !== 'object' || !realLlm || typeof realLlm !== 'object') return ctx
  let root
  const current = () => activeConfig(root ?? ctx, fallbackConfig)
  const llm = new Proxy(realLlm, {
    get(target, property) {
      if (property === 'registerAdapter') {
        const register = Reflect.get(target, property, target)
        return typeof register !== 'function'
          ? register
          : (routes, adapter) => {
              const normalized = (Array.isArray(routes) ? routes : [routes]).map(String)
              const handle = register.call(target, normalized, adapter)
              let held = new Set(normalized)
              ownership.add(held, adapter, current())
              const dispose = () => {
                try {
                  return handle()
                } finally {
                  ownership.remove(held)
                  held = new Set()
                }
              }
              if (typeof handle?.replace === 'function') {
                dispose.replace = (next) => {
                  const normalizedNext = Array.isArray(next) ? next.map(String) : []
                  handle.replace(normalizedNext)
                  ownership.remove(held)
                  held = new Set(normalizedNext)
                  ownership.add(held, adapter, current())
                }
              }
              return dispose
            }
      }
      if (property === 'listProviders') {
        const list = Reflect.get(target, property, target)
        return typeof list !== 'function'
          ? list
          : (...args) => {
              const providers = list.apply(target, args)
              if (!Array.isArray(providers)) return providers
              const wrapper = routeOf(current(), 'wrapperRoute', DEFAULT_WRAPPER_ROUTE)
              if (!hasRoute(target, wrapper) || ownership.owns(wrapper)) return providers
              return providers.filter((entry) => entry?.id !== wrapper)
            }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  const view = (target) => new Proxy(target, {
    get(object, property) {
      if (property === 'llm') return llm
      if (property === 'settings') {
        return settingsView(Reflect.get(object, property, object), llm, ownership)
      }
      if (property === 'get') {
        const get = Reflect.get(object, property, object)
        return typeof get !== 'function'
          ? get
          : (name, ...rest) => {
              if (name === 'llm') return llm
              const value = get.call(object, name, ...rest)
              return name === 'settings' ? settingsView(value, llm, ownership) : value
            }
      }
      if (property === 'inject') {
        const inject = Reflect.get(object, property, object)
        return typeof inject !== 'function'
          ? inject
          : (deps, callback, ...rest) => inject.call(
              object,
              deps,
              typeof callback === 'function' ? (scope) => callback(view(scope)) : callback,
              ...rest,
            )
      }
      const value = Reflect.get(object, property, object)
      return typeof value === 'function' ? value.bind(object) : value
    },
  })
  root = view(ctx)
  return root
}

const CLIENT_PRELUDE = String.raw`(function(){
  if (window.__dshVisionRouterRootHardening) return;
  var snapshot = { revision: 0, routes: new Map() };
  var listeners = new Set();
  var pending = new WeakMap();
  var recoveries = new WeakMap();
  var inFlight = null;
  var refreshedAt = 0;
  function emit(){ listeners.forEach(function(fn){ try { fn(); } catch (_) {} }); }
  function refresh(force){
    var now = Date.now();
    if (!force && now - refreshedAt < 250) return inFlight || Promise.resolve(snapshot);
    if (inFlight) return inFlight;
    var fetchImpl = window && typeof window.fetch === 'function' ? window.fetch.bind(window) : undefined;
    if (!fetchImpl) return Promise.resolve(snapshot);
    refreshedAt = now;
    inFlight = Promise.resolve(fetchImpl('${OWNERSHIP_PATH}', { credentials: 'same-origin', cache: 'no-store' }))
      .then(function(res){ if (!res || !res.ok) throw new Error('ownership unavailable'); return res.json(); })
      .then(function(value){
        var routes = new Map();
        if (value && Array.isArray(value.routes)) value.routes.forEach(function(entry){
          if (entry && typeof entry.provider === 'string' && typeof entry.source === 'string') routes.set(entry.provider, entry.source);
        });
        var revision = Number.isFinite(value && value.revision) ? value.revision : 0;
        var changed = revision !== snapshot.revision || JSON.stringify(Array.from(routes)) !== JSON.stringify(Array.from(snapshot.routes));
        snapshot = { revision: revision, routes: routes };
        if (changed) emit();
        return snapshot;
      }, function(){ return snapshot; })
      .finally(function(){ inFlight = null; });
    return inFlight;
  }
  function recoveryFor(directory){
    var state = recoveries.get(directory);
    if (state) return state;
    var error = null;
    var subs = new Set();
    state = {
      getSnapshot: function(){ return error; },
      subscribe: function(fn){ subs.add(fn); return function(){ subs.delete(fn); }; },
      fail: function(value){
        error = value instanceof Error ? value : new Error(String(value || 'model operation failed'));
        subs.forEach(function(fn){ try { fn(); } catch (_) {} });
      },
      clear: function(){
        if (error === null) return;
        error = null;
        subs.forEach(function(fn){ try { fn(); } catch (_) {} });
      }
    };
    recoveries.set(directory, state);
    return state;
  }
  function select(directory, selection){
    var key = JSON.stringify(selection || {});
    var held = pending.get(directory);
    if (held && held.key === key) return held.promise;
    var recovery = recoveryFor(directory);
    recovery.clear();
    var promise = Promise.resolve().then(function(){ return directory.select(selection); }).then(
      function(value){ recovery.clear(); return value; },
      function(error){ recovery.fail(error); throw error; }
    );
    pending.set(directory, { key: key, promise: promise });
    promise.finally(function(){
      var latest = pending.get(directory);
      if (latest && latest.promise === promise) pending.delete(directory);
    }).catch(function(){});
    return promise;
  }
  var api = {
    sourceFor: function(provider){ void refresh(false); return snapshot.routes.get(provider); },
    getSnapshot: function(){ return snapshot; },
    subscribe: function(fn){ listeners.add(fn); void refresh(true); return function(){ listeners.delete(fn); }; },
    refresh: refresh,
    recoveryFor: recoveryFor,
    select: select
  };
  Object.defineProperty(window, '__dshVisionRouterRootHardening', { value: api, configurable: false, writable: false });
  void refresh(true);
})();`

function replaceAll(source, before, after) {
  return source.includes(before) ? source.split(before).join(after) : source
}

export function hardenVisionToggleHtml(html) {
  if (typeof html !== 'string') return html
  let next = html

  next = replaceAll(
    next,
    `        var result = originalCreate.apply(this, arguments);\n        patchLoader(loader);\n        return result;`,
    `        var result = originalCreate.apply(this, arguments);\n        patchLoader(loader);\n        if (result && result !== loader) patchLoader(result);\n        return result;`,
  )

  next = replaceAll(
    next,
    `    if (window.__ModuleLoader__) {\n      patchLoader(window.__ModuleLoader__);\n      return;\n    }\n    var descriptor = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__');\n    if (descriptor && descriptor.configurable === false) return;\n    var stored;\n    Object.defineProperty(window, '__ModuleLoader__', {\n      configurable: true,\n      enumerable: true,\n      get: function(){ return stored; },\n      set: function(value) {\n        stored = value;\n        patchLoader(value);\n        Object.defineProperty(window, '__ModuleLoader__', {\n          configurable: true,\n          enumerable: true,\n          writable: true,\n          value: stored\n        });\n      }\n    });`,
    `    var descriptor = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__');\n    var stored = window.__ModuleLoader__;\n    if (stored) patchLoader(stored);\n    if (descriptor && descriptor.configurable === false) return;\n    Object.defineProperty(window, '__ModuleLoader__', {\n      configurable: true,\n      enumerable: true,\n      get: function(){ return stored; },\n      set: function(value) { stored = value; patchLoader(value); }\n    });`,
  )

  next = replaceAll(
    next,
    `    try {\n      if (Array.isArray(plugin.inject) && !plugin.inject.includes('settingsScope')) {\n        plugin.inject = plugin.inject.concat('settingsScope');\n      }\n    } catch (_) {}\n`,
    '',
  )

  next = replaceAll(
    next,
    `function visionModeOwnedTwin(groups, sourceProvider, twinProvider, modelId, config) {\n  if (twinProvider !== \`${'${sourceProvider}'}-vision\`) return false`,
    `function visionModeOwnedTwin(groups, sourceProvider, twinProvider, modelId, config) {\n  var ownership = window.__dshVisionRouterRootHardening;\n  if (!ownership || ownership.sourceFor(twinProvider) !== sourceProvider) return false;\n  if (twinProvider !== \`${'${sourceProvider}'}-vision\`) return false`,
  )

  next = replaceAll(
    next,
    `function visionModeWrapperRoute(groups, config, modelId) {\n  const configured = visionModeConfiguredWrapperRoute(config)`,
    `function visionModeWrapperRoute(groups, config, modelId) {\n  var ownership = window.__dshVisionRouterRootHardening;\n  if (ownership) {\n    var owned = Array.isArray(groups) ? groups.filter(function(group){ return group && ownership.sourceFor(group.id) === VISION_MODE_WRAPPER_SOURCE && visionModeHasModel(group, modelId); }) : [];\n    return owned.length === 1 ? owned[0].id : undefined;\n  }\n  const configured = visionModeConfiguredWrapperRoute(config)`,
  )

  next = replaceAll(
    next,
    `function visionModeOwnedWrapper(groups, wrapperRoute, modelId) {\n  if (typeof wrapperRoute !== 'string' || wrapperRoute === '') return false`,
    `function visionModeOwnedWrapper(groups, wrapperRoute, modelId) {\n  var ownership = window.__dshVisionRouterRootHardening;\n  if (!ownership || ownership.sourceFor(wrapperRoute) !== VISION_MODE_WRAPPER_SOURCE) return false;\n  if (typeof wrapperRoute !== 'string' || wrapperRoute === '') return false`,
  )

  next = replaceAll(
    next,
    `        var visionConfig = settingsState && settingsState.value && typeof settingsState.value === 'object'\n          ? settingsState.value\n          : {};\n        var pair = resolveVisionModePair(state.groups, state.current, visionConfig);`,
    `        var visionConfig = settingsState && settingsState.value && typeof settingsState.value === 'object'\n          ? settingsState.value\n          : {};\n        var rootHardening = window.__dshVisionRouterRootHardening;\n        if (rootHardening) React.useSyncExternalStore(rootHardening.subscribe, rootHardening.getSnapshot);\n        var recovery = rootHardening ? rootHardening.recoveryFor(directory) : undefined;\n        var recoveryError = recovery ? React.useSyncExternalStore(recovery.subscribe, recovery.getSnapshot) : null;\n        var pair = resolveVisionModePair(state.groups, state.current, visionConfig);`,
  )

  next = replaceAll(
    next,
    `        var busy = state.status === 'selecting';\n        var loading = state.status === 'idle' || state.status === 'loading';`,
    `        var busy = state.status === 'selecting' && !recoveryError;\n        var loading = (state.status === 'idle' || state.status === 'loading') && !recoveryError;`,
  )

  next = replaceAll(
    next,
    `          var message = latest && typeof latest.error === 'string' && latest.error !== ''\n            ? latest.error\n            : t('failedUnknown');`,
    `          var recovered = recovery && typeof recovery.getSnapshot === 'function' ? recovery.getSnapshot() : recoveryError;\n          var message = latest && typeof latest.error === 'string' && latest.error !== ''\n            ? latest.error\n            : recovered && recovered.message ? recovered.message : t('failedUnknown');`,
  )

  next = replaceAll(
    next,
    `                  try {\n                    return Promise.resolve(directory.select(selection)).then(\n                      function(){ return true; },\n                      function(){ return false; }\n                    );\n                  } catch (_) {\n                    return Promise.resolve(false);\n                  }`,
    `                  var hardening = window.__dshVisionRouterRootHardening;\n                  var operation;\n                  try { operation = hardening ? hardening.select(directory, selection) : Promise.resolve(directory.select(selection)); }\n                  catch (_) { return Promise.resolve(false); }\n                  return Promise.resolve(operation).then(function(){ return true; }, function(){ return false; });`,
  )

  next = replaceAll(
    next,
    `function visionPresentationSourceForGroup(groups, target, config) {\n  return visionPresentationConfiguredWrapperSource(groups, target, config) ??\n    visionPresentationGeneratedTwinSource(groups, target, config)\n}`,
    `function visionPresentationSourceForGroup(groups, target, config) {\n  var ownership = window.__dshVisionRouterRootHardening;\n  var sourceProvider = ownership && target ? ownership.sourceFor(target.id) : undefined;\n  if (!sourceProvider) return undefined;\n  var source = visionPresentationGroup(groups, sourceProvider);\n  return source && visionPresentationAllModelsMirrored(source, target) ? sourceProvider : undefined;\n}`,
  )

  next = replaceAll(next, `  if (!config || typeof config !== 'object') return hidden\n`, '')
  next = replaceAll(
    next,
    `  if (!config || typeof config !== 'object') return state\n\n  const sourceByHiddenProvider`,
    `\n  const sourceByHiddenProvider`,
  )
  next = replaceAll(
    next,
    `  if (!config || typeof config !== 'object') return selection\n  const current`,
    `  const current`,
  )

  next = replaceAll(next, `function wrapStore(store, settings) {`, `function wrapStore(store, settings, recovery) {`)
  next = replaceAll(
    next,
    `      var raw = typeof store.getSnapshot === 'function' ? store.getSnapshot() : undefined;\n      var config = currentVisionConfig(settings);`,
    `      var raw = typeof store.getSnapshot === 'function' ? store.getSnapshot() : undefined;\n      var recovered = recovery && typeof recovery.getSnapshot === 'function' ? recovery.getSnapshot() : null;\n      if (recovered && raw && (raw.status === 'selecting' || raw.status === 'loading')) {\n        raw = Object.assign({}, raw, { status: 'error', error: recovered.message || String(recovered) });\n      }\n      var config = currentVisionConfig(settings);`,
  )
  next = replaceAll(
    next,
    `        if (settings && typeof settings.subscribe === 'function') stops.push(settings.subscribe(listener));`,
    `        if (settings && typeof settings.subscribe === 'function') stops.push(settings.subscribe(listener));\n        if (recovery && typeof recovery.subscribe === 'function') stops.push(recovery.subscribe(listener));\n        var hardening = window.__dshVisionRouterRootHardening;\n        if (hardening) stops.push(hardening.subscribe(listener));`,
  )
  next = replaceAll(
    next,
    `    var store = wrapStore(directory.store, settings);`,
    `    var hardening = window.__dshVisionRouterRootHardening;\n    var recovery = hardening ? hardening.recoveryFor(directory) : undefined;\n    var store = wrapStore(directory.store, settings, recovery);`,
  )

  if (!next.includes(OWNERSHIP_MARK)) {
    const safe = CLIENT_PRELUDE.replace(/<\/script/gi, '<\\/script')
    const script = `<script ${OWNERSHIP_MARK}>${safe}</script>`
    const closeHead = next.indexOf('</head>')
    next = closeHead === -1
      ? `${next}${script}`
      : `${next.slice(0, closeHead)}${script}${next.slice(closeHead)}`
  }
  return next
}

function sendSnapshot(res, ownership) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(ownership.snapshot()))
}

export function createVisionToggleRootHardening(ctx, config = {}) {
  const ownership = createOwnership()
  const hardenedCtx = contextView(ctx, config, ownership)
  return {
    ctx: hardenedCtx,
    config: projectedConfig(config, ctx?.llm, ownership),
    ownership,
    installClientBoundary() {
      hardenedCtx?.inject?.(['webServer'], (webCtx) => {
        webCtx.effect(
          () => webCtx.webServer.register({
            kind: 'exact',
            path: OWNERSHIP_PATH,
            handler(req, res) {
              if (req.method !== 'GET') {
                res.setHeader('Allow', 'GET')
                res.writeHead(405)
                res.end()
                return
              }
              sendSnapshot(res, ownership)
            },
          }),
          'vision-router: route ownership',
        )
        webCtx.effect(
          () => webCtx.webServer.tapIndex(hardenVisionToggleHtml),
          'vision-router: vision toggle root hardening',
        )
      })
    },
  }
}
