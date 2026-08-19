import { isLocalUiRequest } from './web-capability-boundary.js'

const SETTINGS_NS = 'vision-router'

export const REMOTE_SETTINGS_CHANNEL = '/vision-router-settings'
export const REMOTE_SETTINGS_PERMISSION = 'allowRemoteSettings'
export const LOCAL_REMOTE_SETTINGS_PERMISSION_PATH = '/_dsh/vision-router/remote-settings-permission'

const LOCAL_PERMISSION_PRELUDE_MARK = 'data-vision-router-local-settings-permission'
const MAX_LOCAL_PERMISSION_BODY_BYTES = 4096

// Remote DSH pages are deliberately less privileged than the loopback settings UI.
// This is a capability allow-list, not a blacklist: a future Config field is local-only
// until it is reviewed and explicitly added here.
export const REMOTE_SETTINGS_READABLE_FIELDS = Object.freeze([
  'providers',
  'routing',
  'reverseRouting',
  'textProvider',
  'tool',
  'structuredVisionBootstrap',
  'visionDepth',
  'visionDepthMaxCalls',
  'guidanceOverrides',
  'progressiveTools',
  'autoActivateOnImage',
  'extraVisionModels',
  'rewriteImages',
  'downscale',
  'downscaleMaxPixels',
  'cache',
  'cacheTtlSeconds',
  'cacheMaxEntries',
  'timeoutMs',
  'visionTaskTimeoutMs',
  'ocrTimeoutMs',
  'freeFallback',
  'freeCloudFirst',
  'autoWrapProviders',
  'wrappedProviders',
  'onboardingSeen',
])

export const REMOTE_SETTINGS_MUTABLE_FIELDS = REMOTE_SETTINGS_READABLE_FIELDS

const readable = new Set(REMOTE_SETTINGS_READABLE_FIELDS)
const mutable = new Set(REMOTE_SETTINGS_MUTABLE_FIELDS)

function badRequest(message) {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function settingsRejected(message) {
  return { ok: false, error: { code: 'settings-rejected', message, details: { ns: SETTINGS_NS } } }
}

function project(value, fields = readable) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out = Object.create(null)
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(value, field)) out[field] = structuredClone(value[field])
  }
  return out
}

function publicView(descriptor) {
  return {
    value: project(descriptor.value) ?? {},
    ...descriptor.base === undefined ? {} : { base: project(descriptor.base) ?? {} },
    ...descriptor.user === undefined ? {} : { user: project(descriptor.user) ?? {} },
    revision: descriptor.revision,
    applies: descriptor.applies,
  }
}

function namespaceDescriptor(settings) {
  const descriptors = settings.describe({ redactSecrets: true })
  if (!Array.isArray(descriptors)) return undefined
  return descriptors.find((entry) => entry && entry.ns === SETTINGS_NS)
}

function accessSnapshot(settings) {
  const descriptor = namespaceDescriptor(settings)
  if (!descriptor) {
    return { enabled: false, reason: 'namespace-unavailable', writable: false }
  }
  const value = descriptor.value
  const enabled = !!value && typeof value === 'object' && value[REMOTE_SETTINGS_PERMISSION] === true
  if (!enabled) {
    return { enabled: false, reason: 'permission-disabled', writable: false }
  }
  return {
    enabled: true,
    reason: 'enabled',
    writable: settings.writable === true,
    view: publicView(descriptor),
  }
}

function validateMutation(payload, descriptor) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { error: 'payload must be an object' }
  }
  const { ops, expectedRevision } = payload
  if (!Array.isArray(ops) || ops.length !== 1) {
    return { error: 'exactly one top-level settings operation is required' }
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return { error: 'expectedRevision must be a non-negative integer' }
  }
  const op = ops[0]
  if (typeof op !== 'object' || op === null || Array.isArray(op)) {
    return { error: 'settings operation must be an object' }
  }
  if (op.op !== 'set' && op.op !== 'unset') return { error: 'settings operation must be set or unset' }
  if (!Array.isArray(op.path) || op.path.length !== 1 || typeof op.path[0] !== 'string' || op.path[0] === '') {
    return { error: 'remote settings may edit one top-level field at a time' }
  }
  const field = op.path[0]
  if (field === '__proto__' || field === 'prototype' || field === 'constructor') {
    return { error: 'unsafe settings field name' }
  }
  if (!mutable.has(field)) {
    return { error: 'Vision Router setting ' + JSON.stringify(field) + ' is local-only' }
  }
  const value = descriptor && descriptor.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)
      || !Object.prototype.hasOwnProperty.call(value, field)) {
    return { error: 'unknown Vision Router settings field ' + JSON.stringify(field) }
  }
  return { ops: [op], expectedRevision }
}

