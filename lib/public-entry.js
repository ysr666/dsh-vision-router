import './abort-signal-compat.js'
import * as base from '../entry.js'
import { createVisionToggleRootHardening } from './vision-toggle-root-hardening.js'
import { contextWithVisionRoutingTopologyRefresh } from './vision-routing-topology-refresh.js'
import {
  createVisionProviderTransport,
  installVisionProviderTransport,
} from './vision-provider-transport.js'
import { installLegacyGlobalProxyBoundary } from './legacy-global-proxy-boundary.js'

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
 * place root hardening at its outermost registration/browser boundary.
 *
 * Router-owned provider transport is installed before base.apply can install
 * the legacy process-wide proxy fetch patch. After base.apply installs that
 * lifecycle-safe seam, the explicit ownership boundary keeps Router-only
 * visual chains off the global patch; only a configured Host-owned/raw-fetch
 * visual provider keeps the legacy seam active.
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
    installLegacyGlobalProxyBoundary(runtimeCtx, hardening.config)
    hardening.installClientBoundary()
    return result
  } catch (error) {
    releaseTransport()
    throw error
  }
}
