import { currentSessionVisionPolicy } from './native-image-coexistence.js'
import { currentSessionVisionModeAuthority } from './session-vision-mode-authority.js'
import { resolveSessionSurfacePolicy } from './session-surface-policy-domain.js'

export { resolveSessionSurfacePolicy } from './session-surface-policy-domain.js'

/** Read the turn-local ownership + mode snapshots and resolve the Core surface. */
export function currentSessionSurfacePolicy(config = {}, options = {}) {
  return resolveSessionSurfacePolicy({
    visionPolicy: currentSessionVisionPolicy(),
    visionModeAuthority: currentSessionVisionModeAuthority(),
    config,
    schemaBootstrapping: options?.schemaBootstrapping === true,
  })
}
