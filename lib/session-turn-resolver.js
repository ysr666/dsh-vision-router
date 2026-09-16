function projectionServiceOf(ctx) {
  try {
    const service = ctx?.sessionProjections
    if (service && typeof service.stateOf === 'function') return service
  } catch {
    // Some compatibility contexts expose services only through get().
  }
  try {
    const service = ctx?.get?.('sessionProjections')
    return service && typeof service.stateOf === 'function' ? service : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the current Agent turn without making modern Hosts expose arbitrary
 * Session history. DSH 0.1.5+ owns `turnBoundary` as a Session projection;
 * older supported Hosts receive `undefined` so their existing compatibility
 * path remains authoritative.
 */
export function createSessionTurnResolver(ctx) {
  return Object.freeze({
    turnOf(session) {
      if (!session) return undefined
      const projections = projectionServiceOf(ctx)
      if (projections === undefined) return undefined
      try {
        const state = projections.stateOf(session, 'turnBoundary')
        return Number.isInteger(state?.lastTurn) && state.lastTurn >= 0 ? state.lastTurn : undefined
      } catch {
        return undefined
      }
    },
  })
}
