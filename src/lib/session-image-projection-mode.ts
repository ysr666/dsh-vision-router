import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { Domain, DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'

export type ProjectionMode = 'legacy' | 'stable'

/**
 * An ordinary, immutable DSH user/message is the only supported durable
 * format witness for external plugins. DSH forbids external usage of
 * appendPluginRecord and restricts the SessionHeader schema. The witness
 * necessarily costs one short model-visible user message, admitted with the
 * first stable request, but it is replayed and forked with the conversation.
 *
 * Source attribution and exact text+ID format are validated before a witness
 * can authorize projecting old images. Never accept arbitrary user text.
 */
export const STABLE_IMAGE_PROJECTION_WITNESS_V1 = '[DVR image-history format: stable-v1]'
const STABLE_WITNESS_PREFIX = 'vision-router-projection-stable-v1-'
const STABLE_WITNESS_ID = /^vision-router-projection-stable-v1-[a-f0-9]{40}$/u

function isDvrSource(source: unknown): boolean {
  if (!source || typeof source !== 'object') return false
  const value = source as { kind?: unknown; plugin?: unknown }
  return value.kind === 'plugin:dsh-vision-router' ||
    (value.kind === 'plugin' && value.plugin === 'dsh-vision-router')
}

export function isCommittedStableProjectionWitness(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const value = message as {
    role?: unknown; id?: unknown; source?: unknown;
    content?: readonly { type?: unknown; text?: unknown }[]
  }
  return value.role === 'user' && typeof value.id === 'string' &&
    STABLE_WITNESS_ID.test(value.id) &&
    isDvrSource(value.source) &&
    Array.isArray(value.content) && value.content.length === 1 &&
    value.content[0]?.type === 'text' &&
    value.content[0].text === STABLE_IMAGE_PROJECTION_WITNESS_V1
}

export function createStableProjectionWitness(
  sessionId: string, source: { kind: string; plugin?: string },
) {
  if (!sessionId || !isDvrSource(source)) throw new TypeError('stable witness needs a DVR-owned source and Session')
  const fingerprint = createHash('sha256').update(sessionId).digest('hex').slice(0, 40)
  return {
    role: 'user' as const,
    id: STABLE_WITNESS_PREFIX + fingerprint,
    source: { ...source },
    content: [{ type: 'text' as const, text: STABLE_IMAGE_PROJECTION_WITNESS_V1 }],
  }
}

type ProjectionResolution = ProjectionMode | 'unknown'
type RecordValue = Readonly<{ revision: 1; mode: ProjectionMode }>
const recordSchema = z.object({
  revision: z.literal(1),
  mode: z.enum(['legacy', 'stable']),
}).strict()

// A separate domain avoids changing the already-shipped Session Vision policy
// schema. Nothing is written to DSH's model-visible Session history.
export const imageProjectionModeDomainSpec = {
  name: 'vision_router_image_projection',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    modes: { valueSchema: recordSchema as unknown as DomainSpec['tables'][string]['valueSchema'] },
  },
} as const satisfies DomainSpec

type Facility = { open(spec: DomainSpec): Promise<Domain<DomainSpec>> }
type Context = {
  get?(name: string): unknown
  effect?(setup: () => (() => Promise<void>) | void, label?: string): unknown
  on?(event: string, handler: (payload: unknown) => void): unknown
  logger?: { warn?(message: string, ...args: unknown[]): void }
}
type Session = {
  id?: unknown
  requestHeader?(): unknown
  snapshotEvents?(): readonly { type?: string; data?: unknown }[]
  seq?: unknown
  eventAt?(seq: number): { type?: string } | undefined
  firstLiveSeq?: unknown
  inheritedEventCount?: unknown
  header?: { isSeeded?: boolean }
}

function usableFacility(ctx: Context): Facility | undefined {
  try {
    const candidate = ctx.get?.('storageDomain') as Facility | undefined
    return typeof candidate?.open === 'function' ? candidate : undefined
  } catch { return undefined }
}

/**
 * In pinned DSH the inbox is claimed during pre-step and user/message commits
 * only after that waterfall returns. A stray current-turn user/message is not
 * itself proof that a model has ever seen this Session.
 *
 * firstLiveSeq is the immutable construction offset: 0 for a truly fresh
 * Session, >0 for a resumed or seeded one. A fork also supplies a durable
 * inherited cut / seeded header. Unknown lifecycle shapes stay legacy.
 */
