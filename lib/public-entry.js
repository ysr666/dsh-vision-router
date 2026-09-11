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
 * Router-owned provider transport is installed before runtime composition.
 * After base.apply installs the mature Host/DVR fetch wrappers, the legacy proxy
 * boundary adds one outer compatibility shim. That shim is transparent unless
 * AsyncLocalStorage proves a configured Host-owned visual adapter call is active
 * (plus the explicitly retained direct whole-turn legacy fallback). Blank proxy
 * settings therefore leave DSH/Host as the sole network authority.
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
