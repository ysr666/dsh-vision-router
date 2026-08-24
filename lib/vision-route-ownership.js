const DEFAULT_WRAPPER_ROUTE = 'deepseek-vision'
const DEFAULT_CHAIN_ROUTE = 'vision-chain'
const WRAPPER_SOURCE = 'deepseek-official'
const AUTO_VISION_SUFFIX = ' + 自动识图'
const GENERATED_SUFFIX = '-vision'

export const VISION_ROUTE_OWNERSHIP_PATH = '/_dsh/vision-router/route-ownership'
const OWNERSHIP_MARK = 'data-vision-router-route-ownership'

function nonEmpty(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function activeVisionConfig(ctx, fallbackConfig = {}) {
  try {
    const settings = ctx?.get?.('settings')
    const current = settings?.get?.('vision-router')
    if (current && typeof current === 'object' && !Array.isArray(current)) return current
  } catch {
    // Settings can be unavailable during early composition startup.
  }
  return fallbackConfig && typeof fallbackConfig === 'object' ? fallbackConfig : {}
}

function routeIsRegistered(llm, route) {
  if (!llm || typeof route !== 'string' || route === '') return false
  try {
    if (typeof llm.registration === 'function') {
      llm.registration(route)
      return true
    }
  } catch {
    return false
  }
  try {
    const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    return Array.isArray(providers) && providers.some((entry) => entry?.id === route)
  } catch {
    return false
  }
}

function wrapperSourceForRegistration(adapter, route, config) {
  if (!adapter || typeof route !== 'string' || route === '') return undefined
  let info
  try {
    info = typeof adapter.providerInfo === 'function' ? adapter.providerInfo(route) : undefined
  } catch {
    info = undefined
  }
  const name = typeof info?.name === 'string' ? info.name : ''
  if (!name.endsWith(AUTO_VISION_SUFFIX)) return undefined

  const mainWrapper = nonEmpty(config?.wrapperRoute, DEFAULT_WRAPPER_ROUTE)
  if (route === mainWrapper) return WRAPPER_SOURCE
  if (!route.endsWith(GENERATED_SUFFIX)) return undefined
  const source = route.slice(0, -GENERATED_SUFFIX.length)
  if (!source || source.endsWith(GENERATED_SUFFIX)) return undefined
  return source
}

/**
 * Process-local ownership facts derived only from successful llm.registerAdapter
 * commits performed through this plugin instance. Human-facing route names,
 * model catalogs and user settings never establish ownership by themselves.
 */
export function createVisionRouteOwnership() {
  const allRoutes = new Set()
  const wrappers = new Map()
  let revision = 0

  const changed = () => { revision += 1 }
  const removeRoutes = (routes) => {
    let dirty = false
    for (const route of routes) {
      if (allRoutes.delete(route)) dirty = true
      if (wrappers.delete(route)) dirty = true
    }
    if (dirty) changed()
  }
  const addRoutes = (routes, adapter, config) => {
    let dirty = false
    for (const route of routes) {
      if (!allRoutes.has(route)) {
        allRoutes.add(route)
        dirty = true
      }
      const source = wrapperSourceForRegistration(adapter, route, config)
      if (source !== undefined && wrappers.get(route) !== source) {
        wrappers.set(route, source)
        dirty = true
      }
    }
    if (dirty) changed()
  }

  return {
    owns(route) {
      return allRoutes.has(route)
    },
    sourceFor(route) {
      return wrappers.get(route)
    },
    snapshot() {
      return {
        revision,
        routes: [...wrappers.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([provider, source]) => ({ provider, source })),
      }
    },
    track(routes, adapter, handle, config) {
      let held = new Set(routes)
      addRoutes(held, adapter, config)
      let disposed = false
      const wrapped = () => {
        if (disposed) return
        disposed = true
        try {
          handle()
        } finally {
          removeRoutes(held)
          held = new Set()
        }
      }
      if (typeof handle?.replace === 'function') {
        wrapped.replace = (next) => {
          if (disposed) return handle.replace(next)
          const normalized = Array.isArray(next) ? next.map(String) : []
          handle.replace(normalized)
          removeRoutes(held)
          held = new Set(normalized)
          addRoutes(held, adapter, config)
        }
      }
      return wrapped
    },
  }
}

function projectedVisionConfig(value, llm, ownership) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  let changed = false
  const overrides = {}
  for (const [key, fallback] of [
    ['wrapperRoute', DEFAULT_WRAPPER_ROUTE],
    ['chainRoute', DEFAULT_CHAIN_ROUTE],
  ]) {
    const route = nonEmpty(value[key], fallback)
    if (route && routeIsRegistered(llm, route) && !ownership.owns(route)) {
      overrides[key] = ''
      changed = true
    }
  }
  return changed ? { ...value, ...overrides } : value
}

