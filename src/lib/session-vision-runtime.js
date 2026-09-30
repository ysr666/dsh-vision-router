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
 * It is not a general runtime service locator. Production composition creates
 * one instance and gives the same owner to the Session boundary and Core.
 *
 * Cache lookup stays synchronous through index.lookupAttachment(); cold durable
 * recovery is explicit through index.resolveAttachment(). The index never
 * monkey-patches stateStore.lookupAttachment(), and receives only narrow Host
 * Session readers rather than the full Context.
 */
export function createSessionVisionRuntime({
  core,
  config = {},
  logger,
  readSessionEvent,
  readSessionLog,
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
    readSessionEvent,
    readSessionLog,
  })

  return Object.freeze({
    stateStore: store,
    index,
  })
}
