import {
  sessionSurfaceReplacementIntent,
  type CurrentSessionSurfaceReplacementIntent,
  type LegacySessionSurfaceReplacementIntent,
  type SessionSurfaceReplacementIntent,
} from '../../../src/lib/session-surface-compat.js'

const legacy: SessionSurfaceReplacementIntent | undefined =
  sessionSurfaceReplacementIntent({ header: { version: 2 } }, 7)

const current: SessionSurfaceReplacementIntent | undefined =
  sessionSurfaceReplacementIntent({ header: { version: 4 } }, 7)

if (legacy !== undefined && 'start' in legacy.surfaceOp) {
  const exactLegacy: LegacySessionSurfaceReplacementIntent = legacy
  const start: number = exactLegacy.surfaceOp.start
  void start
}

if (current !== undefined && 'startSeq' in current.surfaceOp) {
  const exactCurrent: CurrentSessionSurfaceReplacementIntent = current
  const startSeq: number = exactCurrent.surfaceOp.startSeq
  void startSeq
}

// @ts-expect-error legacy replacement endpoints never use startSeq
const invalidLegacy: LegacySessionSurfaceReplacementIntent = {
  surfaceOp: { op: 'replace', startSeq: 7, endSeq: 7 },
  sourceEventSeqs: [7],
}
void invalidLegacy