function conflictResult(error) {
  if (!error || error.code !== 'SETTINGS_CONFLICT') return undefined
  return {
    ok: false,
    error: {
      code: 'settings-conflict',
      message: error.message || 'Vision Router settings changed before this write landed',
      details: {
        ns: SETTINGS_NS,
        expected: Number.isInteger(error.expected) ? error.expected : -1,
        actual: Number.isInteger(error.actual) ? error.actual : -1,
      },
    },
  }
}

export function createVisionRouterRemoteSettingsHandler(settings, logger) {
  return async (endpoint, payload) => {
    if (endpoint === 'describe') {
      try {
        return { ok: true, value: accessSnapshot(settings) }
      } catch (error) {
        logger?.warn?.('vision-router: remote settings describe failed: %s', error?.message ?? String(error))
        return settingsRejected('Vision Router settings could not be read')
      }
    }
    if (endpoint !== 'mutate') {
      return badRequest('unknown Vision Router remote settings endpoint ' + JSON.stringify(endpoint))
    }

    let descriptor
    let access
    try {
      descriptor = namespaceDescriptor(settings)
      if (!descriptor) return { ok: true, value: { enabled: false, reason: 'namespace-unavailable', writable: false } }
      const enabled = !!descriptor.value && typeof descriptor.value === 'object'
        && descriptor.value[REMOTE_SETTINGS_PERMISSION] === true
      if (!enabled) return { ok: true, value: { enabled: false, reason: 'permission-disabled', writable: false } }
      access = { enabled: true, reason: 'enabled', writable: settings.writable === true, view: publicView(descriptor) }
    } catch {
      return settingsRejected('Vision Router settings could not be read before the write')
    }
    if (!access.writable) return settingsRejected('Vision Router settings provider is read-only')

    const validated = validateMutation(payload, descriptor)
    if (validated.error) return badRequest(validated.error)
    try {
      await settings.mutate(SETTINGS_NS, validated.ops, validated.expectedRevision)
    } catch (error) {
      const conflict = conflictResult(error)
      if (conflict) return conflict
      logger?.warn?.('vision-router: remote settings mutation rejected: %s', error?.message ?? String(error))
      return settingsRejected(error?.message ?? 'Vision Router settings write was rejected')
    }
    try {
      return { ok: true, value: accessSnapshot(settings) }
    } catch {
      return settingsRejected('Vision Router settings changed but the refreshed view could not be read')
    }
  }
}

/**
 * Host-authoritative mutation for the one bootstrap permission that MUST remain
 * loopback-only. DSH rc.6's browser SettingsScope intentionally swallows a
 * rejected settings.mutate response and publishes only the recovery read, so a
 * failed permission write otherwise degenerates into an unhelpful readback
 * mismatch. This path calls the Host SettingsProvider directly, verifies the
 * raw user layer after persistence, and returns the authoritative revision.
 */
