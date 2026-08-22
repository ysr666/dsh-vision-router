import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  currentVisionTurnBudget,
  runWithVisionTurnBudget,
} from './turn-budget-context.js'
import {
  describeCacheKey,
  HttpEndpointRevisionTracker,
  LiveDescribeCache,
  ProxyDispatcherTracker,
  proxyRequestIsManaged,
} from './runtime-reliability.js'

const toolRuntime = new AsyncLocalStorage()
const wrappedContexts = new WeakMap()
const runtimeStates = new WeakMap()
const wrappedFileSystems = new WeakMap()
const wrappedSettings = new WeakMap()
const wrappedScopes = new WeakMap()
const wrappedLlms = new WeakMap()
const wrappedAdapters = new WeakMap()

function usableSignal(value) {
  return value && typeof value === 'object' && typeof value.aborted === 'boolean' ? value : undefined
}

function combineSignals(...signals) {
  const list = signals.map(usableSignal).filter(Boolean)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  return AbortSignal.any(list)
}

function toolAbortError() {
  const error = new Error('vision tool execution aborted')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

function toolDisabledError(name) {
  const error = new Error(`${name}: vision tools are disabled in the Vision Router settings`)
  error.code = 'VISION_TOOLS_DISABLED'
  return error
}

async function executeAbortable(signal, execute) {
  if (!signal) return execute()
  if (signal.aborted) throw toolAbortError()
  let abortHandler
  const aborted = new Promise((_, reject) => {
    abortHandler = () => reject(toolAbortError())
    signal.addEventListener('abort', abortHandler, { once: true })
  })
  try {
    return await Promise.race([Promise.resolve().then(execute), aborted])
  } finally {
    if (abortHandler) signal.removeEventListener('abort', abortHandler)
  }
}

function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

function stableRuntimeConfigSignature(value) {
  if (!value || typeof value !== 'object') return '{}'
  try {
    return JSON.stringify({
      cache: value.cache,
      cacheMaxEntries: value.cacheMaxEntries,
      cacheTtlSeconds: value.cacheTtlSeconds,
      httpProviders: value.httpProviders,
      proxy: value.proxy,
      proxyHosts: value.proxyHosts,
    })
  } catch {
    return String(Date.now())
  }
}

function createRuntimeState(initialConfig = {}) {
  const cache = new LiveDescribeCache()
  const endpoints = new HttpEndpointRevisionTracker()
  const proxyDispatchers = new ProxyDispatcherTracker()
  let config = {
    cache: true,
    cacheMaxEntries: 200,
    cacheTtlSeconds: 3600,
    httpProviders: [],
    proxy: '',
    proxyHosts: [],
    ...(initialConfig && typeof initialConfig === 'object' && !Array.isArray(initialConfig)
      ? initialConfig
      : {}),
  }
  let signature = stableRuntimeConfigSignature(config)
  let revision = 0

  const noteConfig = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return config
    const nextSignature = stableRuntimeConfigSignature(value)
    if (nextSignature !== signature) {
      signature = nextSignature
      revision += 1
      cache.clear()
    }
    config = value
    cache.reconfigure({
      maxEntries: Number(value.cacheMaxEntries),
      ttlMs: Number(value.cacheTtlSeconds) * 1000,
    })
    endpoints.project(value.httpProviders)
    return config
  }

  return {
    cache,
    endpoints,
    proxyDispatchers,
    noteConfig,
    config: () => config,
    revision: () => revision,
  }
}

function stateFor(name, exec) {
  return {
    name,
    cwd: sessionCwd(exec),
    signal: usableSignal(exec?.signal),
    artifactRunId: `.vision-run-${Date.now().toString(36)}-${randomUUID()}`,
    disableCoreCache: name === 'vision_describe',
  }
}

function withMergedTurnSignal(state, execute) {
  const ambient = currentVisionTurnBudget()
  const combined = combineSignals(ambient?.signal, state.signal)
  const next = ambient && typeof ambient === 'object'
    ? { ...ambient, artifactRunId: state.artifactRunId }
    : { artifactRunId: state.artifactRunId }
  if (combined) next.signal = combined
  return runWithVisionTurnBudget(next, execute)
}

