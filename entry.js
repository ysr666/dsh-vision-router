// Public plugin entrypoint.
//
// P3-F keeps this file as the public schema/export boundary. Runtime ownership
// lives in lib/runtime-composition.js; the mature core remains in index.js.

import * as core from './index.js'
import {
  composePublicVisionConfig,
  SETTINGS_CONTRACT_REVISION,
} from './lib/public-config.js'
import { applyVisionRuntimeComposition } from './lib/runtime-composition.js'

export { SETTINGS_CONTRACT_REVISION }

export const Config = composePublicVisionConfig(core.Config)

export * from './index.js'
export { sessionSurfaceReplacementIntent } from './lib/session-surface-compat.js'
export {
  attachmentContextForContract,
  ensureVisionAttachmentAdmissionPolicy,
  hasBatchAttachmentContract,
  hostOwnsOfficialDeepSeekProvider,
  installHostSettingsCompatibility,
  installVisionAttachmentAdmissionPolicy,
  protectHostProviderOwnership,
  // Transitional public aliases retained for callers/tests written during the
  // rc.7 compatibility pass. Production runtime branches on feature seams.
  installRc7SettingsCompatibility,
  isRc7ContractRuntime,
  protectRc7ProviderOwnership,
} from './lib/dsh-contract-compat.js'
// Defense in depth for direct/programmatic callers is implemented by the same
// production composition used by Cordis. This public entry intentionally owns
// no runtime installer ordering beyond that single call.
export function apply(ctx, config = {}, runtime = {}) {
  return applyVisionRuntimeComposition(ctx, config, core, runtime)
}
