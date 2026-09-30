import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createSessionVisionIndex,
  installSessionVisionIndexBoundary,
} from '../lib/session-vision-index.js'
import { createSessionVisionStateStore } from '../lib/session-vision-state.js'

function ref(id) {
  return { attachmentId: id, name: `${id}.png`, mediaType: 'image/png' }
}

function coreStub() {
  return {
    collectEventAttachmentRefs(events) {
      const refs = []
      for (const event of events ?? []) {
        const message = event?.type === 'user/message'
          ? event.data
          : event?.data?.message
        for (const block of message?.content ?? []) {
          if (block?.type === 'image' && block.attachment) refs.push(block.attachment)
        }
      }
      return refs
    },
    rewriteImageBlocks(messages) {
      const attachments = []
      for (const message of messages ?? []) {
        for (const block of message?.content ?? []) {
          if (block?.type === 'image' && block.attachment) attachments.push(block.attachment)
        }
      }
      return { messages, attachments }
    },
    planToolResultImageShadows(events, seqs, shouldStrip) {
      const plans = []
      for (const seq of seqs ?? []) {
        const event = events?.[seq]
        if (event?.type !== 'tool/result' || shouldStrip(seq, event) !== true) continue
        if (event?.data?.message?.hasImage !== true) continue
        plans.push({
          seq,
          event,
          message: Object.freeze({ ...event.data.message, hasImage: false, sanitized: true }),
        })
      }
      return plans
    },
    planGuardStopShadows(events, seqs) {
      const plans = []
      for (const seq of seqs ?? []) {
        const event = events?.[seq]
        if (event?.type !== 'user/message' || event?.data?.guardStop !== true) continue
        plans.push({
          seq,
          event,
          data: Object.freeze({ ...event.data, guardStop: false, expired: true }),
        })
      }
      return plans
    },
  }
}

function eventFeedContext() {
  const handlers = new Map()
  return {
    handlers,
    ctx: {
      on(event, handler) {
        handlers.set(event, handler)
        return () => handlers.delete(event)
      },
      get() {
        return undefined
      },
    },
  }
}

function sessionWithSurface(nodes) {
  return {
    id: 'event-feed-session',
    header: { version: 3 },
    surface: { nodes: [...nodes] },
    appended: [],
    async append(type, data, options) {
      this.appended.push({ type, data, options })
      return Math.max(...this.surface.nodes, 0) + this.appended.length
    },
  }
}

test('session event feed repairs exact pending surface events without any SessionQuery history read', async () => {
  let eventReads = 0
  let logReads = 0
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    readSessionEvent: async () => {
      eventReads += 1
      throw new Error('Unable to deserialize cloned data')
    },
    readSessionLog: async () => {
      logReads += 1
      throw new Error('Unable to deserialize cloned data')
    },
  })
  const { ctx, handlers } = eventFeedContext()
  installSessionVisionIndexBoundary(ctx, {}, coreStub(), { index })

  const onSessionEvent = handlers.get('session/event')
  assert.equal(typeof onSessionEvent, 'function')

  const session = sessionWithSurface([0, 1])
  onSessionEvent(session, {
    seq: 0,
    type: 'tool/result',
    surfaceOp: 'append',
    data: { message: { hasImage: true, text: 'image result' } },
  })
  onSessionEvent(session, {
    seq: 1,
    type: 'user/message',
    surfaceOp: 'append',
    data: { id: 'vision-router-structured-guard-stop-1', guardStop: true },
  })

  assert.equal(await index.repairToolResultSurface(session), 1)
  assert.equal(await index.repairGuardStopSurface(session), 1)
  assert.equal(eventReads, 0)
  assert.equal(logReads, 0)
  assert.deepEqual(session.appended.map((entry) => entry.type), ['tool/result', 'user/message'])
  assert.equal(session.appended[0].data.message.sanitized, true)
  assert.equal(session.appended[1].data.expired, true)

  assert.equal(await index.repairToolResultSurface(session), 0)
  assert.equal(await index.repairGuardStopSurface(session), 0)
  assert.equal(eventReads, 0)
  assert.equal(logReads, 0)
})

