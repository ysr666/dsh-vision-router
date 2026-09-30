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

function coreFlags(values) {
  return {
    toolAvailable: values.tool !== false,
    rewriteEnabled: values.rewriteImages !== false,
    instantDescribe: values.instantDescribe === true,
    autoActivateOnImage: values.autoActivateOnImage !== false,
    structuredBootstrap: values.structuredVisionBootstrap === true,
  }
}

/**
 * Explicit core-facing projection of the SessionSurfacePolicy.
 *
 * The returned object carries only the five config values that the historical
 * Settings/config projection could override plus explicit booleans consumed by
 * Core and the already-resolved image ownership facts. It deliberately cannot
 * masquerade as a Settings service or a full plugin config object.
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
    ...coreFlags(projected),
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

/**
 * One explicit production seam for Core's five policy-derived switches.
 *
 * The config source stays live, but schema bootstrap is an internal lifecycle
 * bit rather than a fake Settings/config value. Direct Core callers can keep
 * their two-argument compatibility path; composition passes this runtime as
 * the authoritative production surface.
 */
export function createCoreVisionSurfaceRuntime({ config = {} } = {}) {
  let schemaBootstrapping = true

  const current = () => {
    let source = config
    if (typeof config === 'function') {
      try {
        source = config()
      } catch {
        source = {}
      }
    }
    return currentCoreVisionSurface(isObject(source) ? source : {}, {
      schemaBootstrapping,
    })
  }

  return Object.freeze({
    current,
    finishSchemaBootstrap() {
      schemaBootstrapping = false
    },
  })
}

export const CORE_VISION_SURFACE_KEYS = CORE_SURFACE_KEYS
