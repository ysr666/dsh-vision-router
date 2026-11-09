import { installLocalRemoteSettingsPermissionBridge } from './local-remote-settings-permission.js'
import { installRemoteSettingsRiskConfirmationBridge } from './remote-settings-risk-confirmation.js'
import { installSettingsIaClientPrelude } from './settings-ia-client-prelude.js'
import { installLegacySettingsMigration } from './settings-migration.js'
import { installV2SettingsIaIntegration } from './v2-settings-ia-integration.js'
import { remoteConfigFieldAdmissionError } from './runtime-config-normalizer.js'

const SETTINGS_NS = 'vision-router'

export const REMOTE_SETTINGS_CHANNEL = '/vision-router-settings'
export const REMOTE_SETTINGS_PERMISSION = 'allowRemoteSettings'
export const REMOTE_SETTINGS_AUTHORIZE_ENDPOINT = 'authorize'

// Remote settings are an opt-in view of the *same* Host-owned DVR namespace.
// No second field allow-list: after the once-per-profile risk acknowledgement,
// DSH-authenticated clients can edit any ordinary field admitted by the Host
// schema. The permission flag itself is managed through the explicit
// risk-confirmation/revocation flow, not as an ordinary settings mutation.
const REDACTED = '[REDACTED]'
const SECRET_KEY = /(?:password|passwd|private.?key|(?:api|access|refresh).?token|token|secret|credential|api.?key|authorization)/i

function redactUrl(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return value
  try {
    const url = new URL(value)
    let changed = false
    if (url.username || url.password) {
      url.username = REDACTED
      url.password = REDACTED
      changed = true
    }
    for (const key of url.searchParams.keys()) {
      if (SECRET_KEY.test(key)) { url.searchParams.set(key, REDACTED); changed = true }
    }
    return changed ? url.toString() : value
  } catch { return value }
}

function containsRedactedCredential(value, field = '') {
  // A remote descriptor may contain a redacted proxy or endpoint URL. If a
  // user edits that form field and re-saves it, a masked placeholder is NOT a
  // credential and must never overwrite the original value in Host settings.
  if (field !== 'apiKeyEnv' && field !== 'credentialRef' &&
      SECRET_KEY.test(field) && value === REDACTED) return true
  if (typeof value === 'string' && /^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      if ([url.username, url.password].some((part) => {
        try { return decodeURIComponent(part) === REDACTED } catch { return true }
      })) return true
      for (const [key, part] of url.searchParams) {
        if (SECRET_KEY.test(key) && part === REDACTED) return true
      }
    } catch { /* Leave malformed URLs to the Host schema. */ }
  }
  if (Array.isArray(value)) return value.some((part) => containsRedactedCredential(part))
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, part]) => containsRedactedCredential(part, key))
  }
  return false
}

function safeSettingsValue(value, field = '') {
  // The DSH descriptor is already Host-redacted. These additional guards
  // cover plain-text proxy URL userinfo and future nested secret-shaped fields
  // without reintroducing a field-level *capability* allow-list.
  if (field !== 'apiKeyEnv' && field !== 'credentialRef' && SECRET_KEY.test(field)) return REDACTED
  if (Array.isArray(value)) return value.map((item) => safeSettingsValue(item))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      out[key] = safeSettingsValue(item, key)
    }
    return out
  }
  return redactUrl(value)
}

