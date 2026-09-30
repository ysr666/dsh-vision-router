import './abort-signal-compat.js'
import * as base from '../entry.js'
import { createVisionToggleRootHardening } from './vision-toggle-root-hardening.js'
import { contextWithVisionRoutingTopologyRefresh } from './vision-routing-topology-refresh.js'
import { createVisionProviderTransport } from './vision-provider-transport.js'
import { installLegacyGlobalProxyBoundary } from './legacy-global-proxy-boundary.js'
import { installDsh017SettingsCompatibility } from './dsh-settings-017-compat.js'
import { installDsh017RootLocalSettingsTransport } from './web/dsh-settings-017-root-transport.js'
import { installSettings017ClientCompatibility } from './settings-client-017-compat.js'
import { installVisionRouterMessageSourceBoundary } from './session-message-source-compat.js'

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
  // DSH 0.1.7 replaces SettingsProvider.register() with profile-owned
  // ConfigEditor writes for ordinary fields. Feature-detect that exact contract
  // and present DVR's mature settings face without changing older Hosts.
  const settingsCtx = installDsh017SettingsCompatibility(ctx, config, {
    namespace: 'vision-router',
    Config: base.Config,
  })
  // The 0.1.7 browser no longer exposes settingsScope. Keep the server route on
  // the application root so ConfigEditor reconciliation cannot dispose an
  // in-flight Settings POST, while each DVR generation supplies the live facade.
  installDsh017RootLocalSettingsTransport(settingsCtx)
  installSettings017ClientCompatibility(settingsCtx)
  // Session V3 and V4 disagree on plugin message attribution. Normalize only
  // DVR-authored contexts at the final hook-publication seam using the Session's
  // own durable header version, never a DSH package-version guess.
  const sessionSourceCtx = installVisionRouterMessageSourceBoundary(settingsCtx)
  const hardening = createVisionToggleRootHardening(sessionSourceCtx, config)
  const runtimeCtx = contextWithVisionRoutingTopologyRefresh(hardening.ctx)
  const transport = createVisionProviderTransport({
    ctx: hardening.ctx,
    config: () => liveVisionConfig(hardening.ctx, config),
  })
  let transportReleased = false
  const releaseTransport = () => {
    if (transportReleased) return
    transportReleased = true
    void transport.dispose()
  }
  try {
    runtimeCtx?.effect?.(
      () => releaseTransport,
      'vision-router: provider transport',
    )
    const result = base.apply(runtimeCtx, hardening.config, { providerTransport: transport })
    installLegacyGlobalProxyBoundary(runtimeCtx, hardening.config)
    hardening.installClientBoundary()
    return result
  } catch (error) {
    releaseTransport()
    throw error
  }
}
