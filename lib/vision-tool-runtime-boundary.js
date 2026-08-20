import { AsyncLocalStorage } from 'node:async_hooks'
import {
  currentVisionTurnBudget,
  runWithVisionTurnBudget,
} from './turn-budget-context.js'

const toolRuntime = new AsyncLocalStorage()
const wrappedContexts = new WeakMap()
const wrappedFileSystems = new WeakMap()
const wrappedSettings = new WeakMap()
const wrappedScopes = new WeakMap()

function usableSignal(value) {
  return value && typeof value === 'object' && typeof value.aborted === 'boolean' ? value : undefined
}

function combineSignals(...signals) {
  const list = signals.map(usableSignal).filter(Boolean)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  return AbortSignal.any(list)
}

function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

function imageCount(args) {
  const paths = Array.isArray(args?.paths) ? args.paths.length : 0
  const attachments = Array.isArray(args?.attachmentIds) ? args.attachmentIds.length : 0
  return paths + attachments
}

function stateFor(name, args, exec) {
  return {
    cwd: sessionCwd(exec),
    signal: usableSignal(exec?.signal),
    // Core v1.7.x sorts content ids before building its cache key. Until that
    // internal key can carry order explicitly, multi-image calls must bypass
    // the cache so [A,B] and [B,A] can never alias.
    disableCache: name === 'vision_describe' && imageCount(args) > 1,
  }
}

function withMergedTurnSignal(signal, execute) {
  const ambient = currentVisionTurnBudget()
  const combined = combineSignals(ambient?.signal, signal)
  if (!combined) return execute()
  const next = ambient && typeof ambient === 'object'
    ? { ...ambient, signal: combined }
    : { signal: combined }
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
          if (cwd === undefined && signal === undefined && source === undefined) {
            return resolve.call(target, value)
          }
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

function projectLiveSettings(value) {
  const state = toolRuntime.getStore()
  if (!state?.disableCache || !value || typeof value !== 'object' || Array.isArray(value)) return value
  if (value.cache === false) return value
  return { ...value, cache: false }
}

function wrapSettingsScope(scope) {
  if (!scope || (typeof scope !== 'object' && typeof scope !== 'function')) return scope
  const cached = wrappedScopes.get(scope)
  if (cached) return cached
  const wrapped = new Proxy(scope, {
    get(target, property) {
      if (property === 'get') {
        const get = Reflect.get(target, property, target)
        if (typeof get !== 'function') return get
        return (...args) => projectLiveSettings(get.apply(target, args))
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  wrappedScopes.set(scope, wrapped)
  return wrapped
}

function wrapSettingsService(settings) {
  if (!settings || (typeof settings !== 'object' && typeof settings !== 'function')) return settings
  const cached = wrappedSettings.get(settings)
  if (cached) return cached
  const wrapped = new Proxy(settings, {
    get(target, property) {
      if (property === 'register') {
        const register = Reflect.get(target, property, target)
        if (typeof register !== 'function') return register
        return (namespace, ...args) => {
          const scope = register.call(target, namespace, ...args)
          return namespace === 'vision-router' ? wrapSettingsScope(scope) : scope
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  wrappedSettings.set(settings, wrapped)
  return wrapped
}

function wrapInjectedContext(ctx) {
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return ctx
  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'settings') return wrapSettingsService(Reflect.get(target, property, target))
      if (property === 'fs') return wrapFileSystem(Reflect.get(target, property, target))
      if (property === 'get') {
        const get = Reflect.get(target, property, target)
        if (typeof get !== 'function') return get
        return (name, ...args) => {
          const value = get.call(target, name, ...args)
          return name === 'fs' ? wrapFileSystem(value) : value
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function wrapTools(tools) {
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
          async execute(args, exec) {
            const state = stateFor(def.name, args, exec)
            return toolRuntime.run(
              state,
              () => withMergedTurnSignal(state.signal, () => execute(args, exec)),
            )
          },
        })
      }
    },
  })
}

/**
 * Runtime seam for all Vision Router tools.
 *
 * - Relative fs paths resolve against the active session cwd, including the
 *   secure HTML renderer's second lookup.
 * - exec.signal is inherited by fs reads and ImageResourceGovernor waits even
 *   when older core helpers omit it explicitly.
 * - multi-image vision_describe bypasses the legacy order-insensitive cache.
 */
export function installVisionToolRuntimeBoundary(ctx) {
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return ctx
  const cached = wrappedContexts.get(ctx)
  if (cached) return cached
  let wrapped
  wrapped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') return wrapTools(Reflect.get(target, property, target))
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
          if (typeof callback !== 'function') return inject.call(target, dependencies, callback, ...rest)
          return inject.call(
            target,
            dependencies,
            (childCtx) => callback(wrapInjectedContext(childCtx)),
            ...rest,
          )
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  wrappedContexts.set(ctx, wrapped)
  return wrapped
}
