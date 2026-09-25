import test from 'node:test'
import assert from 'node:assert/strict'

import { sessionSurfaceReplacementIntent } from '../lib/session-surface-compat.js'
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

function sessionWith(events = [], nodes = events.map((_, index) => index), version = 0) {
  return {
    id: `session-${Math.random()}`,
    header: { version },
    events: [...events],
    surface: { nodes: [...nodes] },
    appended: [],
    async append(type, data, options) {
      const seq = this.events.length
      this.events.push({ type, data })
      this.appended.push({ type, data, options })
      if (options?.surfaceOp?.op === 'replace') {
        const start = this.header.version === 3
          ? options.surfaceOp.startSeq
          : options.surfaceOp.start
        const at = this.surface.nodes.indexOf(start)
        if (at >= 0) this.surface.nodes[at] = seq
      } else {
        this.surface.nodes.push(seq)
      }
      return seq
    },
  }
}

test('surface replacement intent follows Session format rather than DSH package version', () => {
  assert.deepEqual(sessionSurfaceReplacementIntent({ header: { version: 0 } }, 7), {
    surfaceOp: { op: 'replace', start: 7, end: 7 },
    sourceEventSeqs: [7],
  })
  assert.deepEqual(sessionSurfaceReplacementIntent({ header: { version: 2 } }, 7), {
    surfaceOp: { op: 'replace', start: 7, end: 7 },
    sourceEventSeqs: [7],
  })
  assert.deepEqual(sessionSurfaceReplacementIntent({ header: { version: 3 } }, 7), {
    surfaceOp: { op: 'replace', startSeq: 7, endSeq: 7 },
    sourceEventSeqs: [7],
  })
  assert.equal(sessionSurfaceReplacementIntent({ header: { version: 4 } }, 7), undefined)
  assert.equal(sessionSurfaceReplacementIntent({}, 7), undefined)
  assert.throws(() => sessionSurfaceReplacementIntent({ header: { version: 3 } }, -1), /non-negative safe integer/)
})

test('state-store factories are independent and expose no implicit current owner', () => {
  const first = createSessionVisionStateStore()
  const second = createSessionVisionStateStore()
  const session = { id: 'factory-isolation' }
  first.recordAttachments(session, [ref('first-only')])
  assert.equal(first.lookupAttachment(session, 'first-only')?.attachmentId, 'first-only')
  assert.equal(second.lookupAttachment(session, 'first-only'), undefined)
})

test('pre-step attachment indexing stays message-driven when no surface repair is pending', async () => {
  const store = createSessionVisionStateStore({ attachmentMaxEntries: 8 })
  let historyReads = 0
  const session = sessionWith([], [])
  session.snapshotEvents = () => {
    historyReads += 1
    throw new Error('raw Session history must not be read on the idle pre-step hot path')
  }
  const index = createSessionVisionIndex({ stateStore: store, core: coreStub() })
  const current = ref('current')
  const payload = {
    agent: { session },
    messages: [{ role: 'user', content: [{ type: 'image', attachment: current }] }],
  }
  const decision = { kind: 'continue', messages: payload.messages }

  assert.equal(await index.prepareDecision(payload, decision), decision)
  assert.equal(historyReads, 0)
  assert.equal(store.lookupAttachment(session, 'current')?.attachmentId, 'current')
})

test('bounded attachment eviction keeps sync lookup cache-only and recovers through async Session log read', async () => {
  const store = createSessionVisionStateStore({ attachmentMaxEntries: 1 })
  const originalLookup = store.lookupAttachment
  const events = [
    { type: 'user/message', data: { refs: [ref('old')] } },
    { type: 'user/message', data: { refs: [ref('new')] } },
  ]
  let syncReads = 0
  const session = sessionWith(events)
  session.snapshotEvents = () => { syncReads += 1; throw new Error('deprecated sync history read') }
  Object.defineProperty(session, 'events', {
    configurable: true,
    get() { syncReads += 1; throw new Error('deprecated bare history read') },
  })
  let asyncReads = 0
  const index = createSessionVisionIndex({
    stateStore: store,
    core: coreStub(),
    readSessionLog: async () => {
      asyncReads += 1
      return { supported: true, events }
    },
  })

  index.recordAttachments(session, [ref('old'), ref('new')])
  assert.equal(store.stateStats(session).attachments, 1)
  assert.equal(store.lookupAttachment(session, 'old'), undefined)
  assert.equal(index.lookupAttachment(session, 'old'), undefined, 'sync lookup must stay cache-only')
  assert.equal(asyncReads, 0)
  assert.equal((await index.resolveAttachment(session, 'old'))?.attachmentId, 'old')
  assert.equal(asyncReads, 1)
  assert.equal(syncReads, 0)
  assert.equal(store.lookupAttachment, originalLookup)
  assert.equal(store.stateStats(session).attachments, 1)
})

