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
 * Narrow ownership boundary for Session-local Vision Router state.
 *
 * This object owns only one bounded state store and one index. It is not a
 * general runtime service locator. The index receives the store explicitly and
 * never discovers or mutates process-global ownership state.
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
  })

  return Object.freeze({
    stateStore: store,
    index,
  })
}