export async function mutateLocalRemoteSettingsPermission(settings, payload, logger) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return badRequest('payload must be an object')
  const operation = payload.operation
  if (operation !== 'set' && operation !== 'unset') return badRequest('operation must be set or unset')
  if (operation === 'set' && typeof payload.value !== 'boolean') return badRequest('value must be a boolean')

  let descriptor
  try {
    descriptor = namespaceDescriptor(settings)
  } catch (error) {
    logger?.warn?.('vision-router: local remote-settings permission describe failed: %s', error?.message ?? String(error))
    return settingsRejected('Vision Router settings could not be read')
  }
  if (!descriptor) return settingsRejected('Vision Router settings namespace is unavailable')
  if (settings.writable !== true) return settingsRejected('Vision Router settings provider is read-only')

  const expectedRevision = Number.isInteger(payload.expectedRevision) && payload.expectedRevision >= 0
    ? payload.expectedRevision
    : descriptor.revision
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) return badRequest('expectedRevision must be a non-negative integer')

  const op = operation === 'set'
    ? { op: 'set', path: [REMOTE_SETTINGS_PERMISSION], value: payload.value }
    : { op: 'unset', path: [REMOTE_SETTINGS_PERMISSION] }
  try {
    await settings.mutate(SETTINGS_NS, [op], expectedRevision)
  } catch (error) {
    const conflict = conflictResult(error)
    if (conflict) return conflict
    logger?.warn?.(
      'vision-router: local remote-settings permission mutation rejected: %s',
      error?.message ?? String(error),
    )
    return settingsRejected(error?.message ?? 'Vision Router settings write was rejected')
  }

  let after
  try {
    after = namespaceDescriptor(settings)
  } catch (error) {
    logger?.warn?.('vision-router: local remote-settings permission readback failed: %s', error?.message ?? String(error))
    return settingsRejected('Vision Router permission changed but could not be read back')
  }
  const user = after && after.user && typeof after.user === 'object' && !Array.isArray(after.user) ? after.user : {}
  const present = Object.prototype.hasOwnProperty.call(user, REMOTE_SETTINGS_PERMISSION)
  const landed = operation === 'unset'
    ? !present
    : present && user[REMOTE_SETTINGS_PERMISSION] === payload.value
  if (!landed) {
    logger?.warn?.(
      'vision-router: local remote-settings permission write did not land operation=%s present=%s',
      operation,
      present ? 'yes' : 'no',
    )
    return settingsRejected('Vision Router permission write did not land in the user settings layer')
  }
  return {
    ok: true,
    value: {
      operation,
      present,
      ...(present ? { value: user[REMOTE_SETTINGS_PERMISSION] } : {}),
      revision: after.revision,
    },
  }
}

function sameOriginRequest(req) {
  const origin = req?.headers?.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = req?.headers?.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

async function readJsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_LOCAL_PERMISSION_BODY_BYTES) throw new Error('request body too large')
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') throw new Error('request body is required')
  return JSON.parse(text)
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

export function createVisionRouterLocalPermissionHttpHandler(settings, logger) {
  return async (req, res) => {
    if (req?.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST required' } })
      return
    }
    if (!isLocalUiRequest(req) || !sameOriginRequest(req)) {
      sendJson(res, 403, { ok: false, error: { code: 'local-only', message: 'loopback settings access required' } })
      return
    }
    const contentType = String(req?.headers?.['content-type'] ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      sendJson(res, 415, { ok: false, error: { code: 'unsupported-media-type', message: 'application/json required' } })
      return
    }
    let payload
    try {
      payload = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: error?.message ?? 'invalid JSON body' } })
      return
    }
    const result = await mutateLocalRemoteSettingsPermission(settings, payload, logger)
    const code = result.ok
      ? 200
      : result.error?.code === 'settings-conflict'
        ? 409
        : result.error?.code === 'bad-request'
          ? 400
          : 422
    sendJson(res, code, result)
  }
}

/**
 * Browser shim for only the local Vision Router SettingsScope. It intercepts
 * allowRemoteSettings set/unset while snapshot.mode === 'host', sends that one
 * operation to the loopback-only Host endpoint above, then overlays the
 * endpoint's verified user-layer result until DSH's own SettingsScope refresh
 * catches up. Remote scopes and every other field keep the stock DSH path.
 */
