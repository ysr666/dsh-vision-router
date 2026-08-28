import { currentSessionSurfacePolicy } from './session-surface-policy.js'
import { currentSessionVisionStateStore } from './session-vision-state.js'

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function sessionEvents(session) {
  try {
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
 * `legacyLookupDelegation` exists only for the pre-Closure monolithic-core
 * compatibility path. New explicit SessionVisionRuntime instances set it to
 * false, so the index never replaces stateStore.lookupAttachment().
 */
export function createSessionVisionIndex({
  stateStore = currentSessionVisionStateStore,
  core,
  config = {},
  logger,
  legacyLookupDelegation = true,
} = {}) {
  if (!core || typeof core !== 'object') throw new TypeError('session vision index requires core helpers')
  const adoptedStores = new WeakSet()
  const primitiveLookupByStore = new WeakMap()
  const toolSurfaceScans = new WeakMap()
  const guardSurfaceScans = new WeakMap()

  const primitiveLookupFor = (store) => {
    let primitive = primitiveLookupByStore.get(store)
    if (primitive) return primitive
    primitive = typeof store?.lookupAttachment === 'function'
      ? store.lookupAttachment.bind(store)
      : undefined
    if (primitive) primitiveLookupByStore.set(store, primitive)
    return primitive
  }

  const storeNow = () => {
    const store = typeof stateStore === 'function' ? stateStore() : stateStore
    if (!store || typeof store !== 'object') return undefined
    if (legacyLookupDelegation === true) adoptStore(store)
    return store
  }

  const recordAttachments = (session, refs) => {
    const store = storeNow()
    if (!store || !session || !Array.isArray(refs) || refs.length === 0) return
    store.recordAttachments(session, refs)
  }

  const scanEventLogWithStore = (store, session) => {
    if (!store || !session) return
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

  const scanEventLog = (session) => {
    const store = storeNow()
    if (store) scanEventLogWithStore(store, session)
  }

  const lookupWithStore = (store, primitiveLookup, session, id) => {
    let hit = primitiveLookup(session, id)
    if (hit !== undefined) return hit
    if (session === undefined) return undefined

    scanEventLogWithStore(store, session)
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

  function adoptStore(store) {
    if (legacyLookupDelegation !== true || adoptedStores.has(store)) return store
    const original = primitiveLookupFor(store)
    if (original) {
      // Compatibility delegation for the pre-Closure monolithic core. The new
      // explicit runtime never enters this branch.
      store.lookupAttachment = (session, id) => lookupWithStore(store, original, session, id)
    }
    adoptedStores.add(store)
    return store
  }

  const lookupAttachment = (session, id) => {
    const store = storeNow()
    if (!store) return undefined
    const primitive = primitiveLookupFor(store)
    if (!primitive) return undefined
    if (legacyLookupDelegation === true && adoptedStores.has(store)) {
      return store.lookupAttachment(session, id)
    }
    return lookupWithStore(store, primitive, session, id)
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
    const store = storeNow()
    if (!store) return decision

    const messages = messagesFrom(payload, decision)
    if (typeof core.rewriteImageBlocks === 'function') {
      const found = core.rewriteImageBlocks(messages)
      if (Array.isArray(found?.attachments) && found.attachments.length > 0) {
        store.recordAttachments(session, found.attachments)
      }
    }
    scanEventLogWithStore(store, session)
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
 * `next()` result. Passing `options.index` is the C1 explicit-runtime seam; the
 * legacy path still constructs an index from the transitional current store.
 */
export function installSessionVisionIndexBoundary(ctx, config, core, options = {}) {
  if (!isObject(ctx)) return ctx
  const index = options.index ?? createSessionVisionIndex({
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
