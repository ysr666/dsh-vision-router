import { createSessionVisionIndex } from './session-vision-index.js'
import { createSessionVisionStateStore } from './session-vision-state.js'

export const DEFAULT_SESSION_VISION_STATE_OPTIONS = Object.freeze({
  maxSessions: 64,
  idleTtlMs: 60 * 60 * 1000,
  descriptionMaxEntries: 64,
  descriptionMaxChars: 256 * 1024,
  attachmentMaxEntries: 256,
})

/**
 * Narrow C1 ownership boundary for Session-local Vision Router state.
 *
 * This object intentionally owns only the bounded state store and its index.
 * It is not a general runtime service locator. During C1-A production still
 * uses the mature core construction path; parity tests prove this explicit
 * runtime can replace the implicit current-store bridge before the switch.
 *
 * The explicit runtime never monkey-patches stateStore.lookupAttachment().
 * Full durable recovery is requested through index.lookupAttachment(), making
 * ownership visible at the call site before C1 deletes the legacy delegation.
 */
export function createSessionVisionRuntime({
  core,
  config = {},
  logger,
  stateStore,
  stateOptions = {},
} = {}) {
  if (!core || typeof core !== 'object') {
    throw new TypeError('session vision runtime requires core helpers')
  }

  const store = stateStore ?? createSessionVisionStateStore({
    ...DEFAULT_SESSION_VISION_STATE_OPTIONS,
    ...(stateOptions && typeof stateOptions === 'object' ? stateOptions : {}),
  })
  const index = createSessionVisionIndex({
    stateStore: store,
    core,
    config,
    logger,
    legacyLookupDelegation: false,
  })

  return Object.freeze({
    stateStore: store,
    index,
  })
}
