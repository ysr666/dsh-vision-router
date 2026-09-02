import { currentSessionSurfacePolicy } from './session-surface-policy.js'
import { createSessionVisionStateStore } from './session-vision-state.js'

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function sessionEvents(session) {
  try {
    // dsh 0.1.2-alpha.4 removed the bare `session.events` array in favor of
    // `session.snapshotEvents()`; both are handled so one build runs on both
    // harness generations.
    if (session && typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      return Array.isArray(events) ? events : undefined
    }
    return Array.isArray(session?.events) ? session.events : undefined
  } catch {
    return undefined
  }
}

function surfaceNodes(session) {
  try {
    return Array.isArray(session?.surface?.nodes) ? session.surface.nodes : undefined
  } catch {
    return undefined
  }
}

function messagesFrom(payload, decision) {
  if (Array.isArray(decision?.messages)) return decision.messages
  return Array.isArray(payload?.messages) ? payload.messages : []
}

function boundedMessage(error) {
  const text = error?.message ?? error
  return String(text ?? '').slice(0, 400)
}

/**
 * Session visual data-plane index.
 *
 * SessionVisionStateStore remains the bounded storage owner. This object owns
 * incremental durable-log scan, target-only recovery after bounded-cache
 * eviction, tool-result image surface repair and expired structured guard-stop
 * surface repair.
 *
 * The index never replaces stateStore.lookupAttachment(). Durable recovery is
 * requested explicitly through index.lookupAttachment(), so storage and
 * recovery ownership remain visible at the call site.
 */
