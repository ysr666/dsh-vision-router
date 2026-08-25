import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  blocksHaveImage,
  planGuardStopShadows,
  planToolResultImageShadows,
} from '../index.js'

// Regression: guard-stop stop orders (turn-budget / depth-quota exhausted)
// were injected as user/message events and persisted into session history.
// agent/pre-step only sees the inbox claim — never the historical surface —
// so a pre-step rewrite cannot catch them before Session.deriveMessages()
// feeds history to the adapter. A persisted guard-stop is then replayed on
// EVERY later turn as a standing "never call vision tools again" order, even
// though the per-turn budget/depth quota resets every turn: the first image
// in a session is recognized, but every later image answers "本轮视觉总时间
// 预算已耗尽…" without calling any vision tool.
//
// planGuardStopShadows plans a surface-shadow replacement (surfaceOp replace
// + sourceEventSeqs) for each persisted guard-stop user/message node, so
// every later deriveMessages() projection sees an inert note instead of the
// standing stop order.

const STOP_TEXT = '本轮视觉总时间预算已耗尽。不要再调用视觉工具；请基于已经获得的证据作答，并明确仍存在的不确定性。'

function guardStopEvent(seq, id = 'vision-router-structured-guard-stop-1') {
  return {
    seq,
    type: 'user/message',
    data: {
      role: 'user',
      id,
      content: [{ type: 'text', text: STOP_TEXT }],
      source: { kind: 'plugin', plugin: 'dsh-vision-router' },
    },
  }
}

function plainUserEvent(seq, id) {
  return {
    seq,
    type: 'user/message',
    data: {
      role: 'user',
      id,
      content: [{ type: 'text', text: '看这张图' }],
    },
  }
}

function toolResultEvent(seq) {
  return {
    seq,
    type: 'tool/result',
    data: {
      message: {
        role: 'user',
        id: `msg-${seq}`,
        content: [{ type: 'text', text: 'ok' }],
      },
    },
  }
}

test('planGuardStopShadows plans an inert shadow for every persisted guard-stop', () => {
  const events = [
    guardStopEvent(0, 'vision-router-structured-guard-stop-1'),
    plainUserEvent(1, 'user-1'),
    guardStopEvent(2, 'vision-router-structured-guard-stop-undefined'),
    toolResultEvent(3),
  ]
  const plans = planGuardStopShadows(events, [0, 1, 2, 3])
  assert.equal(plans.length, 2)
  assert.deepEqual(plans.map((plan) => plan.seq), [0, 2])
  for (const plan of plans) {
    // The replacement keeps the user-message envelope and the plugin id.
    assert.equal(plan.data.role, 'user')
    assert.equal(plan.data.id, plan.event.data.id)
    assert.equal(plan.data.source.kind, 'plugin')
    // The stop instruction is gone, replaced by an inert note.
    assert.equal(plan.data.content.length, 1)
    assert.equal(plan.data.content[0].type, 'text')
    assert.equal(plan.data.content[0].text.includes('预算已耗尽'), false)
    // The original event is untouched (the caller replaces it by appending).
    assert.equal(plan.event.data.content[0].text, STOP_TEXT)
    assert.equal(Object.isFrozen(plan.data), true)
  }
})

test('planGuardStopShadows ignores ordinary user messages, tool results and missing surfaces', () => {
  const events = [
    plainUserEvent(0, 'user-1'),
    toolResultEvent(1),
    guardStopEvent(2, 'vision-router-structured-guard-stop-9'),
  ]
  assert.deepEqual(planGuardStopShadows(events, [0, 1]), [])
  // A user quoting the stop text keeps their message: matching is id-only.
  const quoted = {
    seq: 3,
    type: 'user/message',
    data: { role: 'user', id: 'user-quote', content: [{ type: 'text', text: `刚才系统说了 ${STOP_TEXT} 这是什么意思？` }] },
  }
  assert.deepEqual(planGuardStopShadows([quoted], [3]), [])
  assert.deepEqual(planGuardStopShadows(undefined, [0]), [])
  assert.deepEqual(planGuardStopShadows(events, undefined), [])
})

test('planGuardStopShadows leaves image-bearing tool results to the image planner', () => {
  // Sanity: the two planners do not overlap on event types.
  const events = [
    guardStopEvent(0),
    { seq: 1, type: 'tool/result', data: { message: { role: 'user', id: 'm', content: [{ type: 'image', attachment: { attachmentId: 'sha256:x' } }] } } },
  ]
  const nodes = [0, 1]
  const guardPlans = planGuardStopShadows(events, nodes)
  const imagePlans = planToolResultImageShadows(events, nodes, () => true)
  assert.equal(guardPlans.length, 1)
  assert.equal(guardPlans[0].seq, 0)
  assert.equal(imagePlans.length, 1)
  assert.equal(imagePlans[0].seq, 1)
  assert.equal(blocksHaveImage(events[1].data.message.content), true)
})
