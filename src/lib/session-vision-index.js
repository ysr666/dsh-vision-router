import { currentSessionSurfacePolicy } from './session-surface-policy.js'
import { sessionSurfaceReplacementIntent } from './session-surface-compat.js'
import { createSessionVisionStateStore } from './session-vision-state.js'
import { legacySessionEvents } from './session-event-history-compat.js'
import { createSessionVisionAttachmentIndex } from './session-vision-attachment-index.js'

const MAX_PENDING_REPAIR_EVENTS = 256
const MAX_REPAIR_OVERFLOW_RANGES = 32
const MAX_REPAIR_OVERFLOW_INSPECTIONS_PER_PASS = 512
const MAX_REPAIR_OVERFLOW_READS_PER_PASS = 32

function isObject(value) {
  return value !== null && typeof value === 'object'
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

function isReplacementEvent(event) {
  const op = event?.surfaceOp
  return !!op && typeof op === 'object' && !Array.isArray(op) && op.op === 'replace'
}

/**
 * Session visual data-plane index.
 *
 * SessionVisionStateStore remains the bounded storage owner. Attachment cache
 * access and target-only durable recovery are delegated to one typed attachment
 * index; this object owns event-feed-backed tool-result image surface repair and
 * expired structured guard-stop surface repair.
 *
 * Supported DSH Hosts expose the post-commit `session/event` feed. Production
 * surface repair consumes only the exact frozen events observed on that feed;
 * it never asks SessionQuery to materialize or clone the live Session history.
 * The older reader path remains only for isolated/partial callers that do not
 * install the event feed boundary.
 *
 * The index never replaces stateStore.lookupAttachment(). Cache lookup stays
 * synchronous through lookupAttachment(); cold durable recovery is requested
 * explicitly through async resolveAttachment(), so I/O ownership remains visible.
 */
export function createSessionVisionIndex({
  stateStore,
  core,
  config = {},
  logger,
  readSessionEvent,
  readSessionLog,
} = {}) {
  if (!core || typeof core !== 'object') throw new TypeError('session vision index requires core helpers')

  // Direct/test callers get an isolated bounded store rather than discovering
  // a module-global "current" owner. Production passes the composition-owned
  // SessionVisionRuntime store explicitly.
  const store = stateStore ?? createSessionVisionStateStore()
  if (!store || typeof store !== 'object') {
    throw new TypeError('session vision index requires a state store')
  }
  const attachmentIndex = createSessionVisionAttachmentIndex({
    stateStore: store,
    collectEventAttachmentRefs:
      typeof core.collectEventAttachmentRefs === 'function'
        ? (events) => core.collectEventAttachmentRefs(events)
        : undefined,
    readSessionLog,
    logger,
  })
  const {
    recordAttachments,
    lookupAttachment,
    resolveAttachment,
    resolveAttachments,
  } = attachmentIndex

  const pendingSurfaceScan = (scans, session) => {
    if (!session) return undefined
    const nodes = surfaceNodes(session)
    if (!nodes || nodes.length === 0) return undefined
    let scan = scans.get(session)
    if (!scan) {
      scan = { count: 0 }
      scans.set(session, scan)
    }
    // Compaction/resume may shrink/rebuild the surface. Reset the incremental
    // cursor rather than assuming old indices still refer to the new surface.
    if (scan.count > nodes.length) scan.count = 0
    const count = nodes.length
    const seqs = nodes.slice(scan.count)
    if (seqs.length === 0) return undefined
    return {
      seqs,
      advance() {
        if (scan.count < count) scan.count += 1
      },
    }
  }

  const warnRepairReadFailure = (session, seq, error) => {
    const message = boundedMessage(error)
    const previous = repairReadWarnings.get(session)
    if (previous?.seq === seq && previous.message === message) return
    repairReadWarnings.set(session, { seq, message })
    logger?.warn?.(
      'vision-router: session surface event read failed seq=%s error=%s',
      seq,
      message,
    )
  }

  const eventForSurfaceRepair = async (session, seq) => {
    if (typeof readSessionEvent === 'function') {
      let result
      try {
        result = await readSessionEvent(session, seq)
      } catch (error) {
        warnRepairReadFailure(session, seq, error)
        return { readable: false }
      }
      if (result?.supported === true) {
        repairReadWarnings.delete(session)
        return { readable: true, event: result.event }
      }
      if (result?.supported !== false) {
        warnRepairReadFailure(session, seq, new Error('Session event reader returned an invalid capability result'))
        return { readable: false }
      }
    }

    // Isolated/partial Hosts that do not expose SessionQuery retain the released
    // Session-local compatibility path. Supported production Hosts install the
    // event feed and never enter this compatibility reader.
    const events = legacySessionEvents(session)
    if (!events) return { readable: false }
    return { readable: true, event: events[seq] }
  }

  const surfaceRepairSnapshot = async (session, seq) => {
    if (typeof readSessionLog !== 'function') return undefined
    let result
    try {
      result = await readSessionLog(session)
    } catch (error) {
      warnRepairReadFailure(session, seq, error)
      return { readable: false }
    }
    if (result?.supported === true) {
      if (!Array.isArray(result.events)) {
        warnRepairReadFailure(session, seq, new Error('Session log reader returned no event log'))
        return { readable: false }
      }
      repairReadWarnings.delete(session)
      return { readable: true, events: result.events }
    }
    if (result?.supported !== false) {
      warnRepairReadFailure(session, seq, new Error('Session log reader returned an invalid capability result'))
      return { readable: false }
    }
    return undefined
  }

  const eventFromRepairSnapshot = (session, events, seq) => {
    const event = events?.[seq]
    if (!event || typeof event !== 'object' || (event.seq !== undefined && event.seq !== seq)) {
      warnRepairReadFailure(session, seq, new Error(`Session repair snapshot has no event at seq ${seq}`))
      return { readable: false }
    }
    repairReadWarnings.delete(session)
    return { readable: true, event }
  }

  const keepToolResultImages = () => {
    const policy = currentSessionSurfacePolicy(
      typeof config === 'function' ? config() : config,
    )
    return policy.ownership === 'native-image' || policy.ownership === 'vision-router-owned'
  }

  const replacementIntent = (session, seq) => {
    const intent = sessionSurfaceReplacementIntent(session, seq)
    if (intent !== undefined) return intent
    if (!unsupportedSurfaceContracts.has(session)) {
      unsupportedSurfaceContracts.add(session)
      logger?.warn?.(
        'vision-router: skipping durable session surface repair for unsupported Session format version=%s',
        session?.header?.version ?? 'unknown',
      )
    }
    return undefined
  }

  // Feed overflow stores only dropped sequence ranges, never frozen event
  // objects. Adjacent ranges coalesce; pathological sparse overflow is
  // conservatively collapsed once the range count reaches a fixed bound. The
  // recovery loop then advances that range in bounded numeric/read batches and
  // consults only Host-owned readSessionEvent(), so memory remains bounded
  // without returning to whole-Session history materialization.
  const addRepairOverflowSeq = (overflowBySession, session, seq) => {
    if (!Number.isSafeInteger(seq) || seq < 0 || Object.is(seq, -0)) return
    let ranges = overflowBySession.get(session)
    if (!ranges) {
      ranges = []
      overflowBySession.set(session, ranges)
    }

    let start = seq
    let end = seq
    let insertAt = 0
    while (insertAt < ranges.length && ranges[insertAt].end + 1 < start) insertAt += 1
    while (insertAt < ranges.length && ranges[insertAt].start - 1 <= end) {
      start = Math.min(start, ranges[insertAt].start)
      end = Math.max(end, ranges[insertAt].end)
      ranges.splice(insertAt, 1)
    }
    ranges.splice(insertAt, 0, { start, end })

    if (ranges.length > MAX_REPAIR_OVERFLOW_RANGES) {
      overflowBySession.set(session, [{
        start: ranges[0].start,
        end: ranges[ranges.length - 1].end,
      }])
    }
  }

  const advanceRepairOverflowRange = (ranges) => {
    const range = ranges?.[0]
    if (!range) return
    if (range.start >= range.end) ranges.shift()
    else range.start += 1
  }

  const recoverRepairOverflowEvents = async (overflowBySession, pendingBySession, session) => {
    const ranges = overflowBySession.get(session)
    if (!ranges || ranges.length === 0) return []

    const nodes = surfaceNodes(session)
    if (!nodes || nodes.length === 0) {
      overflowBySession.delete(session)
      repairFeedOverflowWarnings.delete(session)
      return []
    }
    const current = new Set(nodes)
    const pending = pendingBySession.get(session)
    const recovered = []
    let inspections = 0
    let reads = 0

    while (
      ranges.length > 0
      && inspections < MAX_REPAIR_OVERFLOW_INSPECTIONS_PER_PASS
      && reads < MAX_REPAIR_OVERFLOW_READS_PER_PASS
    ) {
      const seq = ranges[0].start
      inspections += 1

      // A dropped repair that is no longer on the live surface is settled. A
      // seq still present in the fast-path map will be consumed normally.
      if (!current.has(seq) || pending?.has(seq)) {
        advanceRepairOverflowRange(ranges)
        continue
      }

      if (typeof readSessionEvent !== 'function') {
        warnRepairReadFailure(
          session,
          seq,
          new Error('Session event reader is unavailable during feed overflow recovery'),
        )
        break
      }

      let result
      try {
        result = await readSessionEvent(session, seq)
      } catch (error) {
        warnRepairReadFailure(session, seq, error)
        break
      }
      if (result?.supported !== true) {
        warnRepairReadFailure(
          session,
          seq,
          result?.supported === false
            ? new Error('Session event reader is unsupported during feed overflow recovery')
            : new Error('Session event reader returned an invalid capability result during feed overflow recovery'),
        )
        break
      }
      const event = result.event
      if (!event || typeof event !== 'object' || (event.seq !== undefined && event.seq !== seq)) {
        warnRepairReadFailure(
          session,
          seq,
          new Error(`Session event reader returned no matching event for overflow seq ${seq}`),
        )
        break
      }

      reads += 1
      advanceRepairOverflowRange(ranges)
      repairReadWarnings.delete(session)
      // The live feed may deliver the same committed event while the exact read
      // is in flight. In that case the fast-path map owns it; do not return a
      // second copy from recovery.
      if (!pendingBySession.get(session)?.has(seq) && !isReplacementEvent(event)) {
        recovered.push({ seq, event })
      }
    }

    if (ranges.length === 0) {
      overflowBySession.delete(session)
      repairFeedOverflowWarnings.delete(session)
    }
    return recovered
  }

  const cachePendingRepairEvent = (pendingBySession, overflowBySession, session, event) => {
    if (!session || !Number.isSafeInteger(event?.seq) || event.seq < 0 || Object.is(event.seq, -0)) return
    let pending = pendingBySession.get(session)
    if (!pending) {
      pending = new Map()
      pendingBySession.set(session, pending)
    }
    if (!pending.has(event.seq) && pending.size >= MAX_PENDING_REPAIR_EVENTS) {
      const oldest = pending.keys().next().value
      if (oldest !== undefined) {
        pending.delete(oldest)
        addRepairOverflowSeq(overflowBySession, session, oldest)
      }
      if (!repairFeedOverflowWarnings.has(session)) {
        repairFeedOverflowWarnings.add(session)
        logger?.warn?.(
          'vision-router: session surface repair event feed exceeded %s pending events; scheduling bounded exact-event recovery',
          MAX_PENDING_REPAIR_EVENTS,
        )
      }
    }
    pending.set(event.seq, event)
  }

  const planAgainstOneEvent = (event, planner) => {
    if (!Number.isSafeInteger(event?.seq) || event.seq < 0 || Object.is(event.seq, -0)) return []
    const events = { [event.seq]: event }
    return planner(events, [event.seq])
  }

  const recordSessionEvent = (session, event) => {
    if (!session || !event || typeof event !== 'object') return
    try {
      if (typeof core.collectEventAttachmentRefs === 'function') {
        const refs = core.collectEventAttachmentRefs([event])
        if (Array.isArray(refs) && refs.length > 0) recordAttachments(session, refs)
      }

      // Replacement events are consequences of this repair path and must never
      // be re-enqueued, otherwise a guard-stop replacement would shadow itself
      // forever because its stable plugin-owned id is intentionally preserved.
      if (isReplacementEvent(event)) return

      if (event.type === 'tool/result' && typeof core.planToolResultImageShadows === 'function') {
        const plans = planAgainstOneEvent(
          event,
          (events, seqs) => core.planToolResultImageShadows(events, seqs, () => true),
        )
        if (plans.length > 0) cachePendingRepairEvent(pendingToolRepairEvents, toolRepairOverflowRanges, session, event)
      } else if (event.type === 'user/message' && typeof core.planGuardStopShadows === 'function') {
        const plans = planAgainstOneEvent(event, (events, seqs) => core.planGuardStopShadows(events, seqs))
        if (plans.length > 0) cachePendingRepairEvent(pendingGuardRepairEvents, guardRepairOverflowRanges, session, event)
      }
      repairFeedObserverWarnings.delete(session)
    } catch (error) {
      const message = boundedMessage(error)
      if (repairFeedObserverWarnings.get(session) === message) return
      repairFeedObserverWarnings.set(session, message)
      logger?.warn?.('vision-router: session event feed observation failed error=%s', message)
    }
  }

  const activateSurfaceEventFeed = () => {
    surfaceEventFeedActive = true
  }

  const backfillSurfaceEventFeed = async (session) => {
    let events
    if (typeof readSessionLog === 'function') {
      let result
      try {
        result = await readSessionLog(session)
      } catch (error) {
        warnRepairReadFailure(session, surfaceNodes(session)?.[0] ?? 0, error)
        return false
      }
      if (result?.supported === true) {
        if (!Array.isArray(result.events)) {
          warnRepairReadFailure(session, surfaceNodes(session)?.[0] ?? 0, new Error('Session log reader returned no event log'))
          return false
        }
        events = result.events
      } else if (result?.supported !== false) {
        warnRepairReadFailure(session, surfaceNodes(session)?.[0] ?? 0, new Error('Session log reader returned an invalid capability result'))
        return false
      }
    }

    // Event-feed activation can happen after a live Session already contains
    // committed events (enable/re-enable/HMR). Backfill exactly once from one
    // snapshot, then return to the O(new events) feed path. Older partial Hosts
    // without SessionQuery retain the Session-local compatibility snapshot.
    if (events === undefined) events = legacySessionEvents(session)
    if (!Array.isArray(events)) return true

    const nodes = surfaceNodes(session)
    if (!nodes || nodes.length === 0) return true
    for (const seq of nodes) {
      const event = events[seq]
      if (!event || typeof event !== 'object' || (event.seq !== undefined && event.seq !== seq)) continue
      recordSessionEvent(session, event)
    }
    return true
  }

  const ensureSurfaceEventFeedBackfill = async (session) => {
    if (!surfaceEventFeedActive || !session) return
    let task = surfaceFeedBackfills.get(session)
    if (!task) {
      task = backfillSurfaceEventFeed(session)
      surfaceFeedBackfills.set(session, task)
    }
    try {
      const complete = await task
      if (complete === false && surfaceFeedBackfills.get(session) === task) {
        surfaceFeedBackfills.delete(session)
      }
    } catch (error) {
      if (surfaceFeedBackfills.get(session) === task) surfaceFeedBackfills.delete(session)
      throw error
    }
  }

  const consumePendingRepairEvents = (pendingBySession, session) => {
    const pending = pendingBySession.get(session)
    if (!pending || pending.size === 0) return []
    const nodes = surfaceNodes(session)
    if (!nodes || nodes.length === 0) {
      pending.clear()
      return []
    }
    const current = new Set(nodes)
    for (const seq of pending.keys()) {
      if (!current.has(seq)) pending.delete(seq)
    }
    const entries = []
    for (const seq of nodes) {
      const event = pending.get(seq)
      if (event === undefined) continue
      pending.delete(seq)
      entries.push({ seq, event })
    }
    return entries
  }

  const repairToolResultSurfaceFromFeed = async (session) => {
    if (typeof session?.append !== 'function' || typeof core.planToolResultImageShadows !== 'function') return 0
    const recovered = await recoverRepairOverflowEvents(
      toolRepairOverflowRanges,
      pendingToolRepairEvents,
      session,
    )
    const pending = consumePendingRepairEvents(pendingToolRepairEvents, session)
    const entries = [...recovered, ...pending]
    if (entries.length === 0) return 0
    const preserve = keepToolResultImages()
    let repaired = 0
    for (const { seq, event } of entries) {
      const events = { [seq]: event }
      const plans = core.planToolResultImageShadows(events, [seq], () => !preserve)
      for (const plan of plans) {
        try {
          const intent = replacementIntent(session, plan.seq)
          if (intent === undefined) continue
          await session.append(
            'tool/result',
            { ...plan.event.data, message: plan.message },
            intent,
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
    }
    return repaired
  }

  const repairGuardStopSurfaceFromFeed = async (session) => {
    if (typeof session?.append !== 'function' || typeof core.planGuardStopShadows !== 'function') return 0
    const recovered = await recoverRepairOverflowEvents(
      guardRepairOverflowRanges,
      pendingGuardRepairEvents,
      session,
    )
    const pending = consumePendingRepairEvents(pendingGuardRepairEvents, session)
    const entries = [...recovered, ...pending]
    if (entries.length === 0) return 0
    let repaired = 0
    for (const { seq, event } of entries) {
      const events = { [seq]: event }
      const plans = core.planGuardStopShadows(events, [seq])
      for (const plan of plans) {
        try {
          const intent = replacementIntent(session, plan.seq)
          if (intent === undefined) continue
          await session.append(
            'user/message',
            plan.data,
            intent,
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
    }
    return repaired
  }

  const repairToolResultSurface = async (session) => {
    if (surfaceEventFeedActive) return repairToolResultSurfaceFromFeed(session)
    if (typeof session?.append !== 'function') return 0
    const scan = pendingSurfaceScan(toolSurfaceScans, session)
    if (!scan || typeof core.planToolResultImageShadows !== 'function') return 0
    const preserve = keepToolResultImages()
    const snapshot = await surfaceRepairSnapshot(session, scan.seqs[0])
    if (snapshot?.readable === false) return 0
    let repaired = 0
    for (const seq of scan.seqs) {
      const read = snapshot?.readable === true
        ? eventFromRepairSnapshot(session, snapshot.events, seq)
        : await eventForSurfaceRepair(session, seq)
      if (!read.readable) break
      // A readable node is settled for this repair pass even when it needs no
      // replacement or append later fails; only an unread node remains pending.
      scan.advance()
      const events = []
      events[seq] = read.event
      const plans = core.planToolResultImageShadows(events, [seq], () => !preserve)
      for (const plan of plans) {
        try {
          const intent = replacementIntent(session, plan.seq)
          if (intent === undefined) continue
          await session.append(
            'tool/result',
            { ...plan.event.data, message: plan.message },
            intent,
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
    }
    return repaired
  }

  const repairGuardStopSurface = async (session) => {
    if (surfaceEventFeedActive) return repairGuardStopSurfaceFromFeed(session)
    if (typeof session?.append !== 'function') return 0
    const scan = pendingSurfaceScan(guardSurfaceScans, session)
    if (!scan || typeof core.planGuardStopShadows !== 'function') return 0
    const snapshot = await surfaceRepairSnapshot(session, scan.seqs[0])
    if (snapshot?.readable === false) return 0
    let repaired = 0
    for (const seq of scan.seqs) {
      const read = snapshot?.readable === true
        ? eventFromRepairSnapshot(session, snapshot.events, seq)
        : await eventForSurfaceRepair(session, seq)
      if (!read.readable) break
      scan.advance()
      const events = []
      events[seq] = read.event
      const plans = core.planGuardStopShadows(events, [seq])
      for (const plan of plans) {
        try {
          const intent = replacementIntent(session, plan.seq)
          if (intent === undefined) continue
          await session.append(
            'user/message',
            plan.data,
            intent,
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
        recordAttachments(session, found.attachments)
      }
    }
    await ensureSurfaceEventFeedBackfill(session)
    await repairToolResultSurface(session)
    await repairGuardStopSurface(session)
    return decision
  }

  return Object.freeze({
    recordAttachments,
    recordSessionEvent,
    activateSurfaceEventFeed,
    lookupAttachment,
    resolveAttachment,
    resolveAttachments,
    repairToolResultSurface,
    repairGuardStopSurface,
    prepareDecision,
  })
}

/**
 * Intercept core's pre-step registration and decorate only its downstream
 * `next()` result. Production also subscribes the index to DSH's post-commit
 * `session/event` feed before activating feed-backed surface repair. Direct/test
 * callers without a usable event feed retain the compatibility reader path.
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

  try {
    const on = Reflect.get(ctx, 'on', ctx)
    if (
      typeof on === 'function'
      && typeof index.recordSessionEvent === 'function'
      && typeof index.activateSurfaceEventFeed === 'function'
    ) {
      on.call(ctx, 'session/event', (session, event) => {
        index.recordSessionEvent(session, event)
      })
      index.activateSurfaceEventFeed()
    }
  } catch (error) {
    options.logger?.warn?.(
      'vision-router: session event feed unavailable; retaining compatibility surface reader error=%s',
      boundedMessage(error),
    )
  }

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