export function createSessionVisionIndex({
  stateStore,
  core,
  config = {},
  logger,
} = {}) {
  if (!core || typeof core !== 'object') throw new TypeError('session vision index requires core helpers')

  // Direct/test callers get an isolated bounded store rather than discovering
  // a module-global "current" owner. Production passes the composition-owned
  // SessionVisionRuntime store explicitly.
  const store = stateStore ?? createSessionVisionStateStore()
  if (!store || typeof store !== 'object') {
    throw new TypeError('session vision index requires a state store')
  }
  const primitiveLookup = typeof store.lookupAttachment === 'function'
    ? store.lookupAttachment.bind(store)
    : undefined
  const toolSurfaceScans = new WeakMap()
  const guardSurfaceScans = new WeakMap()

  const recordAttachments = (session, refs) => {
    if (!session || !Array.isArray(refs) || refs.length === 0) return
    store.recordAttachments(session, refs)
  }

  const scanEventLog = (session) => {
    if (!session) return
    const events = sessionEvents(session)
    if (!events || events.length === 0) return
    const last = store.getScannedEventSeq(session)
    if (last >= events.length) return
    const refs = typeof core.collectEventAttachmentRefs === 'function'
      ? core.collectEventAttachmentRefs(events.slice(last))
      : []
    // Advance even when no refs are present so irrelevant durable history is
    // never rescanned indefinitely.
    store.setScannedEventSeq(session, events.length)
    if (Array.isArray(refs) && refs.length > 0) store.recordAttachments(session, refs)
  }

  const lookupAttachment = (session, id) => {
    if (!primitiveLookup) return undefined
    let hit = primitiveLookup(session, id)
    if (hit !== undefined) return hit
    if (session === undefined) return undefined

    scanEventLog(session)
    hit = primitiveLookup(session, id)
    if (hit !== undefined) return hit

    // Bounded cache eviction is a performance event, never a correctness
    // event. Recover only the requested durable ref instead of rebuilding an
    // unbounded attachment index.
    const events = sessionEvents(session)
    if (!events || events.length === 0 || typeof core.collectEventAttachmentRefs !== 'function') {
      return undefined
    }
    const wanted = String(id)
    const recovered = core.collectEventAttachmentRefs(events).find(
      (ref) => ref && String(ref.attachmentId ?? ref.id) === wanted,
    )
    if (recovered !== undefined) {
      store.recordAttachments(session, [recovered])
      return recovered
    }
    return undefined
  }

  const nextSurfaceSeqs = (scans, session) => {
    if (!session) return []
    const nodes = surfaceNodes(session)
    if (!nodes || nodes.length === 0) return []
    let scan = scans.get(session)
    if (!scan) {
      scan = { count: 0 }
      scans.set(session, scan)
    }
    // Compaction/resume may shrink/rebuild the surface. Reset the incremental
    // cursor rather than assuming old indices still refer to the new surface.
    if (scan.count > nodes.length) scan.count = 0
    const fresh = nodes.slice(scan.count)
    scan.count = nodes.length
    return fresh
  }

  const keepToolResultImages = () => {
    const policy = currentSessionSurfacePolicy(
      typeof config === 'function' ? config() : config,
    )
    return policy.ownership === 'native-image' || policy.ownership === 'vision-router-owned'
  }

  const repairToolResultSurface = async (session) => {
    const events = sessionEvents(session)
    if (!events || typeof session?.append !== 'function') return 0
    const seqs = nextSurfaceSeqs(toolSurfaceScans, session)
    if (seqs.length === 0 || typeof core.planToolResultImageShadows !== 'function') return 0
    const preserve = keepToolResultImages()
    const plans = core.planToolResultImageShadows(events, seqs, () => !preserve)
    let repaired = 0
    for (const plan of plans) {
      try {
        await session.append(
          'tool/result',
          { ...plan.event.data, message: plan.message },
          {
            surfaceOp: { op: 'replace', start: plan.seq, end: plan.seq },
            sourceEventSeqs: [plan.seq],
          },
        )
        repaired += 1
      } catch (error) {
        logger?.warn?.(
          'vision-router: session tool-result surface repair failed seq=%s error=%s',
          plan.seq,
          boundedMessage(error),
        )
      }
    }
    return repaired
  }

  const repairGuardStopSurface = async (session) => {
    const events = sessionEvents(session)
    if (!events || typeof session?.append !== 'function') return 0
    const seqs = nextSurfaceSeqs(guardSurfaceScans, session)
    if (seqs.length === 0 || typeof core.planGuardStopShadows !== 'function') return 0
    const plans = core.planGuardStopShadows(events, seqs)
    let repaired = 0
    for (const plan of plans) {
      try {
        await session.append(
          'user/message',
          plan.data,
          {
            surfaceOp: { op: 'replace', start: plan.seq, end: plan.seq },
            sourceEventSeqs: [plan.seq],
          },
        )
        repaired += 1
      } catch (error) {
        logger?.warn?.(
          'vision-router: session guard-stop surface repair failed seq=%s error=%s',
          plan.seq,
          boundedMessage(error),
        )
      }
    }
    return repaired
  }

  const prepareDecision = async (payload, decision) => {
    const session = payload?.agent?.session
    if (!session) return decision

    const messages = messagesFrom(payload, decision)
    if (typeof core.rewriteImageBlocks === 'function') {
      const found = core.rewriteImageBlocks(messages)
      if (Array.isArray(found?.attachments) && found.attachments.length > 0) {
        store.recordAttachments(session, found.attachments)
      }
    }
    scanEventLog(session)
    await repairToolResultSurface(session)
    await repairGuardStopSurface(session)
    return decision
  }

  return Object.freeze({
    recordAttachments,
    scanEventLog,
    lookupAttachment,
    repairToolResultSurface,
    repairGuardStopSurface,
    prepareDecision,
  })
}

/**
 * Intercept core's pre-step registration and decorate only its downstream
 * `next()` result. Production passes `options.index`; direct/test callers get
 * an isolated index/store unless they explicitly provide `options.stateStore`.
 */
export function installSessionVisionIndexBoundary(ctx, config, core, options = {}) {
  if (!isObject(ctx)) return ctx
  const index = options.index ?? createSessionVisionIndex({
    stateStore: options.stateStore,
    core,
    config: () => {
      try {
        const settings = ctx?.get?.('settings')
        const live = settings?.get?.('vision-router')
        if (live && typeof live === 'object' && !Array.isArray(live)) return live
      } catch {}
      return config
    },
    logger: options.logger,
  })

  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'on') {
        const on = Reflect.get(target, property, target)
        if (typeof on !== 'function') return on
        return (event, handler, ...rest) => {
          if (event !== 'agent/pre-step' || typeof handler !== 'function') {
            return on.call(target, event, handler, ...rest)
          }
          return on.call(
            target,
            event,
            async function sessionVisionIndexedPreStep(payload, next) {
              const indexedNext = typeof next === 'function'
                ? async (...args) => {
                    const decision = await next(...args)
                    return index.prepareDecision(payload, decision)
                  }
                : next
              return handler.call(this, payload, indexedNext)
            },
            ...rest,
          )
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