test('event feed drops a pending repair when the observed event is no longer on the current surface', async () => {
  let logReads = 0
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    readSessionLog: async () => {
      logReads += 1
      throw new Error('history read must stay unreachable')
    },
  })
  const { ctx, handlers } = eventFeedContext()
  installSessionVisionIndexBoundary(ctx, {}, coreStub(), { index })

  const session = sessionWithSurface([0])
  handlers.get('session/event')(session, {
    seq: 0,
    type: 'tool/result',
    surfaceOp: 'append',
    data: { message: { hasImage: true } },
  })
  session.surface.nodes = [7]

  assert.equal(await index.repairToolResultSurface(session), 0)
  assert.equal(session.appended.length, 0)
  assert.equal(logReads, 0)
})

test('session event feed warms durable attachment refs without a cold log recovery', async () => {
  let logReads = 0
  const store = createSessionVisionStateStore()
  const index = createSessionVisionIndex({
    stateStore: store,
    core: coreStub(),
    readSessionLog: async () => {
      logReads += 1
      throw new Error('cold log recovery must not run for an observed attachment')
    },
  })
  const { ctx, handlers } = eventFeedContext()
  installSessionVisionIndexBoundary(ctx, {}, coreStub(), { index })

  const session = sessionWithSurface([0])
  handlers.get('session/event')(session, {
    seq: 0,
    type: 'tool/result',
    surfaceOp: 'append',
    data: {
      message: {
        content: [{ type: 'image', attachment: ref('tool-image') }],
      },
    },
  })

  assert.equal(index.lookupAttachment(session, 'tool-image')?.attachmentId, 'tool-image')
  assert.equal((await index.resolveAttachment(session, 'tool-image'))?.attachmentId, 'tool-image')
  assert.equal(logReads, 0)
})

test('first pre-step after feed activation backfills pre-subscription repairs and attachment refs exactly once', async () => {
  let logReads = 0
  const store = createSessionVisionStateStore()
  const events = [
    {
      seq: 0,
      type: 'tool/result',
      data: {
        message: {
          hasImage: true,
          content: [{ type: 'image', attachment: ref('gap-image') }],
        },
      },
    },
    {
      seq: 1,
      type: 'user/message',
      data: { id: 'vision-router-structured-guard-stop-gap', guardStop: true },
    },
  ]
  const index = createSessionVisionIndex({
    stateStore: store,
    core: coreStub(),
    readSessionLog: async () => {
      logReads += 1
      return { supported: true, events }
    },
  })
  const session = sessionWithSurface([0, 1])
  index.activateSurfaceEventFeed()

  await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })

  assert.equal(logReads, 1)
  assert.deepEqual(session.appended.map((entry) => entry.type), ['tool/result', 'user/message'])
  assert.equal(session.appended[0].data.message.sanitized, true)
  assert.equal(session.appended[1].data.expired, true)
  assert.equal(index.lookupAttachment(session, 'gap-image')?.attachmentId, 'gap-image')

  await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })
  assert.equal(logReads, 1, 'feed backfill must stay one-shot per live session')
  assert.equal(session.appended.length, 2)

  session.surface.nodes.push(2)
  index.recordSessionEvent(session, {
    seq: 2,
    type: 'tool/result',
    data: { message: { hasImage: true, text: 'post-activation' } },
  })
  await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })
  assert.equal(logReads, 1, 'steady-state feed events must remain O(new events) without history reads')
  assert.equal(session.appended.length, 3)
  assert.equal(session.appended[2].data.message.sanitized, true)
})

test('feed activation backfill retries after a transient SessionQuery read failure', async () => {
  let logReads = 0
  const events = [
    {
      seq: 0,
      type: 'tool/result',
      data: {
        message: {
          hasImage: true,
          content: [{ type: 'image', attachment: ref('retry-gap-image') }],
        },
      },
    },
  ]
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    readSessionLog: async () => {
      logReads += 1
      if (logReads === 1) throw new Error('transient session log read failure')
      return { supported: true, events }
    },
  })
  const session = sessionWithSurface([0])
  index.activateSurfaceEventFeed()

  await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })
  assert.equal(logReads, 1)
  assert.equal(session.appended.length, 0, 'failed backfill must not invent a repair')
  assert.equal(index.lookupAttachment(session, 'retry-gap-image'), undefined)

  await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })
  assert.equal(logReads, 2, 'a failed activation snapshot must be retried')
  assert.equal(session.appended.length, 1)
  assert.equal(session.appended[0].data.message.sanitized, true)
  assert.equal(index.lookupAttachment(session, 'retry-gap-image')?.attachmentId, 'retry-gap-image')

  await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })
  assert.equal(logReads, 2, 'successful retry must become the one-shot cached backfill')
  assert.equal(session.appended.length, 1)
})

