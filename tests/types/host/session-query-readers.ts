import {
  createSessionEventReader,
  createSessionEventTailReader,
  createSessionLogReader,
  type SessionEventReadResult,
  type SessionEventTailReadResult,
  type SessionLogReadResult,
} from '../../../src/lib/session-query-readers.js'

declare const ctx: unknown

const eventReader = createSessionEventReader(ctx)
const logReader = createSessionLogReader(ctx)
const tailReader = createSessionEventTailReader(ctx)

async function verifyReaders(): Promise<void> {
  const eventResult: SessionEventReadResult = await eventReader({ id: 'session-a' }, 0)
  if (eventResult.supported) {
    const event: unknown = eventResult.event
    void event
  } else {
    // @ts-expect-error unsupported readers do not expose an event payload
    void eventResult.event
  }

  const logResult: SessionLogReadResult = await logReader({ id: 'session-a' })
  if (logResult.supported) {
    const events: readonly unknown[] = logResult.events
    void events
  } else {
    // @ts-expect-error unsupported readers do not expose an event log
    void logResult.events
  }

  const tailResult: SessionEventTailReadResult =
    await tailReader({ id: 'session-a' }, 0, { collect: false })
  if (tailResult.supported) {
    const capturedThroughSeq: number = tailResult.capturedThroughSeq
    const truncated: boolean = tailResult.truncated
    const events: readonly unknown[] = tailResult.events
    void capturedThroughSeq
    void truncated
    void events
  } else {
    // @ts-expect-error unsupported readers do not expose tail metadata
    void tailResult.capturedThroughSeq
  }
}

void verifyReaders
