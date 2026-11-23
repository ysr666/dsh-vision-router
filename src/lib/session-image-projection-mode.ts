import { z } from 'zod'
import type { Domain, DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'

type ProjectionMode = 'legacy' | 'stable'
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
}

function usableFacility(ctx: Context): Facility | undefined {
  try {
    const candidate = ctx.get?.('storageDomain') as Facility | undefined
    return typeof candidate?.open === 'function' ? candidate : undefined
  } catch { return undefined }
}

function hasPriorModelHistory(session: Session): boolean {
  // Refuse to label a fork, imported history, or old Session "new".
  try {
    if (session.requestHeader?.() !== undefined) return true
  } catch { return true }
  try {
    if (typeof session.seq === 'number' && typeof session.eventAt === 'function') {
      for (let index = 0; index < session.seq; index++) {
        const type = session.eventAt(index)?.type
        if (type === 'request/header' || type === 'assistant/message' ||
            type === 'user/message' || type === 'tool/result') return true
      }
      return false
    }
    if (typeof session.snapshotEvents === 'function') {
      return session.snapshotEvents().some(event =>
        ['request/header', 'assistant/message', 'user/message', 'tool/result'].includes(event?.type ?? ''))
    }
  } catch { return true }
  // A Host with no trustworthy Session history inspection must remain legacy.
  return true
}

/**
 * A Session's text-only image format is selected before its first request and
 * persisted before admitting the resulting model-visible history. A preexisting
 * Session with any committed message or request cannot silently migrate.
 *
 * If the official storageDomain is absent, unavailable or returns an unknown
 * row, callers use legacy projection: volatile "stable" guesses must never be
 * allowed to become a different format after process restart.
 */
export function createSessionImageProjectionModeStore(ctx: Context) {
  const cache = new Map<string, ProjectionMode>()
  const pending = new Map<string, Promise<ProjectionMode>>()
  let open: Promise<Domain<DomainSpec> | undefined> | undefined
  let handle: Domain<DomainSpec> | undefined
  let closed = false
  let owned = false
  let warned = false

  const warn = (error: unknown) => {
    if (warned) return
    warned = true
    ctx.logger?.warn?.('vision-router: stable image projection storage unavailable; retain legacy Session projection (%s)',
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
          return undefined
        })
    }
    const domain = await open
    return domain?.table('modes') as KvTable<string, RecordValue> | undefined
  }

  const resolve = async (session: Session, allowNewStable = true): Promise<ProjectionMode> => {
    const id = typeof session?.id === 'string' && session.id.trim() !== ''
      ? session.id : undefined
    if (!id) return 'legacy'
    if (cache.has(id)) return cache.get(id) as ProjectionMode
    if (pending.has(id)) return pending.get(id) as Promise<ProjectionMode>
    const task = (async (): Promise<ProjectionMode> => {
      try {
        const modes = await table()
        if (!modes || closed) return 'legacy'
        const stored = recordSchema.safeParse(modes.get(id))
        if (stored.success) {
          cache.set(id, stored.data.mode)
          return stored.data.mode
        }
        // A corrupt/unknown persisted row must not be silently replaced.
        if (modes.get(id) !== undefined) return 'legacy'
        const mode = allowNewStable && !hasPriorModelHistory(session) ? 'stable' : 'legacy'
        await modes.put(id, { revision: 1, mode })
        if (closed) return 'legacy'
        cache.set(id, mode)
        return mode
      } catch (error) {
        warn(error)
        return 'legacy'
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
