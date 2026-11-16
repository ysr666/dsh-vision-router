import type { SessionLogReader } from './session-query-readers.js'
import type {
  SessionVisionAttachmentRef,
  SessionVisionStateStore,
} from './session-vision-state.js'
import { legacySessionEvents } from './session-event-history-compat.js'
import { sessionImageAttachmentRefs } from './vision-attachment-handle-runtime.js'

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
    signal?: AbortSignal,
  ): Promise<SessionVisionAttachmentRef | undefined>
  resolveAttachments(
    session: unknown,
    attachmentIds: readonly unknown[],
    signal?: AbortSignal,
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

// Host error messages may contain file paths, image ids or provider credentials.
// Only log a controlled diagnostic category, never arbitrary exception text.
function recoveryFailureKind(error: unknown): string {
  const code = propertyBag(error)?.code
  if (code === 'ENOENT') return 'not-found'
  if (code === 'EACCES' || code === 'EPERM') return 'permission'
  if (code === 'EBUSY') return 'busy'
  if (code === 'ETIMEDOUT') return 'timeout'
  if (code === 'SESSION_QUERY_CORRUPT_SESSION') return 'corrupt-session'
  return 'session-query-error'
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
    const kind = recoveryFailureKind(error)
    // The full attachment id is used only for in-memory de-duplication.
    const warningKey = `${String(attachmentId)}:${kind}`
    const key = weakKey(session)
    if (key !== undefined && attachmentRecoveryWarnings.get(key) === warningKey) return
    if (key !== undefined) attachmentRecoveryWarnings.set(key, warningKey)
    logger?.warn?.('vision-router: session attachment recovery failed kind=%s', kind)
  }

  const resolveAttachments = async (
    session: unknown,
    attachmentIds: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<Map<string, SessionVisionAttachmentRef>> => {
    signal?.throwIfAborted()
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

    // Modern Session.deriveMessages() gives Session-owned image references
    // without acquiring the Host SessionQuery observation lease. This is the
    // same authorized source already used for projected short image handles.
    // Especially on a cold resumed Session, avoid waiting on full-log I/O
    // when all requested images are already present in derived messages.
    const wanted = new Set(missing)
    const fromSession: SessionVisionAttachmentRef[] = []
    for (const value of sessionImageAttachmentRefs(session)) {
      const ref = attachmentRef(value)
      if (ref === undefined) continue
      const id = attachmentIdOf(ref)
      if (!wanted.has(id)) continue
      wanted.delete(id)
      resolved.set(id, ref)
      fromSession.push(ref)
      if (wanted.size === 0) break
    }
    signal?.throwIfAborted()
    if (fromSession.length > 0) stateStore.recordAttachments(session, fromSession)
    if (wanted.size === 0) return resolved
    const remaining = missing.filter((id) => wanted.has(id))

    let events: unknown
    if (typeof readSessionLog === 'function') {
      let result: unknown
      try {
        result = await readSessionLog(session, signal)
        signal?.throwIfAborted()
      } catch (error) {
        // Cancellation is not a corrupted or missing Session. Never convert
        // it to a successful partial lookup or log an attachment identifier.
        if (signal?.aborted) throw signal.reason ?? error
        warnAttachmentRecoveryFailure(session, remaining[0], error)
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
          remaining[0],
          new Error('Session log reader returned an invalid capability result'),
        )
        return resolved
      }
    }

    // Explicitly unsupported SessionQuery keeps the released Session-local
    // compatibility fallback. Advertised reader failures above never fall back.
    signal?.throwIfAborted()
    if (events === undefined) events = legacySessionEvents(session)
    signal?.throwIfAborted()

    const recovered = recoverAttachmentsFromEvents(session, remaining, events)
    for (const [id, ref] of recovered) resolved.set(id, ref)
    return resolved
  }

  const resolveAttachment = async (
    session: unknown,
    attachmentId: unknown,
    signal?: AbortSignal,
  ): Promise<SessionVisionAttachmentRef | undefined> => {
    return (await resolveAttachments(session, [attachmentId], signal)).get(String(attachmentId))
  }

  return Object.freeze({
    recordAttachments,
    lookupAttachment,
    resolveAttachment,
    resolveAttachments,
  })
}
