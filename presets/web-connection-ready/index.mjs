/**
 * Private, fail-closed bridge for the two supported DSH Web trust generations.
 *
 * It waits for the Host-owned authority source instead of supplying a fake
 * webRuntime service or guessing additional trusted hosts. Its only consumer
 * is the DVR connection row; Host Connection retains all authentication and
 * route ownership.
 */
export const name = 'vision-router-web-connection-ready'
export const inject = ['webStartup', 'webServer']
export const SERVICE = 'visionRouterWebConnectionReady'

/** Return a detached, immutable copy of the Host-approved authority list. */
export function validatedTrustedHosts(value) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('Vision Router Web compatibility: Host trust list is invalid')
  }
  return Object.freeze([...value])
}

export function classifyHostWebGeneration(webServer) {
  const protocol = webServer?.protocol
  if (protocol === 'http:' || protocol === 'https:') return 'startup'
  if (protocol === undefined) return 'legacy-runtime'
  throw new Error('Vision Router Web compatibility: unknown Host Web protocol')
}

export function apply(ctx) {
  const generation = classifyHostWebGeneration(ctx.webServer)
  if (generation === 'startup') {
    // 0.2.1-alpha.2+: Web Startup owns invocation trust; Web Runtime no
    // longer provides a webRuntime service. Do not resurrect that service.
    ctx.provide(SERVICE, Object.freeze({
      trustedHosts: validatedTrustedHosts(ctx.webStartup.trustedHosts),
    }))
    return
  }

  // Older supported Hosts materialize additional bind-derived LAN addresses
  // in their native webRuntime service. Wait for the real service rather than
  // falling back to the earlier webStartup list (which would silently lose
  // LAN authority and race asynchronous Web runtime activation).
  ctx.inject(['webRuntime'], (legacyCtx) => {
    legacyCtx.provide(SERVICE, Object.freeze({
      trustedHosts: validatedTrustedHosts(legacyCtx.webRuntime.trustedHosts),
    }))
  })
}