test('feed activation backfill ignores stale equal-length scan cursors after a surface rebuild', async () => {
  let events = [
    { seq: 0, type: 'tool/result', data: { message: { hasImage: false } } },
    { seq: 1, type: 'user/message', data: { text: 'settled' } },
  ]
  let logReads = 0
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    readSessionLog: async () => {
      logReads += 1
      return { supported: true, events }
    },
  })
  const session = sessionWithSurface([0, 1])

  assert.equal(await index.repairToolResultSurface(session), 0)
  assert.equal(await index.repairGuardStopSurface(session), 0)

  events = [
    undefined,
    undefined,
    { seq: 2, type: 'tool/result', data: { message: { hasImage: true } } },
    {
      seq: 3,
      type: 'user/message',
      data: { id: 'vision-router-structured-guard-stop-rebuilt', guardStop: true },
    },
  ]
  session.surface.nodes = [2, 3]
  index.activateSurfaceEventFeed()

  await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })

  assert.deepEqual(session.appended.map((entry) => entry.type), ['tool/result', 'user/message'])
  assert.equal(session.appended[0].data.message.sanitized, true)
  assert.equal(session.appended[1].data.expired, true)
  assert.equal(logReads, 3, 'two compatibility scans plus one cursor-independent activation snapshot')
})

test('event-feed overflow recovers the dropped guard repair through one exact SessionQuery event read', async () => {
  const events = Array.from({ length: 257 }, (_, seq) => ({
    seq,
    type: 'user/message',
    data: { id: `vision-router-structured-guard-stop-overflow-${seq}`, guardStop: true },
  }))
  let eventReads = 0
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    readSessionEvent: async (_session, seq) => {
      eventReads += 1
      return { supported: true, event: events[seq] }
    },
  })
  const session = sessionWithSurface(events.map((event) => event.seq))
  index.activateSurfaceEventFeed()
  for (const event of events) index.recordSessionEvent(session, event)

  await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })

  assert.equal(eventReads, 1, 'only the one evicted guard event needs an exact recovery read')
  assert.equal(session.appended.length, 257)
  assert.equal(session.appended.some((entry) => entry.data.id === events[0].data.id), true)

  await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })
  assert.equal(eventReads, 1, 'completed overflow recovery must not replay the recovered event')
  assert.equal(session.appended.length, 257)
})

test('event-feed overflow recovers the dropped tool-result repair through exact event ownership', async () => {
  const events = Array.from({ length: 257 }, (_, seq) => ({
    seq,
    type: 'tool/result',
    data: { message: { hasImage: true, text: `tool-${seq}` } },
  }))
  let eventReads = 0
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    readSessionEvent: async (_session, seq) => {
      eventReads += 1
      return { supported: true, event: events[seq] }
    },
  })
  const session = sessionWithSurface(events.map((event) => event.seq))
  index.activateSurfaceEventFeed()
  for (const event of events) index.recordSessionEvent(session, event)

  await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })

  assert.equal(eventReads, 1)
  assert.equal(session.appended.length, 257)
  assert.equal(session.appended[0].data.message.sanitized, true)
})

test('overflow recovery never resurrects an evicted repair that left the current surface', async () => {
  const events = Array.from({ length: 257 }, (_, seq) => ({
    seq,
    type: 'user/message',
    data: { id: `vision-router-structured-guard-stop-removed-${seq}`, guardStop: true },
  }))
  let eventReads = 0
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    readSessionEvent: async (_session, seq) => {
      eventReads += 1
      return { supported: true, event: events[seq] }
    },
  })
  const session = sessionWithSurface(events.map((event) => event.seq))
  index.activateSurfaceEventFeed()
  for (const event of events) index.recordSessionEvent(session, event)
  session.surface.nodes = session.surface.nodes.slice(1)

  await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })

  assert.equal(eventReads, 0, 'a dropped seq absent from the live surface does not need historical I/O')
  assert.equal(session.appended.length, 256)
  assert.equal(session.appended.some((entry) => entry.data.id === events[0].data.id), false)
})

