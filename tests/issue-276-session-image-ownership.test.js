import test from 'node:test'
import assert from 'node:assert/strict'

import {
  IMAGE_OWNERSHIP,
  classifySessionImageOwnership,
  contextWithNativeImageCoexistence,
  currentSessionImageOwnership,
} from '../lib/native-image-coexistence.js'

function session(provider, model = 'model') {
  return {
    requestHeader() {
      return { config: { provider, model } }
    },
  }
}

function imageMessage(id = 'sha256:test') {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        content: [
          { type: 'image', attachment: { attachmentId: id, name: 'shot.png' } },
        ],
      },
    ],
  }
}

function boot({
  inputModalities = ['text'],
  resolveThrows = false,
  config = {},
} = {}) {
  const handlers = new Map()
  const adapters = new Map()
  const registeredTools = []
  const persisted = {
    tool: true,
    rewriteImages: true,
    instantDescribe: true,
    routing: false,
    autoActivateOnImage: true,
    structuredVisionBootstrap: false,
    wrapperRoute: 'deepseek-vision',
    chainRoute: 'vision-chain',
    ...config,
  }
  const scope = {
    get() {
      return persisted
    },
    watch() {
      return () => {}
    },
  }
  const settings = {
    get(namespace) {
      return namespace === 'vision-router' ? persisted : undefined
    },
    register(namespace) {
      assert.equal(namespace, 'vision-router')
      return scope
    },
  }
  const llm = {
    registerAdapter(routes, adapter) {
      const list = Array.isArray(routes) ? routes : [routes]
      for (const route of list) adapters.set(route, adapter)
      return () => {
        for (const route of list) adapters.delete(route)
      }
    },
    registration(provider) {
      const adapter = adapters.get(provider)
      if (!adapter) throw new Error(`no adapter: ${provider}`)
      return { adapter }
    },
    async resolveModelInfo(provider, model) {
      if (resolveThrows) throw new Error('catalog unavailable')
      return { provider, id: model, inputModalities }
    },
  }
  const tools = {
    register(definition) {
      registeredTools.push(definition)
      return () => {}
    },
  }
  const ctx = {
    llm,
    tools,
    get(name) {
      return name === 'settings' ? settings : undefined
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    inject(_dependencies, callback) {
      return callback({ settings })
    },
  }
  return { ctx, handlers, persisted, registeredTools }
}

async function runPreStep(harness, provider, messages, callback) {
  const wrapped = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  wrapped.ctx.on('agent/pre-step', async (payload, next) => {
    if (callback) await callback(wrapped, payload)
    return { kind: 'continue', messages: payload.messages }
  })
  const handler = harness.handlers.get('agent/pre-step')
  assert.ok(handler)
  const result = await handler(
    { agent: { session: session(provider) }, messages },
    async () => ({ kind: 'continue', messages }),
  )
  return { wrapped, result }
}

test('classifies exact Host model capabilities and fails unknown metadata safe', async () => {
  const text = boot({ inputModalities: ['text'] })
  assert.equal(
    await classifySessionImageOwnership(text.ctx, session('deepseek-official'), text.persisted),
    IMAGE_OWNERSHIP.TEXT_ONLY,
  )

  const native = boot({ inputModalities: ['text', 'image'] })
  assert.equal(
    await classifySessionImageOwnership(native.ctx, session('deepseek-official'), native.persisted),
    IMAGE_OWNERSHIP.NATIVE,
  )

  const unknown = boot({ resolveThrows: true })
  assert.equal(
    await classifySessionImageOwnership(unknown.ctx, session('deepseek-official'), unknown.persisted),
    IMAGE_OWNERSHIP.UNKNOWN,
  )
})

test('a globally registered Vision Router wrapper no longer suppresses rewriting for an unrelated text-only session', async () => {
  const harness = boot({ inputModalities: ['text'] })
  const wrapped = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  wrapped.ctx.llm.registerAdapter(['deepseek-vision'], { stream() {} })
  wrapped.ctx.on('agent/pre-step', async (payload) => ({ kind: 'continue', messages: payload.messages }))

  const input = [imageMessage('sha256:text-route')]
  const result = await harness.handlers.get('agent/pre-step')(
    { agent: { session: session('deepseek-official') }, messages: input },
    async () => ({ kind: 'continue', messages: input }),
  )

  assert.equal(result.messages[0].content[0].type, 'tool_result')
  assert.deepEqual(result.messages[0].content[0].content, [
    {
      type: 'text',
      text: '[attached image: sha256:text-route] The current model cannot see images. To examine it, call vision_describe with attachmentIds: ["sha256:text-route"] and a specific question.',
    },
  ])
})

test('Vision Router-owned routes retain their image blocks for the adapter boundary', async () => {
  const harness = boot({ inputModalities: ['text'] })
  const wrapped = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  wrapped.ctx.llm.registerAdapter(['custom-owned-route'], { stream() {} })
  wrapped.ctx.on('agent/pre-step', async (payload) => {
    assert.equal(currentSessionImageOwnership(), IMAGE_OWNERSHIP.VISION_ROUTER)
    return { kind: 'continue', messages: payload.messages }
  })

  const input = [imageMessage('sha256:owned')]
  const result = await harness.handlers.get('agent/pre-step')(
    { agent: { session: session('custom-owned-route') }, messages: input },
    async () => ({ kind: 'continue', messages: input }),
  )
  assert.equal(result.messages[0].content[0].content[0].type, 'image')
})

test('native image turns preserve pixels and suppress only generic auto-mount policy', async () => {
  const harness = boot({
    inputModalities: ['text', 'image'],
    config: { structuredVisionBootstrap: true },
  })
  const wrapped = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  wrapped.ctx.on('agent/pre-step', async (payload) => {
    assert.equal(currentSessionImageOwnership(), IMAGE_OWNERSHIP.NATIVE)
    assert.equal(wrapped.config.rewriteImages, false)
    assert.equal(wrapped.config.instantDescribe, false)
    assert.equal(wrapped.config.autoActivateOnImage, false)
    assert.equal(
      wrapped.config.structuredVisionBootstrap,
      true,
      'explicit structured 1+x remains authoritative on a native visual model',
    )
    return { kind: 'continue', messages: payload.messages }
  })

  const input = [imageMessage('sha256:native')]
  const result = await harness.handlers.get('agent/pre-step')(
    { agent: { session: session('deepseek-official') }, messages: input },
    async () => ({ kind: 'continue', messages: input }),
  )
  assert.equal(result.messages[0].content[0].content[0].type, 'image')
})

test('unknown model metadata is bridged like text-only instead of leaking raw pixels', async () => {
  const harness = boot({ resolveThrows: true })
  const { result } = await runPreStep(harness, 'mystery-provider', [imageMessage('sha256:unknown')])
  assert.equal(result.messages[0].content[0].content[0].type, 'text')
  assert.match(result.messages[0].content[0].content[0].text, /sha256:unknown/)
})

test('tool=false at startup still builds a stable tool schema, while execution follows the live toggle', async () => {
  const harness = boot({ config: { tool: false } })
  const wrapped = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)

  assert.equal(
    wrapped.config.tool,
    true,
    'boot projection keeps tool definitions constructible even when the live toggle is off',
  )

  let calls = 0
  wrapped.ctx.tools.register({
    name: 'vision_describe',
    async execute() {
      calls += 1
      return 'ok'
    },
  })
  assert.equal(harness.registeredTools.length, 1)
  await assert.rejects(
    () => harness.registeredTools[0].execute({}, {}),
    /vision tools are disabled/,
  )
  assert.equal(calls, 0)

  harness.persisted.tool = true
  assert.equal(await harness.registeredTools[0].execute({}, {}), 'ok')
  assert.equal(calls, 1)

  // The first real turn ends the boot projection. From here on core policy
  // reads the actual setting without rebuilding/unregistering the schema.
  harness.persisted.tool = false
  wrapped.ctx.on('agent/pre-step', async (payload) => ({ kind: 'continue', messages: payload.messages }))
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
  await harness.handlers.get('agent/pre-step')(
    { agent: { session: session('deepseek-official') }, messages },
    async () => ({ kind: 'continue', messages }),
  )
  assert.equal(wrapped.config.tool, false)
  await assert.rejects(
    () => harness.registeredTools[0].execute({}, {}),
    /vision tools are disabled/,
  )
})
