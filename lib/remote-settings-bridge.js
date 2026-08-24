import { installLocalRemoteSettingsPermissionBridge } from './local-remote-settings-permission.js'
import { installRemoteSettingsRiskConfirmationBridge } from './remote-settings-risk-confirmation.js'
import { installSettingsIaClientPrelude } from './settings-ia-client-prelude.js'
import { installLegacySettingsMigration } from './settings-migration.js'
import { installV2SettingsIaIntegration } from './v2-settings-ia-integration.js'

const SETTINGS_NS = 'vision-router'

export const REMOTE_SETTINGS_CHANNEL = '/vision-router-settings'
export const REMOTE_SETTINGS_PERMISSION = 'allowRemoteSettings'
export const REMOTE_SETTINGS_AUTHORIZE_ENDPOINT = 'authorize'

// Remote DSH pages are deliberately less privileged than the loopback settings UI.
// This is a capability allow-list, not a blacklist: a future Config field is local-only
// until it is reviewed and explicitly added here.
export const REMOTE_SETTINGS_READABLE_FIELDS = Object.freeze([
  'providers',
  'routing',
  'reverseRouting',
  'routingMode',
  'routingPreference',
  'backgroundBenchmarking',
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
  'visionTurnBudgetMs',
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
  if (!mutable.has(field)) return { error: 'Vision Router setting ' + JSON.stringify(field) + ' is local-only' }
  const value = descriptor && descriptor.value
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, field)) return { error: 'unknown Vision Router settings field ' + JSON.stringify(field) }
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
    try { return { ok: true, value: accessSnapshot(settings) } }
    catch { return settingsRejected('Vision Router settings changed but the refreshed view could not be read') }
  }
}

export function installVisionRouterRemoteSettingsBridge(ctx, logger) {
  ctx.inject(['settings', 'connection'], (remoteCtx) => {
    const handler = createVisionRouterRemoteSettingsHandler(remoteCtx.settings, logger ?? remoteCtx.logger)
    remoteCtx.effect(
      () => remoteCtx.connection.rpc.handle(REMOTE_SETTINGS_CHANNEL, handler, { authority: 'trusted-host' }),
      'vision-router: opt-in remote settings channel',
    )
  })
  installRemoteSettingsRiskConfirmationBridge(ctx)
  installLocalRemoteSettingsPermissionBridge(ctx, logger)
  installV2SettingsIaIntegration(ctx)
  installSettingsIaClientPrelude(ctx)
  installLegacySettingsMigration(ctx, logger)
}
