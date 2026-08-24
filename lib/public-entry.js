import * as base from '../entry.js'
import { createVisionToggleRootHardening } from './vision-toggle-root-hardening.js'
import { contextWithVisionRoutingTopologyRefresh } from './vision-routing-topology-refresh.js'

export * from '../entry.js'

/**
 * Public package entry: keep the mature entry.js implementation intact and
 * place the #284 hardening at its outermost registration/browser boundary.
 */
export function apply(ctx, config = {}) {
  const hardening = createVisionToggleRootHardening(ctx, config)
  const runtimeCtx = contextWithVisionRoutingTopologyRefresh(hardening.ctx)
  const result = base.apply(runtimeCtx, hardening.config)
  hardening.installClientBoundary()
  return result
}
