import test from 'node:test'
import assert from 'node:assert/strict'

import { installLegacyCoreVisionPolicyBridge } from '../lib/legacy-core-vision-policy-bridge.js'
import { contextWithNativeImageCoexistence } from '../lib/native-image-coexistence.js'

function imageMessage(id) {
  return {
    role: 'user',
    id: 'user-image',
    content: [{
      type: 'image',
      attachment: {
        attachmentId: id,
        mediaType: 'image/png',
        bytes: 16,
        width: 4,
        height: 4,
        name: 'shot.png',
      },
    }],
    source: { kind: 'user' },
  }
}

function session(provider, model = 'model') {
  return {
    id: 'session-1',
    requestHeader() {
      return { config: { provider, model } }
    },
  }
}

function harness({ inputModalities = ['text'] } = {}) {
  const handlers = new Map()
  const adapters = new Map()
  const config = {
    tool: true,
    rewriteImages: true,
    instantDescribe: true,
    routing: false,
    wrapperRoute: 'deepseek-vision',
    chainRoute: 'vision-chain',
  }
  const scope = {
    get() { return config },
    watch() { return () => {} },
  }
  const settings = {
    get(namespace) { return namespace === 'vision-router' ? config : undefined },
    register() { return scope },
  }
  const llm = {
    registerAdapter(routes, adapter) {
      const active = Array.isArray(routes) ? [...routes] : [routes]
      for (const route of active) adapters.set(route, adapter)
      const dispose = () => {
        for (const route of active) {
          if (adapters.get(route) === adapter) adapters.delete(route)
        }
      }
      dispose.replace = (nextRoutes) => {
        for (const route of active) {
          if (adapters.get(route) === adapter) adapters.delete(route)
        }
        active.splice(0, active.length, ...(Array.isArray(nextRoutes) ? nextRoutes : [nextRoutes]))
        for (const route of active) adapters.set(route, adapter)
      }
      return dispose
    },
    registration(provider) {
      const adapter = adapters.get(provider)
      if (!adapter) throw new Error(`no adapter: ${provider}`)
      return { adapter }
    },
    async resolveModelInfo(provider, model) {
      return { provider, id: model, inputModalities }
    },
  }
  const ctx = {
    llm,
    get(name) { return name === 'settings' ? settings : undefined },
    inject(_dependencies, callback) { return callback({ settings }) },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
  }
  return { ctx, handlers, adapters, config }
}

function installPreStep(h, native) {
  const bridge = installLegacyCoreVisionPolicyBridge(native.ctx, native.config, {
    rewriteHistoryImages(messages) {
      return { messages, attachments: [] }
    },
  })
  bridge.ctx.on('agent/pre-step', async (_payload, next) => next())
  return bridge
}

test('issue #284 Vision Router-owned image route tells the model the exact durable attachment id', async () => {
  const h = harness({ inputModalities: ['text'] })
  const native = contextWithNativeImageCoexistence(h.ctx, h.config)
  native.ctx.llm.registerAdapter(['opencode-go-vision'], { stream() {} })
  installPreStep(h, native)

  const realId = 'sha256:9d8162f938616b3e49050c132b70d8e6ef1f61d05c20c33d01a96cde81d6404a'
  const messages = [imageMessage(realId)]
  const result = await h.handlers.get('agent/pre-step')(
    {
      agent: { session: session('opencode-go-vision', 'qwen3.6-plus') },
      messages,
      turn: 7,
      step: 1,
    },
    async () => ({ kind: 'continue', messages }),
  )

  assert.equal(result.messages.length, 2)
  assert.equal(result.messages[0].content[0].type, 'image', 'raw pixels must stay available')
  const hint = result.messages[1]
  assert.equal(hint.id, 'vision-router-attachment-refs-7-1')
  assert.equal(hint.source.plugin, 'dsh-vision-router')
  assert.equal(hint.content[0].text.includes(realId), true)
  assert.match(hint.content[0].text, /use only these exact ids/i)
  assert.match(hint.content[0].text, /Never guess or invent/i)
})

test('issue #284 ordinary Host-native image routes do not receive Vision Router attachment hints', async () => {
  const h = harness({ inputModalities: ['text', 'image'] })
  h.ctx.llm.registerAdapter(['native-image'], { stream() {} })
  const native = contextWithNativeImageCoexistence(h.ctx, h.config)
  installPreStep(h, native)

  const messages = [imageMessage('sha256:native-real-id')]
  const result = await h.handlers.get('agent/pre-step')(
    {
      agent: { session: session('native-image', 'native-model') },
      messages,
      turn: 3,
      step: 1,
    },
    async () => ({ kind: 'continue', messages }),
  )

  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0], messages[0])
})

test('issue #284 attachment hint collects nested image refs without fabricating ids', async () => {
  const h = harness({ inputModalities: ['text'] })
  const native = contextWithNativeImageCoexistence(h.ctx, h.config)
  native.ctx.llm.registerAdapter(['owned-vision'], { stream() {} })
  installPreStep(h, native)

  const first = 'sha256:first-real-id'
  const second = 'sha256:second-real-id'
  const messages = [{
    role: 'user',
    id: 'nested-images',
    source: { kind: 'user' },
    content: [{
      type: 'tool-result',
      content: [
        imageMessage(first).content[0],
        { type: 'text', text: 'between' },
        imageMessage(second).content[0],
      ],
    }],
  }]
  const result = await h.handlers.get('agent/pre-step')(
    {
      agent: { session: session('owned-vision') },
      messages,
      turn: 4,
      step: 2,
    },
    async () => ({ kind: 'continue', messages }),
  )

  const text = result.messages.at(-1).content[0].text
  assert.equal(text.includes(first), true)
  assert.equal(text.includes(second), true)
  assert.equal(text.includes('7f8e9d0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d'), false)
})
