// Public plugin entrypoint.
//
// P3-F keeps this file as the public schema/export boundary. Runtime ownership
// lives in lib/runtime-composition.js; the mature core remains in index.js.

import z from '@deepseek-ai/schemastery'
import * as core from './index.js'
import { applyVisionRuntimeComposition } from './lib/runtime-composition.js'

// Increment whenever the browser-visible settings contract gains a field whose
// absence changes write semantics. This revision is also exposed as a resolved
// schema default so a newer browser client can distinguish a genuinely updated
// Host from a stale in-process plugin module instead of reporting a generic
// readback mismatch after the old Host rejects a newly visible field.
export const SETTINGS_CONTRACT_REVISION = 7

// Schemastery object schemas expose set() as the supported way to replace a
// field schema. This mutates the Config object that index.js itself later uses
// for the settings namespace, so composition config and settings validation
// agree on the same default.
core.Config.set('progressiveTools', z.boolean().default(false))
// Keep the timeout layers coherent: one provider call may use up to 120s and
// one visual task (including fallbacks) shares 120s. The whole-turn visual
// budget is an optional user safety cap rather than an Agent lifetime policy:
// 0 means unlimited, which is the default for long-running autonomous turns.
core.Config.set('visionTaskTimeoutMs', z.number().step(1000).min(1000).max(180000).default(120000))
core.Config.set('visionTurnBudgetMs', z.number().step(1000).min(0).max(600000).default(0))

// Both visible entry points — Settings > Vision Router and the legacy
// Settings > Plugins compatibility card — edit the same Host-owned namespace.
core.Config.set('visionDepth', z.union(['fast', 'standard', 'deep', 'custom']).default('standard'))
core.Config.set('visionDepthMaxCalls', z.number().step(1).min(0).max(100).default(0))

// Product semantics: ordered remains the safe default; Auto changes execution
// only under explicit live routingMode:auto authority.
core.Config.set('routingMode', z.union(['ordered', 'auto']).default('ordered'))
core.Config.set(
  'routingPreference',
  z.union(['balanced', 'quality', 'speed', 'local']).default('balanced'),
)
// Background measurement is separate user authority; absence never grants it.
core.Config.set(
  'backgroundBenchmarking',
  z.union(['local-free', 'all', 'off']).default('off'),
)

// Settings surfaces and Host persistence must agree on this field.
core.Config.set('allowRemoteSettings', z.boolean().default(false))

// Internal read-only-by-convention handshake. It is not rendered by Vision
// Router's settings UI and is not in the remote mutable allow-list.
core.Config.set(
  'settingsContractRevision',
  z.number().step(1).min(1).max(SETTINGS_CONTRACT_REVISION).default(SETTINGS_CONTRACT_REVISION),
)

export * from './index.js'
export {
  attachmentContextForContract,
  ensureVisionAttachmentAdmissionPolicy,
  hasBatchAttachmentContract,
  installHostSettingsCompatibility,
  installVisionAttachmentAdmissionPolicy,
  protectHostProviderOwnership,
  // Transitional public aliases retained for callers/tests written during the
  // rc.7 compatibility pass. Production runtime branches on feature seams.
  installRc7SettingsCompatibility,
  isRc7ContractRuntime,
  protectRc7ProviderOwnership,
} from './lib/dsh-contract-compat.js'
export const Config = core.Config

// Defense in depth for direct/programmatic callers is implemented by the same
// production composition used by Cordis. This public entry intentionally owns
// no runtime installer ordering beyond that single call.
export function apply(ctx, config = {}) {
  return applyVisionRuntimeComposition(ctx, config, core)
}
