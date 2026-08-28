import test from 'node:test'
import assert from 'node:assert/strict'

import { createSessionVisionIndex } from '../lib/session-vision-index.js'
import { createSessionVisionStateStore } from '../lib/session-vision-state.js'

function coreStub() {
  return {
    collectEventAttachmentRefs() { return [] },
    rewriteImageBlocks(messages) { return { messages, attachments: [] } },
    planToolResultImageShadows(events, seqs, shouldStrip) {
      return (seqs ?? []).flatMap((seq) => {
        const event = events?.[seq]
        if (!event || event.type !== 'tool/result' || shouldStrip(seq, event) !== true) return []
        return [{ seq, event, message: { ...event.data.message, sanitized: true } }]
      })
    },
    planGuardStopShadows() { return [] },
  }
}

function session() {
  return {
    id: 'direct-core-image-route',
    events: [{
      type: 'tool/result',
      data: { message: { content: [{ type: 'image', attachment: { attachmentId: 'a' } }] } },
    }],
    surface: { nodes: [0] },
    appended: [],
    async append(type, data, options) {
      this.appended.push({ type, data, options })
    },
  }
}

test('direct-core fallback may preserve tool-result images through an explicit route classifier', async () => {
  const value = session()
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    routeHandlesImages: async () => true,
  })

  assert.equal(await index.repairToolResultSurface(value), 0)
  assert.equal(value.appended.length, 0)
})

test('direct-core fallback fails safe and sanitizes when the route classifier rejects images', async () => {
  const value = session()
  const index = createSessionVisionIndex({
    stateStore: createSessionVisionStateStore(),
    core: coreStub(),
    routeHandlesImages: async () => false,
  })

  assert.equal(await index.repairToolResultSurface(value), 1)
  assert.equal(value.appended.length, 1)
  assert.equal(value.appended[0].type, 'tool/result')
  assert.equal(value.appended[0].data.message.sanitized, true)
})
