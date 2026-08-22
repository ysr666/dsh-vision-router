import {
  IMAGE_OWNERSHIP,
  currentSessionVisionPolicy,
} from './native-image-coexistence.js'
import { knownSessionVisionMemory } from './session-vision-state.js'

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function projectedConfig(value, state) {
  if (!isObject(value) || Array.isArray(value)) return value
  const policy = currentSessionVisionPolicy()
  let changed = false
  const overrides = {}

  // index.js still constructs the vision-tool definitions behind a boot-time
  // `if (toolEnabled())`. Keep that legacy construction gate open only while
  // apply() is wiring the schema. The runtime boundary observes the unprojected
  // Settings service and remains authoritative for live execution permission.
  if (state.schemaBootstrapping && value.tool === false) {
    overrides.tool = true
    changed = true
  }

  // Session ownership is stronger evidence than index.js's historical global
  // wrapperRegistered flag. A native, Vision-Router-owned, or metadata-unknown
  // route must not have raw pixels destructively rewritten by the legacy core.
  if (policy?.preserveRawImages === true && value.rewriteImages !== false) {
    overrides.rewriteImages = false
    changed = true
  }

  // Native multimodal routes already see the pixels. Avoid the hidden local
  // caption pass and the generic tool auto-mount reminder, while leaving the
  // explicit structured 1+x flow untouched.
  if (policy?.ownership === IMAGE_OWNERSHIP.NATIVE) {
    if (value.instantDescribe !== false) {
      overrides.instantDescribe = false
      changed = true
    }
    if (value.autoActivateOnImage !== false) {
      overrides.autoActivateOnImage = false
      changed = true
    }
  }

  return changed ? { ...value, ...overrides } : value
}

function configView(config, state) {
  if (!isObject(config)) return config
  // Do not use the caller's config as the Proxy target. DSH or a test Host may
  // freeze parsed config objects; projecting tool/rewrite values through a
  // frozen target would violate Proxy invariants for non-configurable,
  // non-writable properties. An empty extensible facade keeps projection
  // virtual while writes/deletes still forward to the original object.
  return new Proxy({}, {
    get(_target, property) {
      const projected = projectedConfig(config, state)
      const value = Reflect.get(projected, property, projected)
      return typeof value === 'function' ? value.bind(projected) : value
    },
    has(_target, property) {
      return property in projectedConfig(config, state)
    },
    ownKeys() {
      return Reflect.ownKeys(projectedConfig(config, state))
    },
    getOwnPropertyDescriptor(_target, property) {
      const projected = projectedConfig(config, state)
      const descriptor = Object.getOwnPropertyDescriptor(projected, property)
      return descriptor === undefined
        ? undefined
        : { ...descriptor, configurable: true }
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(config)
    },
    set(_target, property, value) {
      return Reflect.set(config, property, value, config)
    },
    deleteProperty(_target, property) {
      return Reflect.deleteProperty(config, property)
    },
  })
}