function scopeView(scope, llm, ownership) {
  if (!scope || typeof scope !== 'object') return scope
  return new Proxy(scope, {
    get(target, property) {
      if (property === 'get') {
        const get = Reflect.get(target, property, target)
        if (typeof get !== 'function') return get
        return (...args) => projectedVisionConfig(get.apply(target, args), llm, ownership)
      }
      if (property === 'watch') {
        const watch = Reflect.get(target, property, target)
        if (typeof watch !== 'function') return watch
        return (callback, ...rest) => watch.call(target, (value, ...tail) => {
          if (typeof callback !== 'function') return undefined
          return callback(projectedVisionConfig(value, llm, ownership), ...tail)
        }, ...rest)
      }
      const result = Reflect.get(target, property, target)
      return typeof result === 'function' ? result.bind(target) : result
    },
  })
}

function settingsView(settings, llm, ownership) {
  if (!settings || typeof settings !== 'object') return settings
  return new Proxy(settings, {
    get(target, property) {
      if (property === 'get') {
        const get = Reflect.get(target, property, target)
        if (typeof get !== 'function') return get
        return (namespace, ...rest) => {
          const value = get.call(target, namespace, ...rest)
          return namespace === 'vision-router'
            ? projectedVisionConfig(value, llm, ownership)
            : value
        }
      }
      if (property === 'register') {
        const register = Reflect.get(target, property, target)
        if (typeof register !== 'function') return register
        return (namespace, ...rest) => {
          const scope = register.call(target, namespace, ...rest)
          return namespace === 'vision-router' ? scopeView(scope, llm, ownership) : scope
        }
      }
      const result = Reflect.get(target, property, target)
      return typeof result === 'function' ? result.bind(target) : result
    },
  })
}

/**
 * Narrow public-entry boundary around the monolithic legacy core.
 *
 * - successful adapter registrations become the only ownership authority;
 * - a wrapper/chain route already owned by another adapter is projected as
 *   disabled to the core, so its historical DUPLICATE_ADAPTER "adoption" path
 *   is unreachable without changing unrelated routing code;
 * - when the conflicting route later disappears, the next settings/topology
 *   sync sees the real configured route again and can claim it normally.
 */
export function contextWithVisionRouteOwnership(ctx, fallbackConfig, ownership = createVisionRouteOwnership()) {
  if (!ctx || typeof ctx !== 'object' || !ctx.llm || typeof ctx.llm !== 'object') {
    return { ctx, config: fallbackConfig, ownership }
  }
  const targetLlm = ctx.llm
  let rootCtx
  const configNow = () => activeVisionConfig(rootCtx ?? ctx, fallbackConfig)
  const llm = new Proxy(targetLlm, {
    get(target, property) {
      if (property === 'registerAdapter') {
        const register = Reflect.get(target, property, target)
        if (typeof register !== 'function') return register
        return (routes, adapter) => {
          const normalized = (Array.isArray(routes) ? routes : [routes]).map(String)
          const config = configNow()
          const handle = register.call(target, normalized, adapter)
          return ownership.track(normalized, adapter, handle, config)
        }
      }
      const result = Reflect.get(target, property, target)
      return typeof result === 'function' ? result.bind(target) : result
    },
  })

  const view = (target) => {
    if (!target || typeof target !== 'object') return target
    const settings = settingsView(target.settings, llm, ownership)
    return new Proxy(target, {
      get(object, property) {
        if (property === 'llm') return llm
        if (property === 'settings') return settings
        if (property === 'get') {
          const get = Reflect.get(object, property, object)
          if (typeof get !== 'function') return get
          return (name, ...rest) => {
            if (name === 'llm') return llm
            const value = get.call(object, name, ...rest)
            if (name === 'settings') return settingsView(value, llm, ownership)
            return value
          }
        }
        if (property === 'inject') {
          const inject = Reflect.get(object, property, object)
          if (typeof inject !== 'function') return inject
          return (dependencies, callback, ...rest) => inject.call(
            object,
            dependencies,
            typeof callback === 'function' ? (scope) => callback(view(scope)) : callback,
            ...rest,
          )
        }
        const result = Reflect.get(object, property, object)
        return typeof result === 'function' ? result.bind(object) : result
      },
    })
  }

  rootCtx = view(ctx)
  return {
    ctx: rootCtx,
    config: projectedVisionConfig(fallbackConfig, llm, ownership),
    ownership,
  }
}

