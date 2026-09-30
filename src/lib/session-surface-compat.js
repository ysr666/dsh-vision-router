function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

/**
 * Build the Host-owned Session surface replacement intent for one exact node.
 *
 * DSH Session format v3 renamed replacement endpoints from start/end to
 * startSeq/endSeq, and reviewed format v4 keeps that replacement shape. The
 * field change belongs to the Session format contract,
 * not to a DSH package-version heuristic, so dispatch on session.header.version
 * and refuse unknown future formats instead of guessing forward compatibility.
 *
 * Returns undefined when the Host does not expose a supported logical Session
 * format. Callers can then keep request-local safety behavior while skipping
 * optional durable surface hygiene.
 */
export function sessionSurfaceReplacementIntent(session, seq) {
  if (!nonNegativeSafeInteger(seq)) {
    throw new TypeError('session surface replacement seq must be a non-negative safe integer')
  }

  const version = session?.header?.version
  if (!nonNegativeSafeInteger(version)) return undefined

  if (version <= 2) {
    return {
      surfaceOp: { op: 'replace', start: seq, end: seq },
      sourceEventSeqs: [seq],
    }
  }

  if (version === 3 || version === 4) {
    return {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    }
  }

  return undefined
}