function scopeView(scope, state) {
  if (!isObject(scope)) return scope
  return new Proxy(scope, {
    get(target, property) {
      if (property === 'get') {
        const get = Reflect.get(target, property, target)
        if (typeof get !== 'function') return get
        return (...args) => projectedConfig(get.apply(target, args), state)
      }
      if (property === 'watch') {
        const watch = Reflect.get(target, property, target)
        if (typeof watch !== 'function') return watch
        return (callback, ...rest) =>
          watch.call(
            target,
            (...args) => {
              if (typeof callback !== 'function') return undefined
              if (args.length === 0) return callback()
              const [value, ...tail] = args
              return callback(projectedConfig(value, state), ...tail)
            },
            ...rest,
          )
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function settingsView(settings, state) {
  if (!isObject(settings)) return settings
  return new Proxy(settings, {
    get(target, property) {
      if (property === 'get') {
        const get = Reflect.get(target, property, target)
        if (typeof get !== 'function') return get
        return (namespace, ...args) => {
          const value = get.call(target, namespace, ...args)
          return namespace === 'vision-router' ? projectedConfig(value, state) : value
        }
      }
      if (property === 'register') {
        const register = Reflect.get(target, property, target)
        if (typeof register !== 'function') return register
        return (namespace, ...args) => {
          const scope = register.call(target, namespace, ...args)
          return namespace === 'vision-router' ? scopeView(scope, state) : scope
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function childContextView(child, state) {
  if (!isObject(child)) return child
  const settings = settingsView(child.settings, state)
  return new Proxy(child, {
    get(target, property) {
      if (property === 'settings') return settings
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function rewriteTextOnlyDecision(payload, decision, rewriteHistoryImages) {
  const policy = currentSessionVisionPolicy()
  if (
    decision?.kind === 'reject' ||
    policy?.rewriteCurrentImages !== true ||
    typeof rewriteHistoryImages !== 'function'
  ) {
    return decision
  }

  const source = Array.isArray(decision?.messages)
    ? decision.messages
    : Array.isArray(payload?.messages)
      ? payload.messages
      : undefined
  if (!source) return decision

  // Core registers the exact SessionMemoryView while processing this same
  // pre-step. Reuse it here so a text-only fallback preserves cached visual
  // descriptions instead of degrading them back to a generic attachment marker.
  const memory = knownSessionVisionMemory(payload?.agent?.session)
  const rewritten = rewriteHistoryImages(source, memory)
  const messages = rewritten?.messages
  if (!Array.isArray(messages) || messages === source) return decision
  if (isObject(decision)) return { ...decision, messages }
  return { kind: 'continue', messages }
}

/**
 * Adapt the session-scoped ownership policy to the legacy monolithic core.
 *
 * The policy layer remains read-only. This bridge only projects legacy config
 * reads while one pre-step is active and post-processes an explicitly text-only
 * decision through index.js's exported rewriteHistoryImages implementation and
 * the exact SessionMemoryView registered by core for that pre-step. No marker,
 * rewrite algorithm, or cross-session image state is duplicated here.
 */
export function installLegacyCoreVisionPolicyBridge(
  ctx,
  config = {},
  { rewriteHistoryImages } = {},
) {
  if (!isObject(ctx)) {
    return {
      ctx,
      config,
      finishSchemaBootstrap() {},
    }
  }

  const state = { schemaBootstrapping: true }
  const projectedBootConfig = configView(config, state)
  const settingsCache = new WeakMap()

  const wrapSettings = (settings) => {
    if (!isObject(settings)) return settings
    const cached = settingsCache.get(settings)
    if (cached) return cached
    const wrapped = settingsView(settings, state)
    settingsCache.set(settings, wrapped)
    return wrapped
  }

  const wrappedCtx = new Proxy(ctx, {
    get(target, property) {
      if (property === 'get') {
        const get = Reflect.get(target, property, target)
        if (typeof get !== 'function') return get
        return (name, ...args) => {
          const value = get.call(target, name, ...args)
          return name === 'settings' ? wrapSettings(value) : value
        }
      }
      if (property === 'inject') {
        const inject = Reflect.get(target, property, target)
        if (typeof inject !== 'function') return inject
        return (dependencies, callback, ...rest) => {
          if (
            !Array.isArray(dependencies) ||
            !dependencies.includes('settings') ||
            typeof callback !== 'function'
          ) {
            return inject.call(target, dependencies, callback, ...rest)
          }
          return inject.call(
            target,
            dependencies,
            (child) => callback(childContextView(child, state)),
            ...rest,
          )
        }
      }
      if (property === 'on') {
        const on = Reflect.get(target, property, target)
        if (typeof on !== 'function') return on
        return (event, handler, ...rest) => {
          if (event !== 'agent/pre-step' || typeof handler !== 'function') {
            return on.call(target, event, handler, ...rest)
          }
          return on.call(target, event, async function legacyCoreVisionPolicyPreStep(payload, next) {
            const decision = await handler.call(this, payload, next)
            return rewriteTextOnlyDecision(payload, decision, rewriteHistoryImages)
          }, ...rest)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  return {
    ctx: wrappedCtx,
    config: projectedBootConfig,
    finishSchemaBootstrap() {
      state.schemaBootstrapping = false
    },
  }
}
