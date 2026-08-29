import { collectVisionRoutingCandidates } from './vision-routing-evidence.js'
import { resolveVisionRoutingAuthority } from './vision-routing-authority.js'
import {
  VISION_PRESENTATION_DTO_REVISION,
  projectVisionBackgroundRuntime,
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
    return await collectVisionRoutingCandidates(ctx, config, core, store)
  } catch {
    return []
  }
}

function backgroundState(store) {
  try {
    const profiler = store?.backgroundProfiler
    return typeof profiler?.snapshot === 'function' ? profiler.snapshot() : {}
  } catch {
    return {}
  }
}

/**
 * Versioned Host presentation projection for the benchmark snapshot.
 *
 * The benchmark manager remains the sole queue/execution owner. This decorator
 * adds the authoritative presentation DTO plus public background-runtime state
 * without moving scheduling, benchmark ownership or policy decisions into the
 * browser.
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
    const background = projectVisionBackgroundRuntime(backgroundState(manager.store), authority)
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
        imageCapability: candidate?.imageCapability,
      }
      return Object.freeze({
        ...candidate,
        presentation: projectVisionProductCandidate(presentationInput, health, authority, {
          background,
          core,
        }),
      })
    }))

    return Object.freeze({
      ...base,
      presentationRevision: VISION_PRESENTATION_DTO_REVISION,
      routingMode: authority.execution,
      currentAuthority: publicVisionAuthority(authority),
      background,
      candidates: Object.freeze(candidates),
    })
  }

  attachedManagers.add(manager)
  return manager
}
