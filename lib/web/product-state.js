import { collectVisionRoutingEvidence } from '../vision-routing-evidence.js'
import { resolveVisionRoutingAuthority } from '../vision-routing-authority.js'
import {
  VISION_PRESENTATION_DTO_REVISION,
  projectVisionProductCandidate,
  publicVisionAuthority,
} from '../vision-product-presentation.js'

export {
  VISION_PRESENTATION_DTO_REVISION,
  projectVisionProductCandidate,
} from '../vision-product-presentation.js'

function activeSettings(ctx, fallback) {
  try {
    const settings = ctx?.get?.('settings')
    const current = settings?.get?.('vision-router')
    return current && typeof current === 'object' && !Array.isArray(current) ? current : fallback
  } catch {
    return fallback
  }
}

/**
 * P3-C Host-owned product projection.
 *
 * The browser receives decisions, not credentials/endpoints/breaker internals.
 * Runtime authority is resolved from the live Host settings namespace and
 * evidence remains read-only. No field in this projection grants authority.
 */
export async function createVisionProductStateSnapshot({
  ctx,
  config,
  core,
  store,
  runtimePerformanceStore,
  healthForCandidate,
} = {}) {
  const current = activeSettings(ctx, config)
  const authority = resolveVisionRoutingAuthority(current)
  const evidence = await collectVisionRoutingEvidence({
    ctx,
    config: current,
    core,
    store,
    runtimePerformanceStore,
    healthForCandidate,
  })
  const candidates = evidence.candidates.map((candidate) =>
    projectVisionProductCandidate(candidate, evidence.health?.[candidate.key], authority))

  return Object.freeze({
    ok: true,
    presentationRevision: VISION_PRESENTATION_DTO_REVISION,
    routingMode: authority.execution,
    currentAuthority: publicVisionAuthority(authority),
    candidates: Object.freeze(candidates),
  })
}