export const LOCAL_PERMISSION_CLIENT_PRELUDE = String.raw`(function(){
  'use strict';
  var ENDPOINT = '/_dsh/vision-router/remote-settings-permission';
  var FIELD = 'allowRemoteSettings';
  var scopeCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;
  var binderCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;
  var contextCache = typeof WeakMap === 'function' ? new WeakMap() : undefined;

  async function writePermission(operation, value, revision) {
    if (typeof fetch !== 'function') throw new Error('Vision Router local settings transport is unavailable');
    var payload = { operation: operation };
    if (operation === 'set') payload.value = value;
    if (Number.isInteger(revision) && revision >= 0) payload.expectedRevision = revision;
    var response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload)
    });
    var body;
    try { body = await response.json(); } catch (_) { body = undefined; }
    if (!response.ok || !body || body.ok !== true) {
      var message = body && body.error && body.error.message ? body.error.message : ('HTTP ' + response.status);
      var error = new Error(message);
      if (body && body.error && body.error.code) error.code = body.error.code;
      throw error;
    }
    return body.value;
  }

  function wrapScope(scope) {
    if (!scope || (typeof scope !== 'object' && typeof scope !== 'function')) return scope;
    if (scopeCache && scopeCache.has(scope)) return scopeCache.get(scope);
    var overlay;
    function rawSnapshot() {
      try { return typeof scope.getSnapshot === 'function' ? scope.getSnapshot() : undefined; } catch (_) { return undefined; }
    }
    function snapshotWithOverlay(snapshot) {
      if (!overlay || !snapshot || typeof snapshot !== 'object') return snapshot;
      var user = snapshot.user && typeof snapshot.user === 'object' && !Array.isArray(snapshot.user) ? snapshot.user : {};
      var present = Object.prototype.hasOwnProperty.call(user, FIELD);
      var matches = overlay.present ? present && user[FIELD] === overlay.value : !present;
      if (matches && (!Number.isInteger(overlay.revision) || !Number.isInteger(snapshot.revision) || snapshot.revision >= overlay.revision)) {
        overlay = undefined;
        return snapshot;
      }
      var nextUser = Object.assign({}, user);
      if (overlay.present) nextUser[FIELD] = overlay.value;
      else delete nextUser[FIELD];
      var nextValue = snapshot.value && typeof snapshot.value === 'object' && !Array.isArray(snapshot.value)
        ? Object.assign({}, snapshot.value)
        : snapshot.value;
      if (nextValue && typeof nextValue === 'object') nextValue[FIELD] = overlay.present ? overlay.value : false;
      return Object.assign({}, snapshot, {
        user: nextUser,
        value: nextValue,
        revision: Number.isInteger(overlay.revision) ? overlay.revision : snapshot.revision
      });
    }
    var wrapped = new Proxy(scope, {
      get: function(target, property) {
        if (property === 'getSnapshot') {
          return function(){ return snapshotWithOverlay(rawSnapshot()); };
        }
        if (property === 'set') {
          var set = Reflect.get(target, property, target);
          return async function(field, value) {
            var snapshot = rawSnapshot();
            if (field === FIELD && snapshot && snapshot.mode === 'host') {
              if (typeof value !== 'boolean') throw new TypeError('allowRemoteSettings must be boolean');
              var result = await writePermission('set', value, snapshot.revision);
              overlay = { present: true, value: value, revision: result && result.revision };
              if (typeof target.load === 'function') await target.load();
              return;
            }
            return typeof set === 'function' ? set.apply(target, arguments) : undefined;
          };
        }
        if (property === 'unset') {
          var unset = Reflect.get(target, property, target);
          return async function(field) {
            var snapshot = rawSnapshot();
            if (field === FIELD && snapshot && snapshot.mode === 'host') {
              var result = await writePermission('unset', undefined, snapshot.revision);
              overlay = { present: false, revision: result && result.revision };
              if (typeof target.load === 'function') await target.load();
              return;
            }
            return typeof unset === 'function' ? unset.apply(target, arguments) : undefined;
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    if (scopeCache) scopeCache.set(scope, wrapped);
    return wrapped;
  }

  function wrapBinder(binder) {
    if (!binder || (typeof binder !== 'object' && typeof binder !== 'function')) return binder;
    if (binderCache && binderCache.has(binder)) return binderCache.get(binder);
    var wrapped = new Proxy(binder, {
      get: function(target, property) {
        if (property === 'bind') {
          var bind = Reflect.get(target, property, target);
          if (typeof bind !== 'function') return bind;
          return function(spec) {
            var scope = bind.apply(target, arguments);
            return spec && spec.namespace === 'vision-router' ? wrapScope(scope) : scope;
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    if (binderCache) binderCache.set(binder, wrapped);
    return wrapped;
  }

  function wrapContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return ctx;
    if (contextCache && contextCache.has(ctx)) return contextCache.get(ctx);
    var wrapped = new Proxy(ctx, {
      get: function(target, property) {
        if (property === 'settingsScope') return wrapBinder(Reflect.get(target, property, target));
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    if (contextCache) contextCache.set(ctx, wrapped);
    return wrapped;
  }

  function patchLoader(loader) {
    if (!loader || typeof loader.load !== 'function' || loader.load.__visionRouterLocalPermission) return;
    var original = loader.load;
    function load(spec) {
      if (spec && spec.id === 'dsh-vision-router' && typeof spec.factory === 'function') {
        var factory = spec.factory;
        spec = Object.assign({}, spec, {
          factory: function(require) {
            var exports = factory(require);
            if (exports && typeof exports.apply === 'function' && !exports.apply.__visionRouterLocalPermission) {
              var apply = exports.apply;
              var wrappedApply = function(ctx) {
                var rest = Array.prototype.slice.call(arguments, 1);
                return apply.apply(exports, [wrapContext(ctx)].concat(rest));
              };
              Object.defineProperty(wrappedApply, '__visionRouterLocalPermission', { value: true });
              exports.apply = wrappedApply;
            }
            return exports;
          }
        });
      }
      return original.call(loader, spec);
    }
    Object.defineProperty(load, '__visionRouterLocalPermission', { value: true });
    loader.load = load;
  }

  function install() {
    if (window.__ModuleLoader__) {
      patchLoader(window.__ModuleLoader__);
      return;
    }
    var descriptor = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__');
    if (descriptor && descriptor.configurable === false) return;
    if (descriptor && typeof descriptor.set === 'function') {
      var previousGet = descriptor.get;
      var previousSet = descriptor.set;
      Object.defineProperty(window, '__ModuleLoader__', {
        configurable: true,
        enumerable: descriptor.enumerable !== false,
        get: function(){ return previousGet ? previousGet.call(window) : undefined; },
        set: function(value) {
          previousSet.call(window, value);
          try { patchLoader(window.__ModuleLoader__ || value); } catch (_) {}
        }
      });
      return;
    }
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

  try { install(); } catch (_) {}
})();`

