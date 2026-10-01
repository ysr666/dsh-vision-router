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
  const start: number = legacy.surfaceOp.start
  const end: number = legacy.surfaceOp.end
  void start
  void end
}

if (current !== undefined && 'startSeq' in current.surfaceOp) {
  const startSeq: number = current.surfaceOp.startSeq
  const endSeq: number = current.surfaceOp.endSeq
  void startSeq
  void endSeq
}

const invalidLegacy: LegacySessionSurfaceReplacementIntent = {
  // @ts-expect-error legacy replacement endpoints never use startSeq
  surfaceOp: { op: 'replace', startSeq: 7, endSeq: 7 },
  sourceEventSeqs: [7],
}
void invalidLegacy
