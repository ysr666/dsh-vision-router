type UnknownRecord = Record<PropertyKey, unknown>

export interface LegacySessionSurfaceReplacementIntent {
  readonly surfaceOp: Readonly<{
    op: 'replace'
    start: number
    end: number
  }>
  readonly sourceEventSeqs: readonly [number]
}

export interface CurrentSessionSurfaceReplacementIntent {
  readonly surfaceOp: Readonly<{
    op: 'replace'
    startSeq: number
    endSeq: number
  }>
  readonly sourceEventSeqs: readonly [number]
}

export type SessionSurfaceReplacementIntent =
  | LegacySessionSurfaceReplacementIntent
  | CurrentSessionSurfaceReplacementIntent

function propertyBag(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object'
    ? value as UnknownRecord
    : undefined
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0)
  )
}

/**
 * Build the Host-owned Session surface replacement intent for one exact node.
 *
 * DSH Session format v3 renamed replacement endpoints from start/end to
 * startSeq/endSeq, and reviewed format v4 keeps that shape. Unknown future
 * formats fail closed instead of being guessed from package version.
 */
export function sessionSurfaceReplacementIntent(
  session: unknown,
  seqValue: unknown,
): SessionSurfaceReplacementIntent | undefined {
  if (!nonNegativeSafeInteger(seqValue)) {
    throw new TypeError(
      'session surface replacement seq must be a non-negative safe integer',
    )
  }
  const seq = seqValue

  const version = propertyBag(propertyBag(session)?.header)?.version
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
