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
function validSeq(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) ? value : undefined
}

export function createSessionTurnResolver(ctx) {
  const boundaryOf = (session) => {
    if (!session) return undefined
    const projections = projectionServiceOf(ctx)
    if (projections === undefined) return undefined
    try {
      const state = projections.stateOf(session, 'turnBoundary')
      if (!state || typeof state !== 'object') return undefined
      return state
    } catch {
      return undefined
    }
  }

  return Object.freeze({
    boundaryOf,
    turnOf(session) {
      const state = boundaryOf(session)
      return Number.isInteger(state?.lastTurn) && state.lastTurn >= 0 ? state.lastTurn : undefined
    },
    eventAnchorOf(session) {
      const state = boundaryOf(session)
      const openTurnStartSeq = validSeq(state?.openTurnStartSeq)
      if (openTurnStartSeq === undefined) return undefined
      const lastBoundarySeq = validSeq(state?.lastStepBoundary?.seq)
      if (lastBoundarySeq !== undefined && lastBoundarySeq >= openTurnStartSeq) return lastBoundarySeq
      const lastStepStartSeq = validSeq(state?.lastStepStartSeq)
      if (lastStepStartSeq !== undefined && lastStepStartSeq >= openTurnStartSeq) return lastStepStartSeq
      return openTurnStartSeq
    },
  })
}
