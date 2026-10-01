type UnknownRecord = Record<PropertyKey, unknown>

export type SessionQueryUnsupported = Readonly<{
  supported: false
}>

export type SessionEventReadResult =
  | SessionQueryUnsupported
  | Readonly<{
      supported: true
      event: unknown
    }>

export type SessionLogReadResult =
  | SessionQueryUnsupported
  | Readonly<{
      supported: true
      events: readonly unknown[]
    }>

export type SessionEventTailReadResult =
  | SessionQueryUnsupported
  | Readonly<{
      supported: true
      events: readonly unknown[]
      capturedThroughSeq: number
      truncated: boolean
    }>

export type SessionEventReader = (
  session: unknown,
  seq: unknown,
) => Promise<SessionEventReadResult>

export type SessionLogReader = (
  session: unknown,
) => Promise<SessionLogReadResult>

export type SessionEventTailReader = (
  session: unknown,
  anchorSeq: unknown,
  options?: unknown,
) => Promise<SessionEventTailReadResult>

const disposeSymbol = (Symbol as unknown as { readonly dispose?: symbol }).dispose

const SESSION_EVENT_TAIL_INITIAL_AFTER = 50
const SESSION_EVENT_TAIL_MAX_EVENTS = 4096
const SESSION_EVENT_TAIL_MAX_READS = 128

function objectRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object'
    ? value as UnknownRecord
    : undefined
}

function propertyBag(value: unknown): UnknownRecord | undefined {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? value as UnknownRecord
    : undefined
}

function sessionIdOf(session: unknown): unknown {
  return propertyBag(session)?.id
}

function sessionQueryOf(ctx: unknown): UnknownRecord | undefined {
  const context = objectRecord(ctx)
  if (context === undefined) return undefined

  // sessionQuery is an optional capability. Cordis service property reads may
  // register a hard pending dependency outside inject(); Context#get is the
  // non-owning capability probe and is the only supported lookup here.
  try {
    const get = context.get
    if (typeof get !== 'function') return undefined
    return objectRecord(get.call(ctx, 'sessionQuery'))
  } catch {
    return undefined
  }
}

