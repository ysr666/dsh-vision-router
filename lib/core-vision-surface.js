import {
  currentSessionSurfacePolicy,
  resolveSessionSurfacePolicy,
} from './session-surface-policy.js'

const CORE_SURFACE_KEYS = Object.freeze([
  'tool',
  'rewriteImages',
  'instantDescribe',
  'autoActivateOnImage',
  'structuredVisionBootstrap',
])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

/**
 * Explicit core-facing projection of the SessionSurfacePolicy.
 *
 * During C1-A this is a parity seam only: production still uses the legacy
 * Settings/config bridge. The returned object carries only the five config
 * values that the legacy bridge may override plus the already-resolved image
 * ownership facts. It deliberately cannot masquerade as a Settings service or
 * a full plugin config object.
 *
 * C1 switches core reads to this value only after old/new parity is proven.
 */
export function projectCoreVisionSurface(config = {}, sessionPolicy) {
  const value = isObject(config) ? config : {}
  const policy = sessionPolicy && typeof sessionPolicy === 'object'
    ? sessionPolicy
    : resolveSessionSurfacePolicy({ config: value })
  const overrides = isObject(policy.legacyConfigOverrides)
    ? policy.legacyConfigOverrides
    : {}
  const projected = {}

  for (const key of CORE_SURFACE_KEYS) {
    projected[key] = own(overrides, key) ? overrides[key] : value[key]
  }

  return Object.freeze({
    ownership: policy.ownership,
    preserveRawImages: policy.preserveRawImages === true,
    rewriteCurrentImages: policy.rewriteCurrentImages === true,
    values: Object.freeze(projected),
  })
}

/** Resolve an explicit core surface from an explicit ownership-policy input. */
export function resolveCoreVisionSurface({
  visionPolicy,
  config = {},
  schemaBootstrapping = false,
} = {}) {
  const value = isObject(config) ? config : {}
  return projectCoreVisionSurface(
    value,
    resolveSessionSurfacePolicy({
      visionPolicy,
      config: value,
      schemaBootstrapping,
    }),
  )
}

/** Resolve the current turn-local surface without exposing a Settings facade. */
export function currentCoreVisionSurface(config = {}, options = {}) {
  const value = isObject(config) ? config : {}
  return projectCoreVisionSurface(
    value,
    currentSessionSurfacePolicy(value, {
      schemaBootstrapping: options?.schemaBootstrapping === true,
    }),
  )
}

export const CORE_VISION_SURFACE_KEYS = CORE_SURFACE_KEYS