test('batch attachment recovery reads one Session log and returns all requested refs beyond cache capacity', async () => {
  const events = [
    { type: 'user/message', data: { refs: [ref('one'), ref('two'), ref('three')] } },
  ]
  let reads = 0
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore({ attachmentMaxEntries: 1 }),
    core: coreStub(),
    readSessionLog: async () => {
      reads += 1
      return { supported: true, events }
    },
  })
  const session = { id: 'batch-recovery' }

  const resolved = await index.resolveAttachments(session, ['one', 'two', 'three'])
  assert.equal(reads, 1)
  assert.deepEqual([...resolved.keys()], ['one', 'two', 'three'])
  assert.equal(resolved.get('one')?.attachmentId, 'one')
  assert.equal(resolved.get('two')?.attachmentId, 'two')
  assert.equal(resolved.get('three')?.attachmentId, 'three')
})

test('advertised async attachment recovery failure never falls back to synchronous Session history', async () => {
  let syncReads = 0
  const session = sessionWith([])
  session.snapshotEvents = () => { syncReads += 1; throw new Error('sync fallback forbidden') }
  Object.defineProperty(session, 'events', {
    configurable: true,
    get() { syncReads += 1; throw new Error('sync fallback forbidden') },
  })
  const warnings = []
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    logger: { warn: (...args) => warnings.push(args) },
    readSessionLog: async () => { throw new Error('transient SessionQuery failure') },
  })

  assert.equal(await index.resolveAttachment(session, 'missing'), undefined)
  assert.equal(syncReads, 0)
  assert.equal(warnings.length, 1)
})

test('explicitly unsupported async attachment recovery preserves the released Session-local fallback', async () => {
  const session = sessionWith([
    { type: 'user/message', data: { refs: [ref('legacy')] } },
  ])
  let capabilityChecks = 0
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    readSessionLog: async () => {
      capabilityChecks += 1
      return { supported: false }
    },
  })

  assert.equal((await index.resolveAttachment(session, 'legacy'))?.attachmentId, 'legacy')
  assert.equal(capabilityChecks, 1)
})

test('surface repair reads one async Session snapshot for every pending tool-result node', async () => {
  const events = [
    { seq: 0, type: 'tool/result', data: { message: { hasImage: true, text: 'first' } } },
    { seq: 1, type: 'tool/result', data: { message: { hasImage: true, text: 'second' } } },
  ]
  const session = sessionWith(events, [0, 1], 3)
  let logReads = 0
  let eventReads = 0
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    readSessionLog: async () => {
      logReads += 1
      return { supported: true, events }
    },
    readSessionEvent: async () => {
      eventReads += 1
      throw new Error('per-event SessionQuery reads must not run when a snapshot is available')
    },
  })

  assert.equal(await index.repairToolResultSurface(session), 2)
  assert.equal(logReads, 1)
  assert.equal(eventReads, 0)
  assert.deepEqual(session.appended.map((entry) => entry.data.message.sanitized), [true, true])
})

test('guard-stop repair reads one async Session snapshot for every pending surface node', async () => {
  const events = [
    { seq: 0, type: 'user/message', data: { id: 'vision-router-structured-guard-stop-1', guardStop: true } },
    { seq: 1, type: 'user/message', data: { id: 'vision-router-structured-guard-stop-2', guardStop: true } },
  ]
  const session = sessionWith(events, [0, 1], 3)
  let logReads = 0
  let eventReads = 0
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    readSessionLog: async () => {
      logReads += 1
      return { supported: true, events }
    },
    readSessionEvent: async () => {
      eventReads += 1
      throw new Error('per-event SessionQuery reads must not run when a snapshot is available')
    },
  })

  assert.equal(await index.repairGuardStopSurface(session), 2)
  assert.equal(logReads, 1)
  assert.equal(eventReads, 0)
  assert.deepEqual(session.appended.map((entry) => entry.data.expired), [true, true])
})

test('supported async surface reader repairs tool results without touching synchronous Session history', async () => {
  const event = { seq: 0, type: 'tool/result', data: { message: { hasImage: true, text: 'tool result' } } }
  let syncReads = 0
  const session = {
    id: 'async-tool-repair',
    header: { version: 3 },
    surface: { nodes: [0] },
    appended: [],
    snapshotEvents() { syncReads += 1; throw new Error('deprecated sync history read') },
    async append(type, data, options) { this.appended.push({ type, data, options }); return 1 },
  }
  Object.defineProperty(session, 'events', {
    get() { syncReads += 1; throw new Error('deprecated bare history read') },
  })
  const reads = []
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    readSessionEvent: async (_session, seq) => {
      reads.push(seq)
      return { supported: true, event }
    },
  })

  assert.equal(await index.repairToolResultSurface(session), 1)
  assert.deepEqual(reads, [0])
  assert.equal(syncReads, 0)
  assert.equal(session.appended[0].data.message.sanitized, true)
})

test('supported async surface reader repairs guard stops without touching synchronous Session history', async () => {
  const event = {
    seq: 0,
    type: 'user/message',
    data: { id: 'vision-router-structured-guard-stop-1', guardStop: true },
  }
  let syncReads = 0
  const session = {
    id: 'async-guard-repair',
    header: { version: 3 },
    surface: { nodes: [0] },
    appended: [],
    snapshotEvents() { syncReads += 1; throw new Error('deprecated sync history read') },
    async append(type, data, options) { this.appended.push({ type, data, options }); return 1 },
  }
  Object.defineProperty(session, 'events', {
    get() { syncReads += 1; throw new Error('deprecated bare history read') },
  })
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    readSessionEvent: async () => ({ supported: true, event }),
  })

  assert.equal(await index.repairGuardStopSurface(session), 1)
  assert.equal(syncReads, 0)
  assert.equal(session.appended[0].data.expired, true)
})