export function hasPriorModelHistory(session: Session): boolean {
  try {
    if (session.requestHeader?.() !== undefined) return true
    if (session.header?.isSeeded === true ||
        (typeof session.inheritedEventCount === 'number' && session.inheritedEventCount > 0)) return true
    if (typeof session.firstLiveSeq === 'number' && session.firstLiveSeq > 0) return true
    const knownNew = session.firstLiveSeq === 0 && session.header?.isSeeded === false
    const events = typeof session.snapshotEvents === 'function'
      ? session.snapshotEvents()
      : typeof session.seq === 'number' && typeof session.eventAt === 'function'
        ? Array.from({ length: session.seq }, (_, i) => session.eventAt?.(i))
        : undefined
    if (!events) return true
    if (events.some(event => event?.type === 'request/header' ||
        event?.type === 'assistant/message' || event?.type === 'tool/result' ||
        event?.type === 'session/end-seed')) return true
    // Imported user-only history with no verified fresh construction offset
    // cannot be safely migrated. Fresh DSH initial input is permitted.
    if (!knownNew && events.some(event => event?.type === 'user/message')) return true
    return false
  } catch { return true }
}

/**
 * An unknown Session projection is safe only if neither the currently
 * claimed step nor ANY model-visible committed surface contains image input.
 * Model-visible OCR evidence is also an image-history witness even when the
 * original attachment has been compacted out of the derived surface.
 *
 * Any failure to inspect the authoritative Session log is unsafe: do not
 * convert a storage/read error into "there were no historical images".
 */
export function requiresVerifiedImageProjection(
  session: Session,
  currentMessages: readonly unknown[],
  blocksContainImage: (content: unknown) => boolean,
): boolean {
  try {
    const events = session.snapshotEvents?.()
    if (!Array.isArray(events) || !Array.isArray(currentMessages)) return true
    const hasVisualEvidence = (candidate: unknown): boolean => {
      if (candidate === null || typeof candidate !== 'object') return false
      const message = candidate as { id?: unknown; content?: unknown }
      return (Array.isArray(message.content) && blocksContainImage(message.content)) ||
        (typeof message.id === 'string' &&
          message.id.startsWith('vision-router-image-evidence-v1-'))
    }
    if (currentMessages.some(hasVisualEvidence)) return true
    return events.some((event) => {
      const kind = event?.type
      const payload = event?.data
      const candidate = kind === 'user/message' ? payload
        : kind === 'tool/result' || kind === 'assistant/message' ||
          kind === 'system/message' || kind === 'developer/message'
          ? (payload as { message?: unknown } | undefined)?.message : undefined
      return hasVisualEvidence(candidate)
    })
  } catch {
    return true
  }
}

/**
 * A Session's text-only image format is selected before its first request and
 * persisted before admitting the resulting model-visible history. A preexisting
 * Session with any committed message or request cannot silently migrate.
 *
 * A missing or unhealthy storageDomain yields 'unknown' for established
 * Sessions. In that state the caller must stop request admission: guessing
 * legacy could silently rewrite a previously stable image-history prefix.
 * Before the very first request, legacy is a safe non-durable fallback.
 */
