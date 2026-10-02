import { currentSessionSurfacePolicy } from './session-surface-policy.js'
import {
  CORE_VISION_SURFACE_KEYS,
  projectCoreVisionSurface,
  resolveCoreVisionSurface,
} from './core-vision-surface-domain.js'

export {
  CORE_VISION_SURFACE_KEYS,
  projectCoreVisionSurface,
  resolveCoreVisionSurface,
} from './core-vision-surface-domain.js'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
 * bit rather than a fake Settings/config value.
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