test('advertised async reader failure retries the exact failed node and never falls back to sync history', async () => {
  const events = [
    { seq: 0, type: 'tool/result', data: { message: { hasImage: false } } },
    { seq: 1, type: 'tool/result', data: { message: { hasImage: true } } },
  ]
  const calls = []
  let failSecond = true
  let syncReads = 0
  const session = {
    id: 'async-retry',
    header: { version: 3 },
    surface: { nodes: [0, 1] },
    appended: [],
    snapshotEvents() { syncReads += 1; throw new Error('sync fallback forbidden') },
    async append(type, data, options) { this.appended.push({ type, data, options }); return 2 },
  }
  Object.defineProperty(session, 'events', {
    get() { syncReads += 1; throw new Error('sync fallback forbidden') },
  })
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    logger: { warn() {} },
    readSessionEvent: async (_session, seq) => {
      calls.push(seq)
      if (seq === 1 && failSecond) {
        failSecond = false
        throw new Error('transient SessionQuery failure')
      }
      return { supported: true, event: events[seq] }
    },
  })

  assert.equal(await index.repairToolResultSurface(session), 0)
  assert.deepEqual(calls, [0, 1])
  assert.equal(syncReads, 0)
  assert.equal(await index.repairToolResultSurface(session), 1)
  assert.deepEqual(calls, [0, 1, 1], 'the successful first node must not be re-read')
  assert.equal(syncReads, 0)
})

test('explicitly unsupported async capability falls back to the released Session-local reader', async () => {
  const session = sessionWith([
    { type: 'tool/result', data: { message: { hasImage: true } } },
  ])
  let capabilityChecks = 0
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    readSessionEvent: async () => {
      capabilityChecks += 1
      return { supported: false }
    },
  })

  assert.equal(await index.repairToolResultSurface(session), 1)
  assert.equal(capabilityChecks, 1)
})

test('surface repair retries an unread batch instead of advancing its cursor', async () => {
  const store = createSessionVisionStateStore()
  let readable = false
  const event = { type: 'tool/result', data: { message: { hasImage: true, text: 'tool result' } } }
  const session = sessionWith([], [0])
  Object.defineProperty(session, 'events', {
    configurable: true,
    get() {
      if (!readable) throw new Error('transient history read failure')
      return [event]
    },
  })
  const index = createSessionVisionIndex({ stateStore: store, core: coreStub() })

  assert.equal(await index.repairToolResultSurface(session), 0)
  readable = true
  assert.equal(await index.repairToolResultSurface(session), 1)
})

test('tool-result surface repair is incremental and persists legacy Host replacement events', async () => {
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

test('tool-result surface repair emits the v3 replacement contract on current Sessions', async () => {
  const store = createSessionVisionStateStore()
  const session = sessionWith([
    { type: 'tool/result', data: { message: { hasImage: true, text: 'tool result' } } },
  ], [0], 3)
  const index = createSessionVisionIndex({ stateStore: store, core: coreStub() })

  assert.equal(await index.repairToolResultSurface(session), 1)
  assert.deepEqual(session.appended[0].options, {
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
    sourceEventSeqs: [0],
  })
})

test('unknown future Session surface formats skip durable repair without breaking the turn', async () => {
  const warnings = []
  const session = sessionWith([
    { type: 'tool/result', data: { message: { hasImage: true, text: 'tool result' } } },
  ], [0], 4)
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    logger: { warn: (...args) => warnings.push(args) },
  })

  assert.equal(await index.repairToolResultSurface(session), 0)
  assert.equal(session.appended.length, 0)
  assert.equal(warnings.length, 1)
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

  let observedCurrent
  let observedDurableCache
  wrapped.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    observedCurrent = store.lookupAttachment(payload.agent.session, 'current')
    observedDurableCache = store.lookupAttachment(payload.agent.session, 'durable')
    return decision
  })

  const session = sessionWith([
    { type: 'user/message', data: { refs: [ref('durable')] } },
  ], [])
  const payload = {
    agent: { session },
    messages: [{ role: 'user', content: [{ type: 'image', attachment: ref('current') }] }],
  }
  const decision = { kind: 'continue', messages: payload.messages }
  const registered = handlers.get('agent/pre-step')
  assert.ok(registered)
  const result = await registered(payload, async () => decision)

  assert.equal(result, decision)
  assert.equal(observedCurrent?.attachmentId, 'current')
  assert.equal(observedDurableCache, undefined, 'pre-step must not eagerly index arbitrary durable history')
  assert.equal(index.lookupAttachment(session, 'durable'), undefined)
  assert.equal((await index.resolveAttachment(session, 'durable'))?.attachmentId, 'durable')
  assert.equal(store.lookupAttachment(session, 'current')?.attachmentId, 'current')
})
