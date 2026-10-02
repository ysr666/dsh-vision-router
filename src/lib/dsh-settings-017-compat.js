const SETTINGS_NS = 'vision-router'
export const LOCAL_SETTINGS_PATH = '/_dsh/vision-router/local-settings'
export const DSH_017_SETTINGS_COMPAT_MARK = '__visionRouterDsh017ConfigEditorCompat'
const BODY_LIMIT_BYTES = 256 * 1024
const REVISION_REGISTRY_KEY = Symbol.for('dsh-vision-router.settings-017-revisions')

function revisionRegistry() {
  let registry = globalThis[REVISION_REGISTRY_KEY]
  if (!(registry instanceof WeakMap)) {
    // The pre-R11 registry was a process-global Map keyed only by document
    // paths. Replace it rather than retaining stale profile keys forever.
    registry = new WeakMap()
    Object.defineProperty(globalThis, REVISION_REGISTRY_KEY, {
      value: registry,
      configurable: true,
    })
  }
  return registry
}

function objectLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function plainObject(value) {
  if (!objectLike(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function mergeResolved(base, overlay) {
  if (!plainObject(base) || !plainObject(overlay)) return clone(overlay)
  const next = clone(base)
  for (const [key, value] of Object.entries(overlay)) {
    next[key] = plainObject(value) && plainObject(next[key])
      ? mergeResolved(next[key], value)
      : clone(value)
  }
  return next
}

function jsonEqual(left, right) {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]))
  }
  if (!plainObject(left) || !plainObject(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
}

function logicalUserLayer(current, inherited) {
  const user = Object.create(null)
  const keys = new Set([
    ...Object.keys(objectLike(current) ? current : {}),
    ...Object.keys(objectLike(inherited) ? inherited : {}),
  ])
  for (const key of keys) {
    const currentHas = objectLike(current) && Object.hasOwn(current, key)
    const inheritedHas = objectLike(inherited) && Object.hasOwn(inherited, key)
    if (currentHas === inheritedHas && (!currentHas || jsonEqual(current[key], inherited[key]))) continue
    if (currentHas) user[key] = clone(current[key])
  }
  return user
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!plainObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

function fingerprint(value) {
  return JSON.stringify(stableValue(value))
}

function revisionKey(editor, namespace) {
  let documentPath
  try { documentPath = editor?.documentPath } catch {}
  return `${String(documentPath ?? 'process-local-profile')}\u0000${namespace}`
}

/**
 * Ordinary Config writes reload DVR, so a plugin-instance counter is unsafe.
 * Keep one process-level monotonic counter per profile document + namespace.
 * The registry survives DVR HMR and advances whenever the effective persisted
 * layers observed at the compatibility boundary change. A process restart also
 * resets every browser connection, which forces a fresh descriptor read.
 */
function revisionFor(editor, namespace, current, inherited) {
  const identity = serviceIdentity(editor)
  if (!identity || (typeof identity !== 'object' && typeof identity !== 'function')) return 0
  const registry = revisionRegistry()
  let states = registry.get(identity)
  if (!(states instanceof Map)) {
    states = new Map()
    registry.set(identity, states)
  }
  const key = revisionKey(editor, namespace)
  const valueFingerprint = fingerprint({ current, inherited })
  const previous = states.get(key)
  if (!previous) {
    const state = { fingerprint: valueFingerprint, revision: 0 }
    states.set(key, state)
    return state.revision
  }
  if (previous.fingerprint !== valueFingerprint) {
    previous.fingerprint = valueFingerprint
    previous.revision += 1
  }
  return previous.revision
}

const CORDIS_ORIGINAL = Symbol.for('cordis.original')

function serviceIdentity(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value
  try {
    const original = value[CORDIS_ORIGINAL]
    return original && (typeof original === 'object' || typeof original === 'function') ? original : value
  } catch {
    return value
  }
}

function serviceOf(ctx, name) {
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return undefined
  if (typeof ctx.get === 'function') {
    try {
      const value = ctx.get(name)
      return value === undefined || value === null ? undefined : value
    } catch {
      return undefined
    }
  }
  try {
    const value = ctx[name]
    return value === undefined || value === null ? undefined : value
  } catch {
    return undefined
  }
}

function configEditorRow(editor, namespace) {
  const rows = typeof editor?.configuration === 'function' ? editor.configuration() : []
  if (!Array.isArray(rows)) return undefined
  return rows.find((row) => row?.entry?.options?.id === namespace)
}

function settingsConflict(expected, actual) {
  const error = new Error(`Vision Router settings changed before this write landed (expected ${expected}, actual ${actual})`)
  error.code = 'SETTINGS_CONFLICT'
  error.expected = expected
  error.actual = actual
  return error
}

function admissionError(message) {
  const error = new Error(message)
  error.code = 'SETTINGS_INVALID_MUTATION'
  return error
}

function validateOperations(ops) {
  if (!Array.isArray(ops) || ops.length === 0) throw admissionError('settings operations must be a non-empty array')
  return ops.map((op) => {
    if (!objectLike(op) || (op.op !== 'set' && op.op !== 'unset')) {
      throw admissionError('settings operation must be set or unset')
    }
    if (!Array.isArray(op.path) || op.path.length !== 1 || typeof op.path[0] !== 'string' || op.path[0] === '') {
      throw admissionError('Vision Router settings compatibility accepts one top-level field per operation')
    }
    const key = op.path[0]
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw admissionError('unsafe settings field name')
    }
    return op.op === 'set'
      ? { op: 'set', path: [key], value: clone(op.value) }
      : { op: 'unset', path: [key] }
  })
}

function applyOperations(current, inherited, ops) {
  const next = clone(objectLike(current) ? current : {})
  for (const op of ops) {
    const key = op.path[0]
    if (op.op === 'set') {
      next[key] = clone(op.value)
      continue
    }
    if (objectLike(inherited) && Object.hasOwn(inherited, key)) next[key] = clone(inherited[key])
    else delete next[key]
  }
  return next
}

function createConfigEditorSettingsFacade(editor, entryConfig, namespace, sharedState) {
  const listeners = sharedState.listeners

  // ConfigEditor.configuration() rebuilds the complete profile and, on 0.1.7,
  // composes every entry through structuredClone(). Ordinary profile writes
  // reload this plugin and therefore replace the facade; keep one immutable
  // instance snapshot for runtime reads and refresh only at write boundaries.
  function state(refresh = false) {
    if (sharedState.stateLoaded && !refresh) return sharedState.cachedState
    const row = configEditorRow(editor, namespace)
    if (!row) {
      sharedState.cachedState = undefined
      sharedState.stateLoaded = true
      return sharedState.cachedState
    }
    const current = objectLike(row.entry?.options?.config) ? row.entry.options.config : {}
    const inherited = objectLike(row.inherited) ? row.inherited : {}
    const base = mergeResolved(entryConfig, inherited)
    const value = mergeResolved(entryConfig, current)
    sharedState.cachedState = {
      row,
      descriptor: {
        ns: namespace,
        value,
        base,
        user: logicalUserLayer(current, inherited),
        revision: revisionFor(editor, namespace, current, inherited),
        applies: true,
      },
    }
    sharedState.stateLoaded = true
    return sharedState.cachedState
  }

  function notify(value) {
    for (const listener of [...listeners]) {
      try { listener(clone(value), undefined) } catch {}
    }
  }

  function enqueueMutation(task) {
    const running = sharedState.mutationTail.then(task, task)
    sharedState.mutationTail = running.catch(() => {})
    return running
  }

  const scope = {
    get() {
      return clone(state()?.descriptor.value ?? entryConfig)
    },
    watch(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  return {
    [DSH_017_SETTINGS_COMPAT_MARK]: true,
    get writable() {
      return state() !== undefined
    },
    get(namespaceName) {
      return namespaceName === namespace ? scope.get() : undefined
    },
    register(namespaceName) {
      if (namespaceName !== namespace) {
        throw new Error(`vision-router: unexpected settings namespace ${String(namespaceName)}`)
      }
      return scope
    },
    describe() {
      const current = state()
      return current ? [clone(current.descriptor)] : []
    },
    mutate(namespaceName, operations, expectedRevision) {
      let ops
      try {
        if (namespaceName !== namespace) throw new Error(`No configurable plugin entry ${JSON.stringify(namespaceName)}`)
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
          throw admissionError('expectedRevision must be a non-negative safe integer')
        }
        // Validate and clone caller-owned values before this write waits behind
        // another mutation, closing a queued-request time-of-check/use gap.
        ops = validateOperations(operations)
      } catch (error) {
        return Promise.reject(error)
      }
      return enqueueMutation(async () => {
        // Runtime reads use the facade snapshot. Writes deliberately cross the
        // ConfigEditor boundary again so optimistic concurrency still observes
        // changes that landed before a Host reload replaced this facade.
        const before = state(true)
        if (!before) throw new Error(`No configurable plugin entry ${JSON.stringify(namespace)}`)
        if (expectedRevision !== before.descriptor.revision) {
          throw settingsConflict(expectedRevision, before.descriptor.revision)
        }
        const entry = before.row.entry
        await editor.edit(entry, (current, inherited) => applyOperations(current, inherited, ops))
        const after = state(true)
        if (!after) throw new Error('Vision Router configuration entry disappeared after the write')
        notify(after.descriptor.value)
        return clone(after.descriptor)
      })
    },
  }
}

/**
 * DSH 0.1.7 services may mount after DVR's apply() starts. Capture ConfigEditor
 * through its own lifecycle injection and resolve the settings generation when
 * each consumer actually accesses it. This avoids both startup-order races and
 * undeclared child-context service reads.
 */
function contextWithLazySettingsCompatibility(ctx, entryConfig, namespace) {
  const wrappers = new WeakMap()
  const facades = new WeakMap()
  const sharedStates = new WeakMap()
  let injectedEditor

  try {
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['configEditor'], (editorCtx) => {
        injectedEditor = serviceOf(editorCtx, 'configEditor')
      })
    }
  } catch {
    // Older Hosts may not expose ConfigEditor; their native SettingsProvider stays authoritative.
  }

  function compatibleSettings(target) {
    const settings = serviceOf(target, 'settings') ?? serviceOf(ctx, 'settings')
    if (!settings || typeof settings.register === 'function') return settings
    const editor = serviceOf(target, 'configEditor') ?? injectedEditor ?? serviceOf(ctx, 'configEditor')
    if (typeof settings.describe !== 'function'
        || !editor || typeof editor.edit !== 'function' || typeof editor.configuration !== 'function') {
      return settings
    }
    const identity = serviceIdentity(editor)
    let sharedState = sharedStates.get(identity)
    if (!sharedState) {
      sharedState = {
        listeners: new Set(),
        cachedState: undefined,
        stateLoaded: false,
        mutationTail: Promise.resolve(),
      }
      sharedStates.set(identity, sharedState)
    }
    let facade = facades.get(editor)
    if (!facade) {
      // Cordis may hand different traceable proxy views of the same service to
      // different child contexts. Keep each facade bound to its caller-owned
      // proxy for method ownership, but share the expensive immutable snapshot
      // and write queue by the stable underlying service identity.
      facade = createConfigEditorSettingsFacade(editor, entryConfig, namespace, sharedState)
      facades.set(editor, facade)
    }
    return facade
  }

  function wrap(target) {
    if (!target || typeof target !== 'object') return target
    const held = wrappers.get(target)
    if (held) return held
    const wrapped = new Proxy(target, {
      get(object, property) {
        if (property === 'settings') return compatibleSettings(object)
        if (property === 'get') {
          const get = Reflect.get(object, property, object)
          if (typeof get !== 'function') return get
          return (name, ...rest) => name === 'settings'
            ? compatibleSettings(object)
            : get.call(object, name, ...rest)
        }
        if (property === 'inject') {
          const inject = Reflect.get(object, property, object)
          if (typeof inject !== 'function') return inject
          return (dependencies, callback, ...rest) => inject.call(
            object,
            dependencies,
            typeof callback === 'function' && Array.isArray(dependencies) && dependencies.includes('settings')
              ? (child) => callback(wrap(child))
              : callback,
            ...rest,
          )
        }
        const value = Reflect.get(object, property, object)
        return typeof value === 'function' ? value.bind(object) : value
      },
    })
    wrappers.set(target, wrapped)
    return wrapped
  }

  return wrap(ctx)
}

