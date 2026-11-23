import { z } from 'zod'
import type { Domain, DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'

type ProjectionMode = 'legacy' | 'stable'
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
  snapshotEvents?(): readonly { type?: string }[]
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

  const resolve = async (session: Session, allowNewStable = true): Promise<ProjectionResolution> => {
    const id = typeof session?.id === 'string' && session.id.trim() !== ''
      ? session.id : undefined
    const unknownOrLegacy = (): ProjectionResolution => hasPriorModelHistory(session) ? 'unknown' : 'legacy'
    if (!id) return unknownOrLegacy()
    if (cache.has(id)) return cache.get(id) as ProjectionMode
    if (pending.has(id)) return pending.get(id) as Promise<ProjectionResolution>
    const task = (async (): Promise<ProjectionResolution> => {
      try {
        const modes = await table()
        if (!modes || closed) return unknownOrLegacy()
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
        return unknownOrLegacy()
      }
    })()
    pending.set(id, task)
    try { return await task } finally { if (pending.get(id) === task) pending.delete(id) }
  }

  return {
    resolve,
    get(id: unknown): ProjectionMode | undefined {
      return typeof id === 'string' ? cache.get(id) : undefined
    },
    // A released Agent will rehydrate the committed row on its next pre-step.
    release(id: unknown) {
      if (typeof id === 'string') cache.delete(id)
    },
  }
}
