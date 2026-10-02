function routingKey(value) {
  if (!value || typeof value !== 'object') return '\u0000'
  const wrapper = typeof value.wrapperRoute === 'string' ? value.wrapperRoute : ''
  const chain = typeof value.chainRoute === 'string' ? value.chainRoute : ''
  return `${wrapper}\u0000${chain}`
}

/**
 * The legacy core already reconciles wrapper/chain mounts from its
 * vision-router settings-scope watcher. Adapter topology used to refresh only
 * generated twins, so a foreign route that disappeared later left a projected
 * wrapperRoute disabled until the next settings edit.
 *
 * Reuse the existing watcher instead of adding a second reconciler: on
 * llm/adapters-updated, replay it only when the ownership-projected routing
 * pair actually changed. Microtask deferral lets a successful registerAdapter
 * finish committing ownership before we inspect the projected scope.
 */
export function contextWithVisionRoutingTopologyRefresh(ctx) {
  if (!ctx || typeof ctx !== 'object' || typeof Proxy !== 'function') return ctx

  const watches = new Set()
  let queued = false

  const schedule = () => {
    if (queued || watches.size === 0) return
    queued = true
    Promise.resolve().then(() => {
      queued = false
      for (const record of [...watches]) {
        let value
        try {
          value = record.scope.get()
        } catch {
          continue
        }
        const key = routingKey(value)
        if (key === record.key) continue
        record.key = key
        try {
          record.callback(value)
        } catch {
          // The settings service owns watcher error handling during normal
          // delivery. A topology replay must not turn an adapter event into a
          // process-level failure.
        }
      }
    })
  }

  try {
    if (typeof ctx.on === 'function') ctx.on('llm/adapters-updated', schedule)
  } catch {
    // Older Hosts may not expose the event surface; settings edits still keep
    // the historical reconcile behavior.
  }

  const scopeView = (scope) => {
    if (!scope || typeof scope !== 'object') return scope
    return new Proxy(scope, {
      get(target, property) {
        if (property === 'watch') {
          const watch = Reflect.get(target, property, target)
          if (typeof watch !== 'function') return watch
          return (callback, ...rest) => {
            if (typeof callback !== 'function') return watch.call(target, callback, ...rest)
            const record = {
              scope: target,
              callback,
              key: (() => {
                try { return routingKey(target.get()) } catch { return '\u0000' }
              })(),
            }
            watches.add(record)
            const stop = watch.call(target, (value, ...tail) => {
              record.key = routingKey(value)
              return callback(value, ...tail)
            }, ...rest)
            return () => {
              watches.delete(record)
              if (typeof stop === 'function') return stop()
            }
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  const settingsView = (settings) => {
    if (!settings || typeof settings !== 'object') return settings
    return new Proxy(settings, {
      get(target, property) {
        if (property === 'register') {
          const register = Reflect.get(target, property, target)
          if (typeof register !== 'function') return register
          return (namespace, ...rest) => {
            const scope = register.call(target, namespace, ...rest)
            return namespace === 'vision-router' ? scopeView(scope) : scope
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  const view = (target) => new Proxy(target, {
    get(object, property) {
      if (property === 'settings') return settingsView(Reflect.get(object, property, object))
      if (property === 'get') {
        const get = Reflect.get(object, property, object)
        if (typeof get !== 'function') return get
        return (name, ...rest) => {
          const value = get.call(object, name, ...rest)
          return name === 'settings' ? settingsView(value) : value
        }
      }
      if (property === 'inject') {
        const inject = Reflect.get(object, property, object)
        if (typeof inject !== 'function') return inject
        return (deps, callback, ...rest) => inject.call(
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

  return view(ctx)
}
