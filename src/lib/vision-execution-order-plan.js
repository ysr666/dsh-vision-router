import {
  candidateKeyForConfiguredPair,
  configuredVisionPairs,
} from './vision-routing-evidence.js'

function pairForExecutionKey(key, configuredByKey) {
  const configured = configuredByKey.get(key)
  if (configured) return configured
  // Enabled local backends already participate in the legacy tool chain. Auto
  // may move them earlier, but may not invent arbitrary unconfigured routes.
  if (typeof key === 'string' && key.startsWith('vision-http/local-')) {
    const model = key.slice('vision-http/'.length)
    return model ? { provider: 'vision-http', model } : undefined
  }
  return undefined
}

/**
 * Convert planner keys into the narrow provider/model order P1 execution will
 * eventually place in VisionExecutionOrderContext.
 *
 * Invariants are intentionally identical to the historical fake-settings path:
 * - configured routes omitted by evidence are retained at the tail;
 * - local Router backends may be moved earlier because they already exist in v1;
 * - arbitrary unconfigured/discovered routes are never synthesized;
 * - duplicates collapse by provider/model identity;
 * - unchanged order returns undefined so Ordered/no-op behavior stays untouched.
 */
export function executionOrderForSuggestedKeys(config, suggestedOrder = []) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || !Array.isArray(suggestedOrder)) {
    return undefined
  }

  const original = configuredVisionPairs(config)
  const configuredByKey = new Map()
  for (const pair of original) {
    const key = candidateKeyForConfiguredPair(pair)
    if (key && !configuredByKey.has(key)) configuredByKey.set(key, pair)
  }

  const next = []
  const seen = new Set()
  const addPair = (pair) => {
    if (!pair) return
    const id = `${pair.provider}\u0000${pair.model}`
    if (seen.has(id)) return
    seen.add(id)
    next.push({ provider: pair.provider, model: pair.model })
  }

  for (const key of suggestedOrder) addPair(pairForExecutionKey(key, configuredByKey))
  for (const pair of original) addPair(pair)
  if (next.length === 0) return undefined

  const originalIds = original.map((pair) => `${pair.provider}\u0000${pair.model}`)
  const nextIds = next.map((pair) => `${pair.provider}\u0000${pair.model}`)
  if (
    originalIds.length === nextIds.length
    && originalIds.every((id, index) => id === nextIds[index])
  ) {
    return undefined
  }
  return next
}
