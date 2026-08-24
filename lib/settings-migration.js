const SETTINGS_NS = 'vision-router'

export const LEGACY_CHAIN_FIELDS = Object.freeze(['provider', 'model', 'fallbacks'])
export const RETIRED_SETTINGS_FIELDS = Object.freeze([
  'visionGuideStep',
  'instantDescribe',
  'localDescribeStyle',
])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value, key) {
  return isObject(value) && Object.prototype.hasOwnProperty.call(value, key)
}

function stringValue(primary, fallback, defaultValue) {
  if (typeof primary === 'string' && primary.trim() !== '') return primary.trim()
  if (typeof fallback === 'string' && fallback.trim() !== '') return fallback.trim()
  return defaultValue
}

function fallbackValues(primary, fallback) {
  const value = Array.isArray(primary) ? primary : Array.isArray(fallback) ? fallback : []
  return value
    .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    .map((entry) => entry.trim())
}

/**
 * Build one atomic SettingsProvider.mutate plan from the raw user layer.
 *
 * Presence in descriptor.user is authoritative here. The resolved descriptor
 * always contains schema defaults for both the legacy shorthand and `providers`,
 * so looking only at descriptor.value would incorrectly treat every profile as
 * already migrated.
 */
export function legacySettingsMigrationOps(descriptor) {
  if (!descriptor || descriptor.ns !== SETTINGS_NS) return []
  const user = isObject(descriptor.user) ? descriptor.user : {}
  const resolved = isObject(descriptor.value) ? descriptor.value : {}
  const ops = []

  const hasLegacyChain = LEGACY_CHAIN_FIELDS.some((field) => hasOwn(user, field))
  const hasExplicitProviders = hasOwn(user, 'providers')

  if (hasLegacyChain && !hasExplicitProviders) {
    const provider = stringValue(user.provider, resolved.provider, 'vision-http')
    const model = stringValue(user.model, resolved.model, 'ovh/Qwen3.5-397B-A17B')
    const fallbacks = fallbackValues(user.fallbacks, resolved.fallbacks)
    ops.push({
      op: 'set',
      path: ['providers'],
      value: [{ provider, model, fallbacks }],
    })
  }

  for (const field of LEGACY_CHAIN_FIELDS) {
    if (hasOwn(user, field)) ops.push({ op: 'unset', path: [field] })
  }
  for (const field of RETIRED_SETTINGS_FIELDS) {
    if (hasOwn(user, field)) ops.push({ op: 'unset', path: [field] })
  }

  return ops
}

export async function migrateLegacyVisionSettings(settings, logger) {
  if (!settings || typeof settings.describe !== 'function') {
    return { migrated: false, reason: 'settings-unavailable' }
  }
  if (settings.writable !== true || typeof settings.mutate !== 'function') {
    return { migrated: false, reason: 'read-only' }
  }

  let descriptor
  try {
    const descriptors = settings.describe({ redactSecrets: true })
    descriptor = Array.isArray(descriptors)
      ? descriptors.find((entry) => entry && entry.ns === SETTINGS_NS)
      : undefined
  } catch (error) {
    logger?.warn?.(
      'vision-router: legacy settings migration describe failed: %s',
      error?.message ?? String(error),
    )
    return { migrated: false, reason: 'describe-failed' }
  }
  if (!descriptor) return { migrated: false, reason: 'namespace-unavailable' }

  const ops = legacySettingsMigrationOps(descriptor)
  if (ops.length === 0) return { migrated: false, reason: 'clean' }
  if (!Number.isInteger(descriptor.revision) || descriptor.revision < 0) {
    return { migrated: false, reason: 'revision-unavailable' }
  }

  try {
    await settings.mutate(SETTINGS_NS, ops, descriptor.revision)
  } catch (error) {
    logger?.warn?.(
      'vision-router: legacy settings migration failed: %s',
      error?.message ?? String(error),
    )
    return {
      migrated: false,
      reason: error?.code === 'SETTINGS_CONFLICT' ? 'settings-conflict' : 'write-failed',
    }
  }

  logger?.info?.(
    'vision-router: migrated legacy settings fields to the canonical providers chain',
  )
  return { migrated: true, ops }
}

/**
 * Schedule one bounded post-apply migration. Only a real Cordis context owns
 * both `inject` and `get`; narrow unit-test carrier harnesses deliberately do
 * not. A microtask gives core.apply() the rest of the current stack to finish,
 * while two short retries cover Hosts that publish settings asynchronously.
 */
export function installLegacySettingsMigration(ctx, logger) {
  if (!ctx || typeof ctx.inject !== 'function' || typeof ctx.get !== 'function') return
  ctx.inject(['settings'], (migrationCtx) => {
    let disposed = false
    const timers = new Set()
    const localLogger = logger ?? migrationCtx.logger

    const schedule = (delay) => {
      const timer = setTimeout(async () => {
        timers.delete(timer)
        if (disposed) return
        const result = await migrateLegacyVisionSettings(migrationCtx.settings, localLogger)
        if (disposed || result.migrated || result.reason === 'clean' || result.reason === 'read-only') return
        if (delay === 0 && result.reason === 'namespace-unavailable') schedule(50)
        else if (delay === 50 && result.reason === 'namespace-unavailable') schedule(250)
      }, delay)
      timers.add(timer)
    }

    migrationCtx.effect?.(() => {
      schedule(0)
      return () => {
        disposed = true
        for (const timer of timers) clearTimeout(timer)
        timers.clear()
      }
    }, 'vision-router: migrate legacy settings')
  })
}