function badRequest(message) {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function settingsRejected(message) {
  return { ok: false, error: { code: 'settings-rejected', message, details: { ns: SETTINGS_NS } } }
}

function project(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out = safeSettingsValue(value)
  // Permission is not a normal remote-editable field. The authenticated
  // describe envelope already exposes enabled/disabled state explicitly.
  delete out[REMOTE_SETTINGS_PERMISSION]
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
  if (!descriptor) return { enabled: false, reason: 'namespace-unavailable', writable: false }
  const value = descriptor.value
  const enabled = !!value && typeof value === 'object' && value[REMOTE_SETTINGS_PERMISSION] === true
  if (!enabled) return { enabled: false, reason: 'permission-disabled', writable: false }
  return { enabled: true, reason: 'enabled', writable: settings.writable === true, view: publicView(descriptor) }
}

function validateMutation(payload, descriptor) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return { error: 'payload must be an object' }
  const { ops, expectedRevision } = payload
  if (!Array.isArray(ops) || ops.length !== 1) return { error: 'exactly one top-level settings operation is required' }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) return { error: 'expectedRevision must be a non-negative integer' }
  const op = ops[0]
  if (typeof op !== 'object' || op === null || Array.isArray(op)) return { error: 'settings operation must be an object' }
  if (op.op !== 'set' && op.op !== 'unset') return { error: 'settings operation must be set or unset' }
  if (!Array.isArray(op.path) || op.path.length !== 1 || typeof op.path[0] !== 'string' || op.path[0] === '') return { error: 'remote settings may edit one top-level field at a time' }
  const field = op.path[0]
  if (field === '__proto__' || field === 'prototype' || field === 'constructor') return { error: 'unsafe settings field name' }
  if (field === REMOTE_SETTINGS_PERMISSION) return { error: 'Remote permission is managed by risk confirmation and local revocation' }
  const value = descriptor && descriptor.value
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, field)) return { error: 'unknown Vision Router settings field ' + JSON.stringify(field) }
  if (op.op === 'set') {
    const budgetError = remoteConfigFieldAdmissionError(field, op.value)
    if (budgetError) return { error: budgetError }
    if (containsRedactedCredential(op.value, field)) {
      return { error: 'masked credentials cannot be saved; re-enter the credential value before editing this field' }
    }
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

/**
 * PRODUCT CONTRACT (2.3+): remote-settings enablement is reminder-only.
 *
 * `acceptedRisk === true` is an acknowledgement bit for the UX flow, not an
 * authentication/authorization credential, proof of local presence, challenge
 * response, one-time secret, or administrator approval. Do not strengthen this
 * endpoint into a second authentication mechanism. Security is enforced by
 * the DSH-authenticated Connection carrier, the persisted opt-in, the Host
 * schema and resource bounds. Sensitive stored values are redacted on reads.
 * The historical RPC name "authorize" does not mean user authentication.
 */
export async function authorizeRemoteSettingsAfterRiskConfirmation(settings, payload, logger) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.acceptedRisk !== true) {
    return badRequest('acceptedRisk must be true')
  }

  let descriptor
  try {
    descriptor = namespaceDescriptor(settings)
  } catch (error) {
    logger?.warn?.('vision-router: remote settings authorization describe failed: %s', error?.message ?? String(error))
    return settingsRejected('Vision Router settings could not be read')
  }
  if (!descriptor) return settingsRejected('Vision Router settings namespace is unavailable')
  if (settings.writable !== true) return settingsRejected('Vision Router settings provider is read-only')

  const value = descriptor.value
  if (value && typeof value === 'object' && value[REMOTE_SETTINGS_PERMISSION] === true) {
    return { ok: true, value: accessSnapshot(settings) }
  }
  if (!Number.isInteger(descriptor.revision) || descriptor.revision < 0) {
    return settingsRejected('Vision Router settings revision is unavailable')
  }

  try {
    await settings.mutate(
      SETTINGS_NS,
      [{ op: 'set', path: [REMOTE_SETTINGS_PERMISSION], value: true }],
      descriptor.revision,
    )
  } catch (error) {
    const conflict = conflictResult(error)
    if (conflict) return conflict
    logger?.warn?.('vision-router: remote settings authorization rejected: %s', error?.message ?? String(error))
    return settingsRejected(error?.message ?? 'Vision Router remote settings authorization was rejected')
  }

  try {
    const access = accessSnapshot(settings)
    if (access.enabled !== true) return settingsRejected('Vision Router remote settings authorization did not persist')
    return { ok: true, value: access }
  } catch {
    return settingsRejected('Vision Router remote settings were enabled but could not be read back')
  }
}

/**
 * Register the dedicated settings channel against the active DSH Connection
 * trust contract. rc.8 requires a per-channel `trusted-host` policy. Newer
 * Connection carriers expose `requestRejection()` and authenticate every
 * dedicated RPC route before dispatch, while `rpc.handle()` accepts only the
 * channel and handler. Feature-detect the carrier-owned trust fence rather
 * than passing a security-looking argument that modern Hosts do not consume.
 */
