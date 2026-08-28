import { collectCapabilityShadowCandidates } from './vision-capability-shadow.js'
import { resolveVisionRoutingAuthority } from './vision-routing-authority.js'
import {
  VISION_PRESENTATION_DTO_REVISION,
  projectVisionProductCandidate,
  publicVisionAuthority,
} from './vision-product-presentation.js'

const attachedManagers = new WeakSet()

function activeSettings(ctx, fallback) {
  try {
    const settings = ctx?.get?.('settings')
    const current = settings?.get?.('vision-router')
    return current && typeof current === 'object' && !Array.isArray(current) ? current : fallback
  } catch {
    return fallback
  }
}

async function rawCandidates(ctx, config, core, store) {
  try {
    return await collectCapabilityShadowCandidates(ctx, config, core, store)
  } catch {
    return []
  }
}

/**
 * C2-A additive migration seam.
 *
 * The existing benchmark route keeps its mature manager and polling contract.
 * This decorator adds the versioned Host presentation DTO to that same
 * snapshot without changing benchmark execution or browser consumption. It is
 * intentionally removable once the service owns the projection directly.
 */
export function attachCapabilityBenchmarkPresentation(manager, {
  ctx,
  config = {},
  core,
  healthForCandidate,
} = {}) {
  if (!manager || typeof manager !== 'object' || typeof manager.snapshot !== 'function') return manager
  if (attachedManagers.has(manager)) return manager

  const baseSnapshot = manager.snapshot.bind(manager)
  manager.snapshot = async () => {
    const base = await baseSnapshot()
    const current = activeSettings(ctx, config)
    const authority = resolveVisionRoutingAuthority(current)
    const rows = await rawCandidates(ctx, current, core, manager.store)
    const byKey = new Map(rows.map((candidate) => [candidate?.key, candidate]))
    const candidates = await Promise.all((Array.isArray(base?.candidates) ? base.candidates : []).map(async (candidate) => {
      const raw = byKey.get(candidate?.key) ?? candidate
      let health
      if (typeof healthForCandidate === 'function') {
        try { health = await healthForCandidate(raw) } catch {}
      }
      const presentationInput = {
        ...raw,
        measured: candidate?.measured,
        cloudCostWarning: candidate?.cloudCostWarning,
      }
      return Object.freeze({
        ...candidate,
        presentation: projectVisionProductCandidate(presentationInput, health, authority),
      })
    }))

    return Object.freeze({
      ...base,
      presentationRevision: VISION_PRESENTATION_DTO_REVISION,
      routingMode: authority.execution,
      currentAuthority: publicVisionAuthority(authority),
      candidates: Object.freeze(candidates),
    })
  }

  attachedManagers.add(manager)
  return manager
}
