// P1 compatibility shim only.
//
// Production routing moved to vision-routing-runtime.js. Keep these historical
// names temporarily for internal tests/background callers that were written
// during the P0/P1 shadow phase; no authority, Settings, Planner or ALS logic
// lives in this module anymore.
export {
  buildVisionRoutingPlan as buildCapabilityShadowPlan,
  installVisionRoutingRuntime as installCapabilityShadowRuntime,
} from './vision-routing-runtime.js'
export {
  collectVisionRoutingCandidates as collectCapabilityShadowCandidates,
  generatedCapabilityRoute,
} from './vision-routing-evidence.js'

import { executionOrderForSuggestedKeys } from './vision-execution-order-plan.js'

/**
 * Historical parity helper. Production execution never consumes this full
 * config-shaped projection; it exists only while old/new pair-order parity
 * remains under test during the P1 migration.
 */
export function autoExecutionConfigFor(config, suggestedOrder = []) {
  const order = executionOrderForSuggestedKeys(config, suggestedOrder)
  if (order === undefined) return undefined
  const first = order[0]
  if (!first) return undefined
  return {
    ...config,
    provider: first.provider,
    model: first.model,
    fallbacks: [],
    providers: order.map((pair) => ({ ...pair, fallbacks: [] })),
  }
}
