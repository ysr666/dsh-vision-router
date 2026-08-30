import test from 'node:test'
import assert from 'node:assert/strict'

import { rewriteHistoryImages } from '../index.js'
import { installLegacyCoreVisionPolicyBridge } from '../lib/legacy-core-vision-policy-bridge.js'
import { contextWithNativeImageCoexistence } from '../lib/native-image-coexistence.js'

function textSession() {
  return {
    requestHeader() {
      return { config: { provider: 'deepseek-official', model: 'text-model' } }
    },
  }
}

function imageMessage() {
  return {
    role: 'user',
    content: [
      { type: 'image', attachment: { attachmentId: 'sha256:reject', name: 'shot.png' } },
    ],
  }
}

test('legacy boot projection tolerates frozen config without mutating its source', () => {
  const frozen = Object.freeze({
    tool: false,
    rewriteImages: true,
    instantDescribe: true,
    autoActivateOnImage: true,
  })
  const bridge = installLegacyCoreVisionPolicyBridge(
    {},
    frozen,
    { rewriteHistoryImages },
  )

  assert.equal(bridge.config.tool, true)
  assert.equal(frozen.tool, false)
  assert.equal(Object.keys(bridge.config).includes('tool'), true)
  assert.equal({ ...bridge.config }.tool, true)

  bridge.finishSchemaBootstrap()
  assert.equal(bridge.config.tool, false)
  assert.equal(frozen.tool, false)
})

test('text-only image policy preserves reject decisions by exact identity', async () => {
  const handlers = new Map()
  const config = {
    tool: true,
    rewriteImages: true,
    routing: false,
    wrapperRoute: 'deepseek-vision',
    chainRoute: 'vision-chain',
  }
  const ctx = {
    llm: {
      async resolveModelInfo(provider, model) {
        return { provider, id: model, inputModalities: ['text'] }
      },
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
  }

  const native = contextWithNativeImageCoexistence(ctx, config)
  const bridge = installLegacyCoreVisionPolicyBridge(
    native.ctx,
    native.config,
    { rewriteHistoryImages },
  )
  const rejected = Object.freeze({ kind: 'reject', reason: 'host rejected the turn' })
  bridge.ctx.on('agent/pre-step', async () => rejected)

  const messages = [imageMessage()]
  const result = await handlers.get('agent/pre-step')(
    { agent: { session: textSession() }, messages },
    async () => ({ kind: 'continue', messages }),
  )

  assert.equal(result, rejected)
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'messages'), false)
})
