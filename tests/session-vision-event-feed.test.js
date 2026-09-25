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
