import type { SessionLogReader } from './session-query-readers.js'
import type {
  SessionVisionAttachmentRef,
  SessionVisionStateStore,
} from './session-vision-state.js'
import { legacySessionEvents } from './session-event-history-compat.js'

type UnknownRecord = Record<PropertyKey, unknown>

export type SessionEventAttachmentCollector = (
  events: readonly unknown[],
) => unknown

export interface SessionVisionAttachmentIndexLogger {
  warn?: (message: string, ...args: unknown[]) => unknown
}

export interface SessionVisionAttachmentIndex {
  recordAttachments(session: unknown, refs: unknown): void
  lookupAttachment(
    session: unknown,
    attachmentId: unknown,
  ): SessionVisionAttachmentRef | undefined
  resolveAttachment(
    session: unknown,
    attachmentId: unknown,
  ): Promise<SessionVisionAttachmentRef | undefined>
  resolveAttachments(
    session: unknown,
    attachmentIds: readonly unknown[],
  ): Promise<Map<string, SessionVisionAttachmentRef>>
}

export interface SessionVisionAttachmentIndexOptions {
  readonly stateStore: SessionVisionStateStore
  readonly collectEventAttachmentRefs?: SessionEventAttachmentCollector
  readonly readSessionLog?: SessionLogReader
  readonly logger?: SessionVisionAttachmentIndexLogger
}

function propertyBag(value: unknown): UnknownRecord | undefined {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? value as UnknownRecord
    : undefined
}

function weakKey(value: unknown): object | undefined {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? value as object
    : undefined
}

function attachmentRef(value: unknown): SessionVisionAttachmentRef | undefined {
  return propertyBag(value) ? value as SessionVisionAttachmentRef : undefined
}

function attachmentIdOf(ref: SessionVisionAttachmentRef): string {
  const record = propertyBag(ref)
  return String(record?.attachmentId ?? record?.id)
}

function iterableValues(value: unknown): Iterable<unknown> {
  const iterator = propertyBag(value)?.[Symbol.iterator]
  if (typeof iterator !== 'function') {
    throw new TypeError('Session attachment collector returned a non-iterable result')
  }
  return value as Iterable<unknown>
}

function boundedMessage(error: unknown): string {
  const record = propertyBag(error)
  const text = record?.message ?? error
  return String(text ?? '').slice(0, 400)
}

/**
 * Attachment access boundary for one SessionVisionStateStore.
 *
 * The state store remains the sole bounded storage owner. This boundary owns
 * only cache access plus target-only cold recovery from the durable Session
 * event source. Synchronous lookup never performs historical I/O.
 */
export function createSessionVisionAttachmentIndex({
  stateStore,
  collectEventAttachmentRefs,
  readSessionLog,
  logger,
}: SessionVisionAttachmentIndexOptions): SessionVisionAttachmentIndex {
  const runtimeStore = stateStore as unknown as UnknownRecord
  const lookup = runtimeStore.lookupAttachment
  const primitiveLookup = typeof lookup === 'function'
    ? (session: unknown, attachmentId: unknown): SessionVisionAttachmentRef | undefined =>
        lookup.call(stateStore, session, attachmentId) as SessionVisionAttachmentRef | undefined
    : undefined

  const attachmentRecoveryWarnings = new WeakMap<object, string>()

  const recordAttachments = (session: unknown, refs: unknown): void => {
    if (!session || !Array.isArray(refs) || refs.length === 0) return
    stateStore.recordAttachments(session, refs)
  }

  const lookupAttachment = (
    session: unknown,
    attachmentId: unknown,
  ): SessionVisionAttachmentRef | undefined => {
    if (primitiveLookup === undefined) return undefined
    return primitiveLookup(session, attachmentId)
  }

  const recoverAttachmentsFromEvents = (
    session: unknown,
    ids: readonly string[],
    events: unknown,
  ): Map<string, SessionVisionAttachmentRef> => {
    const found = new Map<string, SessionVisionAttachmentRef>()
    if (
      !Array.isArray(events)
      || events.length === 0
      || typeof collectEventAttachmentRefs !== 'function'
    ) {
      return found
    }

    const wanted = new Set(ids)
    const collected = collectEventAttachmentRefs(events)
    for (const value of iterableValues(collected)) {
      if (!value) continue
      const ref = attachmentRef(value)
      if (ref === undefined) continue
      const id = attachmentIdOf(ref)
      if (wanted.has(id) && !found.has(id)) found.set(id, ref)
    }

    if (found.size > 0) stateStore.recordAttachments(session, [...found.values()])
    return found
  }

  const warnAttachmentRecoveryFailure = (
    session: unknown,
    attachmentId: unknown,
    error: unknown,
  ): void => {
    const message = boundedMessage(error)
    const warningKey = `${String(attachmentId)}:${message}`
    const key = weakKey(session)
    if (key !== undefined && attachmentRecoveryWarnings.get(key) === warningKey) return
    if (key !== undefined) attachmentRecoveryWarnings.set(key, warningKey)
    logger?.warn?.(
      'vision-router: session attachment recovery failed id=%s error=%s',
      String(attachmentId),
      message,
    )
  }

  const resolveAttachments = async (
    session: unknown,
    attachmentIds: readonly unknown[],
  ): Promise<Map<string, SessionVisionAttachmentRef>> => {
    const requested = [
      ...new Set((Array.isArray(attachmentIds) ? attachmentIds : []).map((id) => String(id))),
    ]
    const resolved = new Map<string, SessionVisionAttachmentRef>()
    const missing: string[] = []

    for (const id of requested) {
      const cached = lookupAttachment(session, id)
      if (cached !== undefined) resolved.set(id, cached)
      else missing.push(id)
    }
    if (missing.length === 0 || session === undefined) return resolved

    let events: unknown
    if (typeof readSessionLog === 'function') {
      let result: unknown
      try {
        result = await readSessionLog(session)
      } catch (error) {
        warnAttachmentRecoveryFailure(session, missing[0], error)
        return resolved
      }

      const resultRecord = propertyBag(result)
      if (resultRecord?.supported === true) {
        const key = weakKey(session)
        if (key !== undefined) attachmentRecoveryWarnings.delete(key)
        events = resultRecord.events
      } else if (resultRecord?.supported !== false) {
        warnAttachmentRecoveryFailure(
          session,
          missing[0],
          new Error('Session log reader returned an invalid capability result'),
        )
        return resolved
      }
    }

    // Explicitly unsupported SessionQuery keeps the released Session-local
    // compatibility fallback. Advertised reader failures above never fall back.
    if (events === undefined) events = legacySessionEvents(session)

    const recovered = recoverAttachmentsFromEvents(session, missing, events)
    for (const [id, ref] of recovered) resolved.set(id, ref)
    return resolved
  }

  const resolveAttachment = async (
    session: unknown,
    attachmentId: unknown,
  ): Promise<SessionVisionAttachmentRef | undefined> => {
    return (await resolveAttachments(session, [attachmentId])).get(String(attachmentId))
  }

  return Object.freeze({
    recordAttachments,
    lookupAttachment,
    resolveAttachment,
    resolveAttachments,
  })
}
