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

test('pre-step compatibility keeps frozen config exact instead of projecting internal policy', () => {
  const frozen = Object.freeze({
    tool: false,
    rewriteImages: true,
    instantDescribe: true,
    autoActivateOnImage: true,
  })
  const settings = { marker: 'real-settings' }
  const child = { settings }
  const ctx = {
    get(name) {
      return name === 'settings' ? settings : undefined
    },
    inject(_dependencies, callback) {
      return callback(child)
    },
    on() {
      return () => {}
    },
  }
  const bridge = installLegacyCoreVisionPolicyBridge(
    ctx,
    frozen,
    { rewriteHistoryImages },
  )

  assert.equal(bridge.config, frozen)
  assert.equal(bridge.config.tool, false)
  assert.equal(bridge.ctx.get('settings'), settings)
  let injected
  bridge.ctx.inject(['settings'], (value) => { injected = value })
  assert.equal(injected, child)
  assert.equal(Object.hasOwn(bridge, 'finishSchemaBootstrap'), false)
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
