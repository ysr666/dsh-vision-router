import z from '@deepseek-ai/schemastery'

// Increment whenever the browser-visible settings contract gains a field whose
// absence changes write semantics. The resolved schema also publishes this as
// a read-only-by-convention handshake for browser/Host compatibility checks.
export const SETTINGS_CONTRACT_REVISION = 7 as const

/**
 * Compose DVR's public product settings onto the mature Core schema.
 *
 * Schemastery object schemas expose set() as the supported replacement seam.
 * Mutating the supplied object is deliberate: Core later registers this exact
 * Config identity with Settings, so a cloned/public-only schema would let the
 * exported contract and runtime validation drift apart.
 */
export function composePublicVisionConfig<T extends Schemastery>(coreConfig: T): T {
  if (!coreConfig || typeof coreConfig.set !== 'function') {
    throw new TypeError('Vision Router public config requires a Schemastery object schema')
  }

  coreConfig.set('progressiveTools', z.boolean().default(false))

  // Keep provider/task/turn timeout layers coherent. The whole-turn budget is
  // an optional safety cap: 0 remains unlimited for long-running agent turns.
  coreConfig.set(
    'visionTaskTimeoutMs',
    z.number().step(1000).min(1000).max(180000).default(120000),
  )
  coreConfig.set('visionTurnBudgetMs', z.number().step(1000).min(0).max(600000).default(0))

  // Both visible settings entry points edit the same Host-owned namespace.
  coreConfig.set('visionDepth', z.union(['fast', 'standard', 'deep', 'custom']).default('standard'))
  coreConfig.set('visionDepthMaxCalls', z.number().step(1).min(0).max(100).default(0))

  // Product semantics: ordered remains the safe default. Auto execution and
  // background measurement each require explicit live user authority.
  coreConfig.set('routingMode', z.union(['ordered', 'auto']).default('ordered'))
  coreConfig.set(
    'routingPreference',
    z.union(['balanced', 'quality', 'speed', 'local']).default('balanced'),
  )
  coreConfig.set(
    'backgroundBenchmarking',
    z.union(['local-free', 'all', 'off']).default('off'),
  )

  // Remote Settings remains an explicit opt-in product permission. The remote
  // risk dialog is a reminder/acknowledgement, not a server-side auth proof.
  coreConfig.set('allowRemoteSettings', z.boolean().default(false))

  coreConfig.set(
    'settingsContractRevision',
    z.number().step(1).min(1).max(SETTINGS_CONTRACT_REVISION).default(SETTINGS_CONTRACT_REVISION),
  )

  return coreConfig
}
