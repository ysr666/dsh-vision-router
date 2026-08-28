import test from 'node:test'
import assert from 'node:assert/strict'

import { createSessionVisionStateStore } from '../lib/session-vision-state.js'
import {
  createSessionVisionIndex,
  installSessionVisionIndexBoundary,
} from '../lib/session-vision-index.js'

function ref(id) {
  return { attachmentId: id, name: `${id}.png`, mediaType: 'image/png' }
}

function collectEventAttachmentRefs(events) {
  const out = []
  for (const event of events ?? []) {
    const refs = event?.data?.refs
    if (Array.isArray(refs)) out.push(...refs)
  }
  return out
}

function coreStub() {
  return {
    collectEventAttachmentRefs,
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

function sessionWith(events = [], nodes = events.map((_, index) => index)) {
  return {
    id: `session-${Math.random()}`,
    events: [...events],
    surface: { nodes: [...nodes] },
    appended: [],
    async append(type, data, options) {
      const seq = this.events.length
      this.events.push({ type, data })
      this.appended.push({ type, data, options })
      if (options?.surfaceOp?.op === 'replace') {
        const at = this.surface.nodes.indexOf(options.surfaceOp.start)
        if (at >= 0) this.surface.nodes[at] = seq
      } else {
        this.surface.nodes.push(seq)
      }
      return seq
    },
  }
}

test('state-store factories are independent and expose no implicit current owner', () => {
  const first = createSessionVisionStateStore()
  const second = createSessionVisionStateStore()
  const session = { id: 'factory-isolation' }
  first.recordAttachments(session, [ref('first-only')])
  assert.equal(first.lookupAttachment(session, 'first-only')?.attachmentId, 'first-only')
  assert.equal(second.lookupAttachment(session, 'first-only'), undefined)
})

test('incremental durable-log scan advances cursor and records only new attachment refs', () => {
  const store = createSessionVisionStateStore({ attachmentMaxEntries: 8 })
  const session = sessionWith([
    { type: 'user/message', data: { refs: [ref('a')] } },
  ])
  const index = createSessionVisionIndex({ stateStore: store, core: coreStub() })

  index.scanEventLog(session)
  assert.equal(store.getScannedEventSeq(session), 1)
  assert.equal(store.lookupAttachment(session, 'a')?.attachmentId, 'a')

  session.events.push({ type: 'user/message', data: { refs: [ref('b')] } })
  index.scanEventLog(session)
  assert.equal(store.getScannedEventSeq(session), 2)
  assert.equal(store.lookupAttachment(session, 'b')?.attachmentId, 'b')
})

test('bounded attachment eviction recovers only through SessionVisionIndex without patching the store API', () => {
  const store = createSessionVisionStateStore({ attachmentMaxEntries: 1 })
  const originalLookup = store.lookupAttachment
  const session = sessionWith([
    { type: 'user/message', data: { refs: [ref('old')] } },
    { type: 'user/message', data: { refs: [ref('new')] } },
  ])
  const index = createSessionVisionIndex({ stateStore: store, core: coreStub() })

  index.scanEventLog(session)
  assert.equal(store.stateStats(session).attachments, 1)
  assert.equal(store.lookupAttachment(session, 'old'), undefined)
  assert.equal(index.lookupAttachment(session, 'old')?.attachmentId, 'old')
  assert.equal(store.lookupAttachment, originalLookup)
  assert.equal(store.stateStats(session).attachments, 1)
})

test('tool-result surface repair is incremental and persists only Host replacement events', async () => {
  const store = createSessionVisionStateStore()
  const session = sessionWith([
    { type: 'tool/result', data: { message: { hasImage: true, text: 'tool result' } } },
  ])
  const index = createSessionVisionIndex({ stateStore: store, core: coreStub() })

  assert.equal(await index.repairToolResultSurface(session), 1)
  assert.equal(session.appended.length, 1)
  assert.equal(session.appended[0].type, 'tool/result')
  assert.equal(session.appended[0].data.message.sanitized, true)
  assert.deepEqual(session.appended[0].options, {
    surfaceOp: { op: 'replace', start: 0, end: 0 },
    sourceEventSeqs: [0],
  })

  assert.equal(await index.repairToolResultSurface(session), 0)
  assert.equal(session.appended.length, 1, 'already-scanned surface nodes must not be rewritten twice')
})

test('guard-stop repair is incremental and preserves the existing user/message replacement contract', async () => {
  const store = createSessionVisionStateStore()
  const session = sessionWith([
    { type: 'user/message', data: { id: 'vision-router-structured-guard-stop-1', guardStop: true } },
  ])
  const index = createSessionVisionIndex({ stateStore: store, core: coreStub() })

  assert.equal(await index.repairGuardStopSurface(session), 1)
  assert.equal(session.appended[0].type, 'user/message')
  assert.equal(session.appended[0].data.expired, true)
  assert.deepEqual(session.appended[0].options.sourceEventSeqs, [0])
  assert.equal(await index.repairGuardStopSurface(session), 0)
})

test('surface cursor resets safely when compaction/replay shrinks the node list', async () => {
  const store = createSessionVisionStateStore()
  const session = sessionWith([
    { type: 'tool/result', data: { message: { hasImage: false } } },
    { type: 'tool/result', data: { message: { hasImage: false } } },
  ])
  const index = createSessionVisionIndex({ stateStore: store, core: coreStub() })
  await index.repairToolResultSurface(session)

  session.events.push({ type: 'tool/result', data: { message: { hasImage: true } } })
  session.surface.nodes = [2]
  assert.equal(await index.repairToolResultSurface(session), 1)
})

test('pre-step boundary prepares downstream decision before mature core resumes', async () => {
  const store = createSessionVisionStateStore()
  const index = createSessionVisionIndex({ stateStore: store, core: coreStub() })
  const handlers = new Map()
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    get() {
      return undefined
    },
  }
  const wrapped = installSessionVisionIndexBoundary(ctx, {}, coreStub(), { index })

  let observedCursor = 0
  wrapped.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    observedCursor = store.getScannedEventSeq(payload.agent.session)
    return decision
  })

  const session = sessionWith([
    { type: 'user/message', data: { refs: [ref('durable')] } },
  ])
  const payload = {
    agent: { session },
    messages: [{ role: 'user', content: [{ type: 'image', attachment: ref('current') }] }],
  }
  const decision = { kind: 'continue', messages: payload.messages }
  const registered = handlers.get('agent/pre-step')
  assert.ok(registered)
  const result = await registered(payload, async () => decision)

  assert.equal(result, decision)
  assert.equal(observedCursor, 1)
  assert.equal(store.lookupAttachment(session, 'durable')?.attachmentId, 'durable')
  assert.equal(store.lookupAttachment(session, 'current')?.attachmentId, 'current')
})