function sessionQueryCode(error: unknown): string | undefined {
  const code = propertyBag(error)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Build the narrow bounded Session event reader used by durable surface repair.
 *
 * The Host SessionQuery service is intentionally discovered by capability at
 * runtime instead of imported as a concrete service graph. DVR owns only the
 * small supported/unsupported reader port returned from this adapter.
 */
export function createSessionEventReader(ctx: unknown): SessionEventReader {
  return async function readSessionEvent(
    session: unknown,
    seqValue: unknown,
  ): Promise<SessionEventReadResult> {
    const sessionId = sessionIdOf(session)
    if (sessionId === undefined || sessionId === null) return { supported: false }
    if (
      typeof seqValue !== 'number'
      || !Number.isSafeInteger(seqValue)
      || seqValue < 0
      || Object.is(seqValue, -0)
    ) {
      throw new TypeError(
        `session event seq must be a non-negative safe integer, got ${String(seqValue)}`,
      )
    }
    const seq = seqValue

    const query = sessionQueryOf(ctx)
    const readEvent = query?.readEvent
    if (query === undefined || typeof readEvent !== 'function') {
      return { supported: false }
    }

    const window = await readEvent.call(query, { sessionId, seq })
    const event = propertyBag(window)?.target
    const eventRecord = objectRecord(event)
    if (eventRecord === undefined) {
      throw new Error(`sessionQuery.readEvent returned no target for seq ${seq}`)
    }
    if (eventRecord.seq !== undefined && eventRecord.seq !== seq) {
      throw new Error(
        `sessionQuery.readEvent returned seq ${String(eventRecord.seq)} for requested seq ${seq}`,
      )
    }
    return { supported: true, event }
  }
}

/**
 * Read raw Session events strictly after one known committed seq through the
 * Host-owned bounded SessionQuery window contract.
 */
export function createSessionEventTailReader(ctx: unknown): SessionEventTailReader {
  let afterHint = SESSION_EVENT_TAIL_INITIAL_AFTER

  const readWindow = async (
    query: UnknownRecord,
    sessionId: unknown,
    seq: number,
  ): Promise<{ readonly window: unknown; readonly after: number }> => {
    let after = afterHint
    while (true) {
      try {
        const request = after > 0 ? { sessionId, seq, after } : { sessionId, seq }
        const readEvent = query.readEvent
        if (typeof readEvent !== 'function') {
          throw new TypeError('sessionQuery.readEvent is unavailable')
        }
        const window = await readEvent.call(query, request)
        afterHint = after
        return { window, after }
      } catch (error) {
        if (sessionQueryCode(error) !== 'SESSION_QUERY_INVALID_WINDOW' || after <= 0) {
          throw error
        }
        after = after <= 1 ? 0 : Math.floor(after / 2)
      }
    }
  }

  return async function readSessionEventTail(
    session: unknown,
    anchorSeqValue: unknown,
    options: unknown = {},
  ): Promise<SessionEventTailReadResult> {
    const sessionId = sessionIdOf(session)
    if (sessionId === undefined || sessionId === null) return { supported: false }
    if (
      typeof anchorSeqValue !== 'number'
      || !Number.isSafeInteger(anchorSeqValue)
      || anchorSeqValue < 0
      || Object.is(anchorSeqValue, -0)
    ) {
      throw new TypeError(
        `session tail anchor seq must be a non-negative safe integer, got ${String(anchorSeqValue)}`,
      )
    }
    const anchorSeq = anchorSeqValue

    const query = sessionQueryOf(ctx)
    if (query === undefined || typeof query.readEvent !== 'function') {
      return { supported: false }
    }

    const collect = propertyBag(options)?.collect !== false
    const events: unknown[] = []
    let capturedThroughSeq = anchorSeq
    let cursor = anchorSeq
    let inspected = 0
    let reads = 0

    while (reads < SESSION_EVENT_TAIL_MAX_READS) {
      let result: { readonly window: unknown; readonly after: number }
      try {
        result = await readWindow(query, sessionId, cursor)
      } catch (error) {
        if (
          sessionQueryCode(error) === 'SESSION_QUERY_EVENT_NOT_FOUND'
          && cursor > anchorSeq
        ) {
          return {
            supported: true,
            events,
            capturedThroughSeq,
            truncated: false,
          }
        }
        throw error
      }
      reads += 1

      const window = propertyBag(result.window)
      const target = window?.target
      const targetRecord = objectRecord(target)
      if (targetRecord === undefined || targetRecord.seq !== cursor) {
        throw new Error(
          `sessionQuery.readEvent returned an invalid target for seq ${cursor}`,
        )
      }

      const windowEvents = window?.events
      if (!Array.isArray(windowEvents) || windowEvents.length === 0) {
        throw new Error(
          `sessionQuery.readEvent returned no event window for seq ${cursor}`,
        )
      }

      let expectedSeq = cursor
      let endSeq = cursor
      for (const event of windowEvents) {
        const seqValue = propertyBag(event)?.seq
        if (
          typeof seqValue !== 'number'
          || !Number.isSafeInteger(seqValue)
          || seqValue !== expectedSeq
        ) {
          throw new Error(
            `sessionQuery.readEvent returned non-contiguous seq ${String(seqValue)}; expected ${expectedSeq}`,
          )
        }
        const seq = seqValue
        expectedSeq += 1
        endSeq = seq
        if (seq <= capturedThroughSeq) continue
        capturedThroughSeq = seq
        inspected += 1
        if (collect) events.push(event)
        if (inspected >= SESSION_EVENT_TAIL_MAX_EVENTS) {
          return {
            supported: true,
            events,
            capturedThroughSeq,
            truncated: true,
          }
        }
      }

      const windowEndSeq = window?.endSeq
      if (
        typeof windowEndSeq === 'number'
        && Number.isSafeInteger(windowEndSeq)
        && windowEndSeq !== endSeq
      ) {
        throw new Error(
          `sessionQuery.readEvent returned endSeq ${String(windowEndSeq)} for window ending at ${endSeq}`,
        )
      }

      if (result.after > 0) {
        if (endSeq <= cursor || windowEvents.length < result.after + 1) {
          return {
            supported: true,
            events,
            capturedThroughSeq: Math.max(capturedThroughSeq, endSeq),
            truncated: false,
          }
        }
        cursor = endSeq
        continue
      }

      // readWindowMax: 0 is valid. Walk exact seqs and use EVENT_NOT_FOUND as
      // the logical tail sentinel.
      cursor += 1
    }

    return {
      supported: true,
      events,
      capturedThroughSeq,
      truncated: true,
    }
  }
}

/**
 * Build the asynchronous Session-log reader used by cold attachment recovery
 * and batched surface repair.
 *
 * Prefer the Host observation lease when available and always dispose the lease
 * after copying out the raw event array. Older supported capability shapes keep
 * the released readSession() path.
 */
export function createSessionLogReader(ctx: unknown): SessionLogReader {
  return async function readSessionLog(
    session: unknown,
  ): Promise<SessionLogReadResult> {
    const sessionId = sessionIdOf(session)
    if (sessionId === undefined || sessionId === null) return { supported: false }

    const query = sessionQueryOf(ctx)
    if (query === undefined) return { supported: false }

    const observeSession = query.observeSession
    if (typeof observeSession === 'function') {
      let observation: unknown
      try {
        observation = await observeSession.call(
          query,
          sessionId,
          { projectionMode: 'none' },
        )
        const observationBag = propertyBag(observation)
        const events = observationBag?.events
        if (!Array.isArray(events)) {
          throw new Error('sessionQuery.observeSession returned no event log')
        }
        const observedId = propertyBag(observationBag?.header)?.id
        if (observedId !== undefined && observedId !== sessionId) {
          throw new Error(
            `sessionQuery.observeSession returned session ${String(observedId)} for requested ${String(sessionId)}`,
          )
        }
        return { supported: true, events }
      } finally {
        const dispose = disposeSymbol === undefined
          ? undefined
          : propertyBag(observation)?.[disposeSymbol]
        if (typeof dispose === 'function') dispose.call(observation)
      }
    }

    const readSession = query.readSession
    if (typeof readSession !== 'function') return { supported: false }

    const snapshot = await readSession.call(query, sessionId)
    const snapshotBag = propertyBag(snapshot)
    const events = snapshotBag?.events
    if (!Array.isArray(events)) {
      throw new Error('sessionQuery.readSession returned no event log')
    }
    const observedId = propertyBag(snapshotBag?.session)?.id
    if (observedId !== undefined && observedId !== sessionId) {
      throw new Error(
        `sessionQuery.readSession returned session ${String(observedId)} for requested ${String(sessionId)}`,
      )
    }
    return { supported: true, events }
  }
}