function sendOwnership(res, ownership) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(ownership.snapshot()))
}

export const VISION_ROUTE_OWNERSHIP_PRELUDE = String.raw`(function(){
  'use strict';
  if (window.__dshVisionRouterRouteOwnership) return;
  var PATH = '${VISION_ROUTE_OWNERSHIP_PATH}';
  var snapshot = Object.freeze({ available: false, revision: 0, routes: Object.freeze([]) });
  var listeners = new Set();
  var inFlight = null;
  var lastRefreshAt = 0;
  var recoveries = typeof WeakMap === 'function' ? new WeakMap() : null;

  function normalize(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.routes)) return snapshot;
    var routes = value.routes.filter(function(entry){
      return entry && typeof entry.provider === 'string' && entry.provider !== '' &&
        typeof entry.source === 'string' && entry.source !== '';
    }).map(function(entry){ return Object.freeze({ provider: entry.provider, source: entry.source }); });
    return Object.freeze({
      available: true,
      revision: Number.isFinite(value.revision) ? value.revision : 0,
      routes: Object.freeze(routes)
    });
  }

  function emit() {
    listeners.forEach(function(listener){
      try { listener(); } catch (_) {}
    });
  }

  function refresh(force) {
    var now = Date.now();
    if (!force && now - lastRefreshAt < 250) return Promise.resolve(snapshot);
    if (inFlight) return inFlight;
    var fetchImpl = window && typeof window.fetch === 'function' ? window.fetch.bind(window) : undefined;
    if (!fetchImpl) return Promise.resolve(snapshot);
    lastRefreshAt = now;
    inFlight = Promise.resolve(fetchImpl(PATH, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' }
    })).then(function(response){
      if (!response || response.ok !== true || typeof response.json !== 'function') throw new Error('ownership unavailable');
      return response.json();
    }).then(function(value){
      var next = normalize(value);
      var changed = next.available !== snapshot.available ||
        next.revision !== snapshot.revision ||
        JSON.stringify(next.routes) !== JSON.stringify(snapshot.routes);
      snapshot = next;
      if (changed) emit();
      return snapshot;
    }, function(){ return snapshot; }).finally(function(){ inFlight = null; });
    return inFlight;
  }

  function sourceFor(provider) {
    for (var i = 0; i < snapshot.routes.length; i++) {
      if (snapshot.routes[i].provider === provider) return snapshot.routes[i].source;
    }
    return undefined;
  }

  function recoveryFor(directory) {
    if (!recoveries || !directory || (typeof directory !== 'object' && typeof directory !== 'function')) return undefined;
    var existing = recoveries.get(directory);
    if (existing) return existing;
    var error = null;
    var recoveryListeners = new Set();
    var state = {
      getSnapshot: function(){ return error; },
      subscribe: function(listener){ recoveryListeners.add(listener); return function(){ recoveryListeners.delete(listener); }; },
      fail: function(value){
        error = value instanceof Error ? value : new Error(value && value.message ? value.message : String(value || 'model operation failed'));
        recoveryListeners.forEach(function(listener){ try { listener(); } catch (_) {} });
      },
      clear: function(){
        if (error === null) return;
        error = null;
        recoveryListeners.forEach(function(listener){ try { listener(); } catch (_) {} });
      }
    };
    recoveries.set(directory, state);
    return state;
  }

  var api = Object.freeze({
    getSnapshot: function(){ return snapshot; },
    subscribe: function(listener){
      listeners.add(listener);
      void refresh(true);
      return function(){ listeners.delete(listener); };
    },
    refresh: refresh,
    sourceFor: sourceFor,
    recoveryFor: recoveryFor
  });
  Object.defineProperty(window, '__dshVisionRouterRouteOwnership', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: api
  });
  void refresh(true);
})();`

export function injectVisionRouteOwnershipBoundary(html) {
  if (typeof html !== 'string' || html.includes(OWNERSHIP_MARK)) return html
  const safe = VISION_ROUTE_OWNERSHIP_PRELUDE.replace(/<\/script/gi, '<\\/script')
  const script = `<script ${OWNERSHIP_MARK}>${safe}</script>`
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installVisionRouteOwnershipBoundary(ctx, ownership) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: VISION_ROUTE_OWNERSHIP_PATH,
      handler(req, res) {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET')
          res.writeHead(405)
          res.end()
          return
        }
        sendOwnership(res, ownership)
      },
    }), 'vision-router: wrapper route ownership endpoint')
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectVisionRouteOwnershipBoundary),
      'vision-router: wrapper route ownership client',
    )
  })
}
