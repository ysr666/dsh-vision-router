import * as base from '../entry.js'
import { createVisionToggleRootHardening } from './vision-toggle-root-hardening.js'
import { contextWithVisionRoutingTopologyRefresh } from './vision-routing-topology-refresh.js'
import {
  createVisionProviderTransport,
  installVisionProviderTransport,
} from './vision-provider-transport.js'

export * from '../entry.js'

function liveVisionConfig(ctx, fallback) {
  try {
    const settings = ctx?.get?.('settings')
    const value = settings?.get?.('vision-router')
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  } catch {
    // Before Settings mounts, composition config is the authoritative fallback.
  }
  return fallback
}

/**
 * Public package entry: keep the mature entry.js implementation intact and
 * place the #284 hardening at its outermost registration/browser boundary.
 *
 * P2 also installs the Router-owned provider transport here, before base.apply
 * can install the legacy process-wide proxy fetch patch. The transport module
 * captured the original fetch at module load and reads live Vision Router
 * settings on every request, so direct visual-provider HTTP can use an explicit
 * dispatcher without depending on global fetch mutation.
 */
export function apply(ctx, config = {}) {
  const hardening = createVisionToggleRootHardening(ctx, config)
  const runtimeCtx = contextWithVisionRoutingTopologyRefresh(hardening.ctx)
  const transport = createVisionProviderTransport({
    ctx: hardening.ctx,
    config: () => liveVisionConfig(hardening.ctx, config),
  })
  const releaseTransport = installVisionProviderTransport(transport)
  try {
    runtimeCtx?.effect?.(
      () => releaseTransport,
      'vision-router: provider transport',
    )
    const result = base.apply(runtimeCtx, hardening.config)
    hardening.installClientBoundary()
    return result
  } catch (error) {
    releaseTransport()
    throw error
  }
}
