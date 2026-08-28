import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createSessionVisionRuntime,
  DEFAULT_SESSION_VISION_STATE_OPTIONS,
} from '../lib/session-vision-runtime.js'
import {
  createSessionVisionStateStore,
  currentSessionVisionStateStore,
} from '../lib/session-vision-state.js'

function ref(id) {
  return { attachmentId: id, name: `${id}.png`, mediaType: 'image/png' }
}

function coreStub() {
  return {
    collectEventAttachmentRefs(events) {
      const out = []
      for (const event of events ?? []) {
        if (Array.isArray(event?.data?.refs)) out.push(...event.data.refs)
      }
      return out
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
    planToolResultImageShadows() { return [] },
    planGuardStopShadows() { return [] },
  }
}

test('explicit SessionVisionRuntime owns exactly one store and one index', () => {
  const runtime = createSessionVisionRuntime({ core: coreStub() })
  assert.ok(runtime.stateStore)
  assert.ok(runtime.index)
  assert.equal(Object.isFrozen(runtime), true)
  assert.deepEqual(
    runtime.stateStore.options,
    DEFAULT_SESSION_VISION_STATE_OPTIONS,
    'closure runtime must preserve the mature core store bounds exactly',
  )
})

test('explicit runtime index remains bound to its own store when legacy current-store pointer drifts', () => {
  const storeA = createSessionVisionStateStore()
  const runtime = createSessionVisionRuntime({ core: coreStub(), stateStore: storeA })
  const session = {
    id: 'session-a',
    events: [{ type: 'user/message', data: { refs: [ref('owned-by-a')] } }],
    surface: { nodes: [0] },
  }

  // Simulate the exact reason the transitional module-global bridge is unsafe:
  // another store is constructed later in the same process.
  const storeB = createSessionVisionStateStore()
  assert.equal(currentSessionVisionStateStore(), storeB)

  runtime.index.scanEventLog(session)
  assert.equal(storeA.lookupAttachment(session, 'owned-by-a')?.attachmentId, 'owned-by-a')
  assert.equal(storeB.lookupAttachment(session, 'owned-by-a'), undefined)
})

test('explicit runtime preserves bounded target-only durable recovery semantics', () => {
  const runtime = createSessionVisionRuntime({
    core: coreStub(),
    stateOptions: { attachmentMaxEntries: 1 },
  })
  const session = {
    id: 'bounded-recovery',
    events: [
      { type: 'user/message', data: { refs: [ref('old')] } },
      { type: 'user/message', data: { refs: [ref('new')] } },
    ],
    surface: { nodes: [0, 1] },
  }

  runtime.index.scanEventLog(session)
  assert.equal(runtime.stateStore.stateStats(session).attachments, 1)
  assert.equal(runtime.index.lookupAttachment(session, 'old')?.attachmentId, 'old')
  assert.equal(runtime.stateStore.stateStats(session).attachments, 1)
})