export function createSessionImageProjectionModeStore(ctx: Context) {
  const cache = new Map<string, ProjectionMode>()
  const witnesses = new WeakMap<object, boolean>()
  const pending = new Map<string, Promise<ProjectionResolution>>()
  let open: Promise<Domain<DomainSpec> | undefined> | undefined
  let handle: Domain<DomainSpec> | undefined
  let closed = false
  let owned = false
  let warned = false

  const warn = (error: unknown) => {
    if (warned) return
    warned = true
    ctx.logger?.warn?.('vision-router: image projection storage unavailable; established Sessions require verified format before model admission (%s)',
      error instanceof Error ? error.name : 'unknown')
  }

  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        owned = true
        return async () => {
          closed = true
          // An in-flight decision must finish before storage is retired.
          await Promise.allSettled([...pending.values()])
          try { await open } catch {}
          const toClose = handle
          handle = undefined
          if (toClose) await toClose.close()
          cache.clear()
        }
      }, 'vision-router: durable image projection mode lifecycle')
    }
  } catch {
    owned = false
  }

  const table = async (): Promise<KvTable<string, RecordValue> | undefined> => {
    if (!owned || closed) return undefined
    if (open === undefined) {
      const facility = usableFacility(ctx)
      if (!facility) return undefined
      open = facility.open(imageProjectionModeDomainSpec)
        .then(domain => {
          handle = domain
          return domain
        })
        .catch(error => {
          warn(error)
          // A transient failed open must not permanently poison this owner.
          open = undefined
          return undefined
        })
    }
    const domain = await open
    return domain?.table('modes') as KvTable<string, RecordValue> | undefined
  }


  // One bounded snapshot per live Session object; incremental event
  // publication updates this state without rescanning a long conversation.
  // Each cold-restored/forked Session is a new object and scans its own history
  // once, including inherited events.
  const hasCommittedWitness = (session: Session): boolean => {
    if (typeof session !== 'object' || !session) return false
    const cached = witnesses.get(session)
    if (cached !== undefined) return cached
    try {
      const events = session.snapshotEvents?.()
      if (!Array.isArray(events)) return false
      const found = events.some(event => event?.type === 'user/message' &&
        isCommittedStableProjectionWitness(event.data))
      witnesses.set(session, found)
      return found
    } catch {
      return false
    }
  }

  const witnessFor = (session: Session, source: { kind: string; plugin?: string }) => {
    const id = session.id
    if (typeof id !== 'string' || cache.get(id) !== 'stable' || hasCommittedWitness(session)) {
      return undefined
    }
    // Merely planning a pre-step does NOT mark a witness as committed. DSH
    // persists the user/message only on successful step admission. A rejected
    // or cancelled waterfall will plan the same deterministic ID on retry.
    return createStableProjectionWitness(id, source)
  }

  const onSessionEvent = (session: Session, event: { type?: string; data?: unknown }) => {
    if (session && typeof session === 'object' && event?.type === 'user/message' &&
        isCommittedStableProjectionWitness(event.data)) {
      witnesses.set(session, true)
      if (typeof session.id === 'string') cache.set(session.id, 'stable')
    }
  }

  const resolve = async (session: Session, allowNewStable = true): Promise<ProjectionResolution> => {
    const id = typeof session?.id === 'string' && session.id.trim() !== ''
      ? session.id : undefined
    const unknownOrLegacy = (): ProjectionResolution => hasPriorModelHistory(session) ? 'unknown' : 'legacy'
    if (!id) return unknownOrLegacy()
    // The authoritative Session witness survives a deleted sidecar row,
    // disconnected storage service, cold restart, and a fork with new id.
    if (hasCommittedWitness(session)) {
      cache.set(id, 'stable')
      return 'stable'
    }
    if (cache.has(id)) return cache.get(id) as ProjectionMode
    // A fresh unrequested Session has no old image prefix to migrate. Its
    // first admitted DSH user/message witness is sufficient durability even
    // when the optional sidecar is completely unavailable.
    const firstStableRequest = allowNewStable && !hasPriorModelHistory(session)
    if (pending.has(id)) return pending.get(id) as Promise<ProjectionResolution>
    const task = (async (): Promise<ProjectionResolution> => {
      try {
        const modes = await table()
        if (!modes || closed) {
          if (closed) return 'unknown'
          if (firstStableRequest) {
            cache.set(id, 'stable')
            return 'stable'
          }
          if (allowNewStable) warn(new Error('storageDomain missing or unavailable for historical Session'))
          return unknownOrLegacy()
        }
        const stored = recordSchema.safeParse(modes.get(id))
        if (stored.success) {
          cache.set(id, stored.data.mode)
          return stored.data.mode
        }
        // A corrupt/unknown persisted row must not be silently replaced.
        if (modes.get(id) !== undefined) return 'unknown'
        const mode = allowNewStable && !hasPriorModelHistory(session) ? 'stable' : 'legacy'
        await modes.put(id, { revision: 1, mode })
        if (closed) return 'unknown'
        cache.set(id, mode)
        return mode
      } catch (error) {
        warn(error)
        if (firstStableRequest && !closed) {
          // The Session witness will be admitted and persisted together with
          // the first model request. A failed optional sidecar cannot prevent
          // a genuinely fresh Session from using an opt-in stable format.
          cache.set(id, 'stable')
          return 'stable'
        }
        return unknownOrLegacy()
      }
    })()
    pending.set(id, task)
    try { return await task } finally { if (pending.get(id) === task) pending.delete(id) }
  }

  return {
    resolve,
    hasCommittedWitness,
    witnessFor,
    onSessionEvent,
    // A Host that has never mounted storageDomain cannot have produced a
    // durable stable-mode record through this feature. The default-disabled
    // legacy path must stay available on such installations.
    hasStorageFacility(): boolean { return usableFacility(ctx) !== undefined },
    get(id: unknown): ProjectionMode | undefined {
      return typeof id === 'string' ? cache.get(id) : undefined
    },
    // A released Agent will rehydrate the committed row on its next pre-step.
    release(id: unknown) {
      if (typeof id === 'string') cache.delete(id)
    },
  }
}
