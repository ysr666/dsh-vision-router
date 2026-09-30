import {
  DSH_017_SETTINGS_COMPAT_MARK,
  LOCAL_SETTINGS_PATH,
} from '../dsh-settings-017-compat.js'

const BODY_LIMIT_BYTES = 256 * 1024
const ROOT_TRANSPORT_REGISTRY_KEY = Symbol.for('dsh-vision-router.settings-017-root-local-transport')
const SLOW_MUTATION_MS = 5_000
const TRACE_ENV = 'DVR_SETTINGS_017_TRACE'

function objectLike(value) {
  return value !== null && typeof value === 'object'
}

function trace(stage, detail) {
  if (process.env[TRACE_ENV] !== '1') return
  try {
    console.warn(`vision-router: DSH 0.1.7 settings trace ${stage}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
  } catch {}
}

function transportRegistry() {
  let registry = globalThis[ROOT_TRANSPORT_REGISTRY_KEY]
  if (!(registry instanceof WeakMap)) {
    registry = new WeakMap()
    Object.defineProperty(globalThis, ROOT_TRANSPORT_REGISTRY_KEY, {
      value: registry,
      configurable: true,
    })
  }
  return registry
}

function rootOf(ctx) {
  try {
    if (objectLike(ctx?.root)) return ctx.root
  } catch {}
  return ctx
}

function stateFor(root) {
  const registry = transportRegistry()
  let state = registry.get(root)
  if (!state) {
    state = {
      current: undefined,
      routeOwner: undefined,
      routeInstalling: false,
      generationSequence: 0,
      requestSequence: 0,
    }
    registry.set(root, state)
  }
  return state
}

function serviceOf(ctx, name) {
  try {
    const value = typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    if (value !== undefined && value !== null) return value
  } catch {}
  try {
    const value = ctx?.[name]
    return value === undefined || value === null ? undefined : value
  } catch {
    return undefined
  }
}

function compatibleSettings(ctx) {
  const settings = serviceOf(ctx, 'settings')
  if (settings?.[DSH_017_SETTINGS_COMPAT_MARK] !== true) return undefined
  if (typeof settings.describe !== 'function' || typeof settings.mutate !== 'function') return undefined
  return settings
}

function namespaceDescriptor(settings) {
  const descriptors = settings.describe({ redactSecrets: true })
  return Array.isArray(descriptors) ? descriptors.find((entry) => entry?.ns === 'vision-router') : undefined
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

function currentSettings(state) {
  const generation = state.current
  if (!generation || generation.active === false) return undefined
  try {
    return generation.resolve()
  } catch {
    return undefined
  }
}

function flattenEffectLabels(effects) {
  const labels = []
  const visit = (rows) => {
    if (!Array.isArray(rows)) return
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      if (typeof row.label === 'string') labels.push(row.label)
      visit(row.children)
    }
  }
  visit(effects)
  return labels
}

function slowMutationSnapshot(root) {
  const loader = serviceOf(root, 'loader')
  let entries = []
  try { entries = typeof loader?.entries === 'function' ? [...loader.entries()] : [] } catch {}
  return entries.flatMap((entry) => {
    const fiber = entry?.fiber
    if (!fiber || (entry?.options?.id !== 'vision-router' && !fiber.inertia)) return []
    let effects = []
    try { effects = typeof fiber.getEffects === 'function' ? flattenEffectLabels(fiber.getEffects()) : [] } catch {}
    return [{
      id: entry?.options?.id,
      state: fiber.state,
      inertia: Boolean(fiber.inertia),
      effects,
    }]
  })
}

function beginSlowMutationWatch(root, requestId) {
  return setTimeout(() => {
    const snapshot = slowMutationSnapshot(root)
    const message = `vision-router: DSH 0.1.7 settings mutation still reconciling after ${SLOW_MUTATION_MS}ms request=${requestId} ${JSON.stringify(snapshot)}`
    try {
      if (root?.logger && typeof root.logger.warn === 'function') root.logger.warn(message)
      else console.warn(message)
    } catch {
      try { console.warn(message) } catch {}
    }
  }, SLOW_MUTATION_MS)
}

function routeFor(root, state) {
  return {
    kind: 'exact',
    path: LOCAL_SETTINGS_PATH,
    async handler(req, res) {
      const requestId = ++state.requestSequence
      trace('handler-enter', { requestId, method: req.method, generation: state.current?.id })
      const settings = currentSettings(state)
      if (!settings) {
        trace('settings-unavailable', { requestId })
        sendJson(res, 404, { ok: false, error: { code: 'settings-unavailable', message: 'Vision Router settings are unavailable' } })
        return
      }

      if (req.method === 'GET') {
        const descriptor = namespaceDescriptor(settings)
        if (!descriptor) {
          sendJson(res, 404, { ok: false, error: { code: 'settings-unavailable', message: 'Vision Router settings are unavailable' } })
          return
        }
        sendJson(res, 200, { ok: true, value: { ...descriptor, writable: settings.writable === true } })
        trace('response', { requestId, status: 200, revision: descriptor.revision })
        return
      }

      if (req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST')
        sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'method not allowed' } })
        return
      }

      let slowTimer
      try {
        trace('body-read-start', { requestId })
        const payload = await readJson(req)
        trace('body-read-done', { requestId, expectedRevision: payload?.expectedRevision, ops: payload?.ops?.length })
        slowTimer = beginSlowMutationWatch(root, requestId)
        trace('mutate-start', { requestId, generation: state.current?.id })
        await settings.mutate('vision-router', payload?.ops, payload?.expectedRevision)
        trace('mutate-done', { requestId, generation: state.current?.id })

        // ConfigEditor.edit() reconciles the profile and can dispose the plugin
        // generation that accepted this request. The route itself is owned by a
        // root child fiber that depends only on WebServer, so finish the response
        // from the newly-mounted DVR generation when present.
        const afterSettings = currentSettings(state) ?? settings
        const descriptor = namespaceDescriptor(afterSettings)
        if (!descriptor) throw new Error('Vision Router settings disappeared after the write')
        sendJson(res, 200, { ok: true, value: { ...descriptor, writable: afterSettings.writable === true } })
        trace('response', { requestId, status: 200, revision: descriptor.revision })
      } catch (error) {
        const conflict = error?.code === 'SETTINGS_CONFLICT'
        const status = error?.statusCode ?? (conflict ? 409 : 400)
        trace('response-error', { requestId, status, code: error?.code, message: error?.message ?? String(error) })
        sendJson(res, status, {
          ok: false,
          error: {
            code: conflict ? 'settings-conflict' : 'settings-rejected',
            message: error?.message ?? String(error),
            ...(conflict ? { details: { expected: error.expected, actual: error.actual } } : {}),
          },
        })
      } finally {
        if (slowTimer) clearTimeout(slowTimer)
      }
    },
  }
}

function ensureRootRoute(root, state) {
  if (state.routeOwner || state.routeInstalling) return
  if (typeof root?.inject !== 'function') {
    throw new Error('Vision Router requires root dependency injection for the DSH 0.1.7 local settings route')
  }

  state.routeInstalling = true
  try {
    const owner = root.inject(['webServer'], (webCtx) => {
      if (!webCtx?.webServer || typeof webCtx.webServer.register !== 'function' || typeof webCtx.effect !== 'function') {
        throw new Error('Vision Router requires WebServer route registration on DSH 0.1.7')
      }
      trace('route-register', {})
      webCtx.effect(
        () => {
          const dispose = webCtx.webServer.register(routeFor(root, state))
          return () => {
            trace('route-dispose', {})
            dispose()
          }
        },
        'vision-router: DSH 0.1.7 root local settings transport',
      )
    })
    // `root.inject()` creates a root child fiber. It is independent from the
    // DVR plugin fiber and therefore survives ConfigEditor reconciliation of
    // the `vision-router` entry. Keep the owner reachable for the process life.
    state.routeOwner = owner ?? true
  } catch (error) {
    state.routeOwner = undefined
    throw error
  } finally {
    state.routeInstalling = false
  }
}

/**
 * ConfigEditor.edit() reconciles the plugin configuration and therefore disposes
 * the DVR plugin fiber while a Settings POST is still in flight. A dedicated
 * root child fiber owns the HTTP route and depends only on WebServer; individual
 * DVR generations only publish a resolver for their current settings facade.
 */
export function installDsh017RootLocalSettingsTransport(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return
  const root = rootOf(ctx)
  if (!objectLike(root)) return
  const state = stateFor(root)

  ctx.inject(['settings'], (settingsCtx) => {
    const mounted = compatibleSettings(settingsCtx)
    if (!mounted) return

    const generation = {
      id: ++state.generationSequence,
      active: true,
      resolve: () => compatibleSettings(ctx) ?? mounted,
    }
    state.current = generation
    trace('generation-mount', { generation: generation.id })
    ensureRootRoute(root, state)

    if (typeof settingsCtx?.effect === 'function') {
      settingsCtx.effect(
        () => () => {
          generation.active = false
          if (state.current === generation) state.current = undefined
          trace('generation-dispose', { generation: generation.id })
        },
        'vision-router: DSH 0.1.7 settings generation',
      )
    }
  })
}