function wrapFileSystem(fs) {
  if (!fs || (typeof fs !== 'object' && typeof fs !== 'function')) return fs
  const cached = wrappedFileSystems.get(fs)
  if (cached) return cached
  const wrapped = new Proxy(fs, {
    get(target, property) {
      if (property === 'resolve') {
        const resolve = Reflect.get(target, property, target)
        if (typeof resolve !== 'function') return resolve
        return (value, options) => {
          const state = toolRuntime.getStore()
          const source = options && typeof options === 'object' ? options : undefined
          const cwd = source?.cwd ?? state?.cwd
          const signal = combineSignals(source?.signal, state?.signal)
          if (cwd === undefined && signal === undefined && source === undefined) return resolve.call(target, value)
          return resolve.call(target, value, {
            ...(source ?? {}),
            ...(cwd === undefined ? {} : { cwd }),
            ...(signal === undefined ? {} : { signal }),
          })
        }
      }
      if (property === 'readBytes') {
        const readBytes = Reflect.get(target, property, target)
        if (typeof readBytes !== 'function') return readBytes
        return (targetRef, signal, maxBytes) => {
          const state = toolRuntime.getStore()
          return readBytes.call(target, targetRef, combineSignals(signal, state?.signal), maxBytes)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  wrappedFileSystems.set(fs, wrapped)
  return wrapped
}

function projectLiveSettings(value, runtimeState) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  runtimeState.noteConfig(value)
  const toolState = toolRuntime.getStore()
  const httpProviders = runtimeState.endpoints.project(value.httpProviders)
  const suppressCoreCache = toolState?.disableCoreCache === true && value.cache !== false
  if (httpProviders === value.httpProviders && !suppressCoreCache) return value
  return {
    ...value,
    ...(httpProviders === value.httpProviders ? {} : { httpProviders }),
    ...(suppressCoreCache ? { cache: false } : {}),
  }
}

function wrapSettingsScope(scope, runtimeState) {
  if (!scope || (typeof scope !== 'object' && typeof scope !== 'function')) return scope
  let byRuntime = wrappedScopes.get(scope)
  if (!byRuntime) {
    byRuntime = new WeakMap()
    wrappedScopes.set(scope, byRuntime)
  }
  const cached = byRuntime.get(runtimeState)
  if (cached) return cached
  const wrapped = new Proxy(scope, {
    get(target, property) {
      if (property === 'get') {
        const get = Reflect.get(target, property, target)
        if (typeof get !== 'function') return get
        return (...args) => projectLiveSettings(get.apply(target, args), runtimeState)
      }
      if (property === 'watch') {
        const watch = Reflect.get(target, property, target)
        if (typeof watch !== 'function') return watch
        return (callback, ...rest) => watch.call(target, (...args) => {
          try {
            const get = Reflect.get(target, 'get', target)
            if (typeof get === 'function') runtimeState.noteConfig(get.call(target))
          } catch {
            // Diagnostics refresh is best effort.
          }
          return typeof callback === 'function' ? callback(...args) : undefined
        }, ...rest)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  byRuntime.set(runtimeState, wrapped)
  return wrapped
}

function wrapSettingsService(settings, runtimeState) {
  if (!settings || (typeof settings !== 'object' && typeof settings !== 'function')) return settings
  let byRuntime = wrappedSettings.get(settings)
  if (!byRuntime) {
    byRuntime = new WeakMap()
    wrappedSettings.set(settings, byRuntime)
  }
  const cached = byRuntime.get(runtimeState)
  if (cached) return cached
  const wrapped = new Proxy(settings, {
    get(target, property) {
      if (property === 'register') {
        const register = Reflect.get(target, property, target)
        if (typeof register !== 'function') return register
        return (namespace, ...args) => {
          const scope = register.call(target, namespace, ...args)
          if (namespace !== 'vision-router') return scope
          try {
            if (typeof scope?.get === 'function') runtimeState.noteConfig(scope.get())
          } catch {
            // Core can still run from boot config if settings are late.
          }
          return wrapSettingsScope(scope, runtimeState)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  byRuntime.set(runtimeState, wrapped)
  return wrapped
}

function wrapSettingsContext(ctx, runtimeState) {
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function') || !ctx.settings) return ctx
  const settings = wrapSettingsService(ctx.settings, runtimeState)
  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'settings') return settings
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function wrapVisionHttpAdapter(adapter, runtimeState) {
  if (!adapter || (typeof adapter !== 'object' && typeof adapter !== 'function')) return adapter
  let byRuntime = wrappedAdapters.get(adapter)
  if (!byRuntime) {
    byRuntime = new WeakMap()
    wrappedAdapters.set(adapter, byRuntime)
  }
  const cached = byRuntime.get(runtimeState)
  if (cached) return cached
  const wrapped = new Proxy(adapter, {
    get(target, property) {
      if (property !== 'stream') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const stream = Reflect.get(target, property, target)
      if (typeof stream !== 'function') return stream
      return async function* streamWithEndpointAlias(options) {
        const mapped = runtimeState.endpoints.mapModelId(options?.model)
        const next = mapped === options?.model ? options : { ...(options ?? {}), model: mapped }
        for await (const chunk of stream.call(target, next)) yield chunk
      }
    },
  })
  byRuntime.set(runtimeState, wrapped)
  return wrapped
}

function wrapLlm(llm, runtimeState) {
  if (!llm || (typeof llm !== 'object' && typeof llm !== 'function')) return llm
  let byRuntime = wrappedLlms.get(llm)
  if (!byRuntime) {
    byRuntime = new WeakMap()
    wrappedLlms.set(llm, byRuntime)
  }
  const cached = byRuntime.get(runtimeState)
  if (cached) return cached
  const wrapped = new Proxy(llm, {
    get(target, property) {
      if (property === 'registerAdapter') {
        const register = Reflect.get(target, property, target)
        if (typeof register !== 'function') return register
        return (routes, adapter, ...rest) => {
          const list = Array.isArray(routes) ? routes : [routes]
          const nextAdapter = list.some((route) => String(route) === 'vision-http')
            ? wrapVisionHttpAdapter(adapter, runtimeState)
            : adapter
          return register.call(target, routes, nextAdapter, ...rest)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  byRuntime.set(runtimeState, wrapped)
  return wrapped
}

async function executeVisionTool(def, args, exec, execute, wrappedCtx, runtimeState) {
  const liveConfig = runtimeState.config()
  if (liveConfig?.tool === false) throw toolDisabledError(def.name)

  const state = stateFor(def.name, exec)
  return toolRuntime.run(state, () => withMergedTurnSignal(state, () =>
    executeAbortable(state.signal, async () => {
      if (def.name !== 'vision_describe') return execute(args, exec)
      const currentConfig = runtimeState.config()
      let cacheKey
      if (currentConfig.cache !== false) {
        try {
          cacheKey = await describeCacheKey(wrappedCtx, args, exec, runtimeState.revision())
          if (cacheKey) {
            const hit = runtimeState.cache.get(cacheKey)
            if (hit !== undefined) return hit
          }
        } catch {
          cacheKey = undefined
        }
      }
      const result = await execute(args, exec)
      if (cacheKey && runtimeState.config().cache !== false && !state.signal?.aborted) {
        runtimeState.cache.set(cacheKey, result)
      }
      return result
    }),
  ))
}

function wrapTools(tools, wrappedCtx, runtimeState) {
  if (!tools || (typeof tools !== 'object' && typeof tools !== 'function')) return tools
  return new Proxy(tools, {
    get(target, property) {
      if (property !== 'register') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const register = Reflect.get(target, property, target)
      if (typeof register !== 'function') return register
      return (def) => {
        if (!def || typeof def.name !== 'string' || !def.name.startsWith('vision_') || typeof def.execute !== 'function') {
          return register.call(target, def)
        }
        const execute = def.execute
        return register.call(target, {
          ...def,
          execute(args, exec) {
            return executeVisionTool(def, args, exec, execute, wrappedCtx, runtimeState)
          },
        })
      }
    },
  })
}

function installProxyDispatcherLifecycle(ctx, runtimeState) {
  if (!ctx || typeof ctx.effect !== 'function' || typeof globalThis.fetch !== 'function') return
  ctx.effect(() => {
    const originalFetch = globalThis.fetch
    let active = true
    const managedFetch = (input, init) => {
      if (active && init?.dispatcher && proxyRequestIsManaged(input, runtimeState.config())) {
        runtimeState.proxyDispatchers.observe(init.dispatcher)
      }
      return originalFetch(input, init)
    }
    globalThis.fetch = managedFetch
    return () => {
      active = false
      runtimeState.proxyDispatchers.dispose()
      if (globalThis.fetch === managedFetch) globalThis.fetch = originalFetch
    }
  }, 'vision-router: proxy dispatcher lifecycle')
}

export function installVisionToolRuntimeBoundary(ctx, initialConfig = {}) {
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return ctx
  const cached = wrappedContexts.get(ctx)
  if (cached) return cached

  const runtimeState = createRuntimeState(initialConfig)
  let wrapped
  wrapped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') return wrapTools(Reflect.get(target, property, target), wrapped, runtimeState)
      if (property === 'llm') return wrapLlm(Reflect.get(target, property, target), runtimeState)
      if (property === 'fs') return wrapFileSystem(Reflect.get(target, property, target))
      if (property === 'get') {
        const get = Reflect.get(target, property, target)
        if (typeof get !== 'function') return get
        return (name, ...args) => {
          const value = get.call(target, name, ...args)
          return name === 'fs' ? wrapFileSystem(value) : value
        }
      }
      if (property === 'inject') {
        const inject = Reflect.get(target, property, target)
        if (typeof inject !== 'function') return inject
        return (dependencies, callback, ...rest) => {
          if (!Array.isArray(dependencies) || !dependencies.includes('settings') || typeof callback !== 'function') {
            return inject.call(target, dependencies, callback, ...rest)
          }
          return inject.call(target, dependencies, (childCtx) => callback(wrapSettingsContext(childCtx, runtimeState)), ...rest)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  wrappedContexts.set(ctx, wrapped)
  runtimeStates.set(wrapped, runtimeState)
  installProxyDispatcherLifecycle(wrapped, runtimeState)
  return wrapped
}

export function getVisionToolRuntimeState(ctx) {
  return runtimeStates.get(ctx)
}