test('large overflow recovery stays bounded per pre-step and eventually repairs every current event', async () => {
  const events = Array.from({ length: 400 }, (_, seq) => ({
    seq,
    type: 'user/message',
    data: { id: `vision-router-structured-guard-stop-bounded-${seq}`, guardStop: true },
  }))
  let eventReads = 0
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    readSessionEvent: async (_session, seq) => {
      eventReads += 1
      return { supported: true, event: events[seq] }
    },
  })
  const session = sessionWithSurface(events.map((event) => event.seq))
  index.activateSurfaceEventFeed()
  for (const event of events) index.recordSessionEvent(session, event)

  let previousReads = 0
  for (let pass = 0; pass < 10 && session.appended.length < events.length; pass += 1) {
    await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })
    assert.ok(eventReads - previousReads <= 32, 'one pre-step must cap exact overflow reads')
    previousReads = eventReads
  }

  assert.equal(eventReads, 144, 'only the 144 evicted events require exact reads')
  assert.equal(session.appended.length, 400)
  assert.equal(new Set(session.appended.map((entry) => entry.data.id)).size, 400)
})

test('overflow recovery retries a transient exact-event failure without losing the dirty repair', async () => {
  const events = Array.from({ length: 257 }, (_, seq) => ({
    seq,
    type: 'user/message',
    data: { id: `vision-router-structured-guard-stop-retry-${seq}`, guardStop: true },
  }))
  let eventReads = 0
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    readSessionEvent: async (_session, seq) => {
      eventReads += 1
      if (eventReads === 1) throw new Error('transient exact-event failure')
      return { supported: true, event: events[seq] }
    },
  })
  const session = sessionWithSurface(events.map((event) => event.seq))
  index.activateSurfaceEventFeed()
  for (const event of events) index.recordSessionEvent(session, event)

  await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })
  assert.equal(eventReads, 1)
  assert.equal(session.appended.length, 256)
  assert.equal(session.appended.some((entry) => entry.data.id === events[0].data.id), false)

  await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })
  assert.equal(eventReads, 2)
  assert.equal(session.appended.length, 257)
  assert.equal(session.appended.some((entry) => entry.data.id === events[0].data.id), true)
})

test('unsupported exact-event recovery remains dirty and retries instead of silently settling overflow', async () => {
  const events = Array.from({ length: 257 }, (_, seq) => ({
    seq,
    type: 'user/message',
    data: { id: `vision-router-structured-guard-stop-unsupported-${seq}`, guardStop: true },
  }))
  let eventReads = 0
  const warnings = []
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    logger: { warn(...args) { warnings.push(args.join(' ')) } },
    readSessionEvent: async () => {
      eventReads += 1
      return { supported: false }
    },
  })
  const session = sessionWithSurface(events.map((event) => event.seq))
  index.activateSurfaceEventFeed()
  for (const event of events) index.recordSessionEvent(session, event)

  await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })
  assert.equal(session.appended.length, 256)
  assert.equal(eventReads, 1)

  await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })
  assert.equal(session.appended.length, 256)
  assert.equal(eventReads, 2, 'unsupported recovery remains dirty and is retried on a later pre-step')
  assert.equal(warnings.some((line) => line.includes('unsupported during feed overflow recovery')), true)
})

test('the normal 256-event feed path performs no exact recovery reads', async () => {
  const events = Array.from({ length: 256 }, (_, seq) => ({
    seq,
    type: 'user/message',
    data: { id: `vision-router-structured-guard-stop-normal-${seq}`, guardStop: true },
  }))
  let eventReads = 0
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    readSessionEvent: async () => {
      eventReads += 1
      throw new Error('normal feed must not perform exact recovery reads')
    },
  })
  const session = sessionWithSurface(events.map((event) => event.seq))
  index.activateSurfaceEventFeed()
  for (const event of events) index.recordSessionEvent(session, event)

  await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })

  assert.equal(eventReads, 0)
  assert.equal(session.appended.length, 256)
})

test('overflow recovery settles a replacement event without enqueueing another repair', async () => {
  const events = Array.from({ length: 257 }, (_, seq) => ({
    seq,
    type: 'user/message',
    data: { id: `vision-router-structured-guard-stop-replacement-${seq}`, guardStop: true },
  }))
  let eventReads = 0
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    readSessionEvent: async (_session, seq) => {
      eventReads += 1
      if (seq === 0) {
        return {
          supported: true,
          event: { ...events[0], surfaceOp: { op: 'replace', target: 0 } },
        }
      }
      return { supported: true, event: events[seq] }
    },
  })
  const session = sessionWithSurface(events.map((event) => event.seq))
  index.activateSurfaceEventFeed()
  for (const event of events) index.recordSessionEvent(session, event)

  await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })
  await index.prepareDecision({ agent: { session }, messages: [] }, { messages: [] })

  assert.equal(eventReads, 1)
  assert.equal(session.appended.length, 256)
  assert.equal(session.appended.some((entry) => entry.data.id === events[0].data.id), false)
})