export function registerVisionRouterRemoteSettingsChannel(connection, handler) {
  if (!connection || typeof connection !== 'object' || !connection.rpc || typeof connection.rpc.handle !== 'function') {
    throw new TypeError('Vision Router remote settings requires DSH Connection RPC handle()')
  }
  if (typeof connection.requestRejection === 'function') {
    return connection.rpc.handle(REMOTE_SETTINGS_CHANNEL, handler)
  }
  return connection.rpc.handle(REMOTE_SETTINGS_CHANNEL, handler, { authority: 'trusted-host' })
}

export function createVisionRouterRemoteSettingsHandler(settings, logger) {
  return async (endpoint, payload) => {
    if (endpoint === 'describe') {
      try { return { ok: true, value: accessSnapshot(settings) } }
      catch (error) {
        logger?.warn?.('vision-router: remote settings describe failed: %s', error?.message ?? String(error))
        return settingsRejected('Vision Router settings could not be read')
      }
    }
    if (endpoint === REMOTE_SETTINGS_AUTHORIZE_ENDPOINT) {
      return authorizeRemoteSettingsAfterRiskConfirmation(settings, payload, logger)
    }
    if (endpoint !== 'mutate') return badRequest('unknown Vision Router remote settings endpoint ' + JSON.stringify(endpoint))

    let descriptor
    let access
    try {
      descriptor = namespaceDescriptor(settings)
      if (!descriptor) return { ok: true, value: { enabled: false, reason: 'namespace-unavailable', writable: false } }
      const enabled = !!descriptor.value && typeof descriptor.value === 'object' && descriptor.value[REMOTE_SETTINGS_PERMISSION] === true
      if (!enabled) return { ok: true, value: { enabled: false, reason: 'permission-disabled', writable: false } }
      access = { enabled: true, reason: 'enabled', writable: settings.writable === true, view: publicView(descriptor) }
    } catch {
      return settingsRejected('Vision Router settings could not be read before the write')
    }
    if (!access.writable) return settingsRejected('Vision Router settings provider is read-only')

    const validated = validateMutation(payload, descriptor)
    if (validated.error) return badRequest(validated.error)
    try { await settings.mutate(SETTINGS_NS, validated.ops, validated.expectedRevision) }
    catch (error) {
      const conflict = conflictResult(error)
      if (conflict) return conflict
      logger?.warn?.('vision-router: remote settings mutation rejected: %s', error?.message ?? String(error))
      return settingsRejected(error?.message ?? 'Vision Router settings write was rejected')
    }
    try {
      const after = namespaceDescriptor(settings)
      const result = accessSnapshot(settings)
      if (validated.ops[0].op === 'set' && result.enabled && after) {
        const field = validated.ops[0].path[0]
        const requested = validated.ops[0].value
        const persisted = after.value?.[field]
        // The Host may normalize values. Only echo what this caller already
        // provided if the authoritative persisted value matches exactly.
        if (JSON.stringify(persisted) === JSON.stringify(requested)
            && JSON.stringify(result.view.value[field]) !== JSON.stringify(requested)) {
          result.view.value[field] = structuredClone(requested)
          if (Object.hasOwn(after.user ?? {}, field)) result.view.user[field] = structuredClone(requested)
        }
      }
      return { ok: true, value: result }
    } catch { return settingsRejected('Vision Router settings changed but the refreshed view could not be read') }
  }
}

export function installVisionRouterRemoteSettingsBridge(ctx, logger) {
  // Declare the services this caller uses directly. Current DSH Connection
  // accessors additionally trace their route owner through the Connection
  // provider fiber; cordis.patch.yml therefore keeps that provider activated
  // on webServer as a separate compatibility boundary (#478).
  ctx.inject(['settings', 'connection', 'webServer'], (remoteCtx) => {
    const handler = createVisionRouterRemoteSettingsHandler(remoteCtx.settings, logger ?? remoteCtx.logger)
    remoteCtx.effect(
      () => registerVisionRouterRemoteSettingsChannel(remoteCtx.connection, handler),
      'vision-router: opt-in remote settings channel',
    )
  })
  installRemoteSettingsRiskConfirmationBridge(ctx)
  installLocalRemoteSettingsPermissionBridge(ctx, logger)
  installV2SettingsIaIntegration(ctx)
  installSettingsIaClientPrelude(ctx)
  installLegacySettingsMigration(ctx, logger)
}