/**
 * DSH 0.1.7 removes the legacy SettingsProvider.register() namespace API and
 * makes ordinary plugin configuration profile-owned through ConfigEditor.
 * Preserve DVR's mature settings consumers behind the old semantic face while
 * leaving older Hosts on their native SettingsProvider whenever it is present.
 */
export function installDsh017SettingsCompatibility(ctx, entryConfig = {}, options = {}) {
  const namespace = typeof options.namespace === 'string' && options.namespace !== '' ? options.namespace : SETTINGS_NS
  return contextWithLazySettingsCompatibility(ctx, entryConfig, namespace)
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > BODY_LIMIT_BYTES) throw Object.assign(new Error('request body too large'), { statusCode: 413 })
    chunks.push(bytes)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function namespaceDescriptor(settings) {
  const descriptors = settings.describe({ redactSecrets: true })
  return Array.isArray(descriptors) ? descriptors.find((entry) => entry?.ns === SETTINGS_NS) : undefined
}

/** Local-only transport for the 0.1.7 browser, which no longer exposes settingsScope. */
export function installDsh017LocalSettingsTransport(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return
  ctx.inject(['settings', 'webServer'], (webCtx) => {
    if (webCtx.settings?.[DSH_017_SETTINGS_COMPAT_MARK] !== true) return
    if (typeof webCtx.settings.describe !== 'function' || typeof webCtx.settings.mutate !== 'function') return
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: LOCAL_SETTINGS_PATH,
        async handler(req, res) {
          if (req.method === 'GET') {
            const descriptor = namespaceDescriptor(webCtx.settings)
            if (!descriptor) {
              sendJson(res, 404, { ok: false, error: { code: 'settings-unavailable', message: 'Vision Router settings are unavailable' } })
              return
            }
            sendJson(res, 200, { ok: true, value: { ...descriptor, writable: webCtx.settings.writable === true } })
            return
          }
          if (req.method !== 'POST') {
            res.setHeader('Allow', 'GET, POST')
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'method not allowed' } })
            return
          }
          try {
            const payload = await readJson(req)
            await webCtx.settings.mutate(SETTINGS_NS, payload?.ops, payload?.expectedRevision)
            const descriptor = namespaceDescriptor(webCtx.settings)
            if (!descriptor) throw new Error('Vision Router settings disappeared after the write')
            sendJson(res, 200, { ok: true, value: { ...descriptor, writable: webCtx.settings.writable === true } })
          } catch (error) {
            const conflict = error?.code === 'SETTINGS_CONFLICT'
            sendJson(res, error?.statusCode ?? (conflict ? 409 : 400), {
              ok: false,
              error: {
                code: conflict ? 'settings-conflict' : 'settings-rejected',
                message: error?.message ?? String(error),
                ...(conflict ? { details: { expected: error.expected, actual: error.actual } } : {}),
              },
            })
          }
        },
      }),
      'vision-router: DSH 0.1.7 local settings transport',
    )
  })
}