export function injectLocalPermissionClientPrelude(html) {
  if (typeof html !== 'string' || html.includes(LOCAL_PERMISSION_PRELUDE_MARK)) return html
  const script = `<script ${LOCAL_PERMISSION_PRELUDE_MARK}>${LOCAL_PERMISSION_CLIENT_PRELUDE.replace(/<\/script/gi, '<\\/script')}</script>`
  const endHead = html.indexOf('</head>')
  return endHead === -1 ? `${html}${script}` : `${html.slice(0, endHead)}${script}${html.slice(endHead)}`
}

/**
 * Dedicated Connection RPC channel plus the one loopback-only bootstrap
 * permission path. The remote carrier remains trusted-host + explicit opt-in;
 * the local HTTP route independently requires a loopback peer, localhost Host,
 * same origin, JSON POST, and permits no field except allowRemoteSettings.
 */
export function installVisionRouterRemoteSettingsBridge(ctx, logger) {
  ctx.inject(['settings', 'connection'], (remoteCtx) => {
    const handler = createVisionRouterRemoteSettingsHandler(remoteCtx.settings, logger ?? remoteCtx.logger)
    remoteCtx.effect(
      () => remoteCtx.connection.rpc.handle(
        REMOTE_SETTINGS_CHANNEL,
        handler,
        { authority: 'trusted-host' },
      ),
      'vision-router: opt-in remote settings channel',
    )
  })
  ctx.inject(['settings', 'webServer'], (localCtx) => {
    const localLogger = logger ?? localCtx.logger
    const handler = createVisionRouterLocalPermissionHttpHandler(localCtx.settings, localLogger)
    localCtx.effect(
      () => localCtx.webServer.register({
        kind: 'exact',
        path: LOCAL_REMOTE_SETTINGS_PERMISSION_PATH,
        handler,
      }),
      'vision-router: loopback remote-settings permission mutation',
    )
    localCtx.effect(
      () => localCtx.webServer.tapIndex(injectLocalPermissionClientPrelude),
      'vision-router: local settings permission client shim',
    )
  })
}
