import test from 'node:test'
import assert from 'node:assert/strict'

import {
  IMAGE_OWNERSHIP,
  VISION_ROUTER_ADAPTER_OWNER,
  classifySessionImageOwnership,
  contextWithNativeImageCoexistence,
  currentSessionImageOwnership,
  currentSessionVisionPolicy,
  markVisionRouterAdapter,
  resolveSessionVisionPolicy,
  visionRouterAdapterOwner,
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

function boot({ inputModalities = ['text'], resolveThrows = false, config = {} } = {}) {
  const handlers = new Map()
  const adapters = new Map()
  let catalogThrows = resolveThrows
  let modalities = inputModalities
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
      let activeRoutes = Array.isArray(routes) ? [...routes] : [routes]
      for (const route of activeRoutes) adapters.set(route, adapter)
      const dispose = () => {
        for (const route of activeRoutes) {
          if (adapters.get(route) === adapter) adapters.delete(route)
        }
        activeRoutes = []
      }
      dispose.replace = (nextRoutes) => {
        const next = Array.isArray(nextRoutes) ? [...nextRoutes] : [nextRoutes]
        for (const route of activeRoutes) {
          if (!next.includes(route) && adapters.get(route) === adapter) adapters.delete(route)
        }
        activeRoutes = next
        for (const route of activeRoutes) adapters.set(route, adapter)
      }
      return dispose
    },
    registration(provider) {
      const adapter = adapters.get(provider)
      if (!adapter) throw new Error(`no adapter: ${provider}`)
      return { adapter }
    },
    async resolveModelInfo(provider, model) {
      if (catalogThrows) throw new Error('catalog unavailable')
      return { provider, id: model, inputModalities: modalities }
    },
  }
  const ctx = {
    llm,
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
  return {
    ctx,
    handlers,
    persisted,
    adapters,
    setCatalogThrows(value) {
      catalogThrows = value
    },
    setInputModalities(value) {
      modalities = value
    },
  }
}

async function observeTurn(harness, provider, options = {}) {
  const wrapped = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  let observed
  wrapped.ctx.on('agent/pre-step', async (payload) => {
    observed = {
      ownership: currentSessionImageOwnership(),
      policy: currentSessionVisionPolicy(),
    }
    return { kind: 'continue', messages: payload.messages }
  })
  const messages = options.messages ?? [imageMessage()]
  const agent = {
    session: options.session ?? session(provider, options.model ?? 'model'),
    ...(options.agent ?? {}),
  }
  const result = await harness.handlers.get('agent/pre-step')(
    { agent, messages },
    async () => ({ kind: 'continue', messages }),
  )
  return { wrapped, observed, result }
}

test('classifies exact Host model capabilities without guessing on metadata failure', async () => {
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

test('direct helper compatibility recognizes only explicit plugin routes, not arbitrary -vision names', async () => {
  const text = boot({ inputModalities: ['text'] })
  assert.equal(
    await resolveSessionVisionPolicy(text.ctx, session('deepseek-vision'), text.persisted)
      .then((policy) => policy.ownership),
    IMAGE_OWNERSHIP.VISION_ROUTER,
  )
  assert.equal(
    await resolveSessionVisionPolicy(text.ctx, session('thirdparty-vision'), text.persisted)
      .then((policy) => policy.ownership),
    IMAGE_OWNERSHIP.TEXT_ONLY,
  )
})

test('ownership token survives frozen adapters without mutating the original', () => {
  const adapter = Object.freeze({ stream() {} })
  const token = Object.freeze({ route: 'owned' })
  const marked = markVisionRouterAdapter(adapter, token)
  assert.notEqual(marked, adapter)
  assert.equal(visionRouterAdapterOwner(marked), token)
  assert.equal(adapter[VISION_ROUTER_ADAPTER_OWNER], undefined)
  assert.equal(typeof marked.stream, 'function')
})

test('private registration marks Vision Router ownership and disposal releases it', async () => {
  const harness = boot({ inputModalities: ['text'] })
  const wrapped = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  const dispose = wrapped.ctx.llm.registerAdapter(['deepseek-vision'], { stream() {} })

  let observed
  wrapped.ctx.on('agent/pre-step', async (payload) => {
    observed = currentSessionVisionPolicy()
    return { kind: 'continue', messages: payload.messages }
  })
  const messages = [imageMessage('sha256:owned')]
  await harness.handlers.get('agent/pre-step')(
    { agent: { session: session('deepseek-vision') }, messages },
    async () => ({ kind: 'continue', messages }),
  )
  assert.equal(observed.ownership, IMAGE_OWNERSHIP.VISION_ROUTER)
  assert.equal(observed.preserveRawImages, true)

  dispose()
  await harness.handlers.get('agent/pre-step')(
    { agent: { session: session('deepseek-vision') }, messages },
    async () => ({ kind: 'continue', messages }),
  )
  assert.equal(observed.ownership, IMAGE_OWNERSHIP.TEXT_ONLY)
  assert.equal(observed.rewriteCurrentImages, true)
})

test('registration handle replace moves ownership without losing the DSH handle contract', async () => {
  const harness = boot({ inputModalities: ['text'] })
  const wrapped = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  const handle = wrapped.ctx.llm.registerAdapter(['owned-a'], { stream() {} })
  assert.equal(typeof handle, 'function')
  assert.equal(typeof handle.replace, 'function')

  let observed
  wrapped.ctx.on('agent/pre-step', async (payload) => {
    observed = currentSessionImageOwnership()
    return { kind: 'continue', messages: payload.messages }
  })
  const messages = [imageMessage('sha256:replace')]
  await harness.handlers.get('agent/pre-step')(
    { agent: { session: session('owned-a') }, messages },
    async () => ({ kind: 'continue', messages }),
  )
  assert.equal(observed, IMAGE_OWNERSHIP.VISION_ROUTER)

  handle.replace(['owned-b'])
  await harness.handlers.get('agent/pre-step')(
    { agent: { session: session('owned-a') }, messages },
    async () => ({ kind: 'continue', messages }),
  )
  assert.equal(observed, IMAGE_OWNERSHIP.TEXT_ONLY)

  await harness.handlers.get('agent/pre-step')(
    { agent: { session: session('owned-b') }, messages },
    async () => ({ kind: 'continue', messages }),
  )
  assert.equal(observed, IMAGE_OWNERSHIP.VISION_ROUTER)
})

test('foreign replacement of the same provider invalidates plugin ownership by token identity', async () => {
  const harness = boot({ inputModalities: ['text'] })
  const wrapped = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  wrapped.ctx.llm.registerAdapter(['shared-provider'], { stream() {} })
  harness.ctx.llm.registerAdapter(['shared-provider'], { stream() {} })

  const { observed } = await observeTurn(harness, 'shared-provider')
  assert.equal(observed.ownership, IMAGE_OWNERSHIP.TEXT_ONLY)
})

test('failed adapter registration cannot leave stale plugin ownership', async () => {
  const harness = boot({ inputModalities: ['text'] })
  const originalRegister = harness.ctx.llm.registerAdapter
  harness.ctx.llm.registerAdapter = () => {
    throw new Error('duplicate provider')
  }
  const wrapped = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  assert.throws(
    () => wrapped.ctx.llm.registerAdapter(['failed-provider'], { stream() {} }),
    /duplicate provider/,
  )
  harness.ctx.llm.registerAdapter = originalRegister

  let ownership
  wrapped.ctx.on('agent/pre-step', async (payload) => {
    ownership = currentSessionImageOwnership()
    return { kind: 'continue', messages: payload.messages }
  })
  const messages = [imageMessage('sha256:failed')]
  await harness.handlers.get('agent/pre-step')(
    { agent: { session: session('failed-provider') }, messages },
    async () => ({ kind: 'continue', messages }),
  )
  assert.notEqual(ownership, IMAGE_OWNERSHIP.VISION_ROUTER)
})

test('third-party -vision providers stay Host-owned and follow exact model metadata', async () => {
  const native = boot({ inputModalities: ['text', 'image'] })
  native.ctx.llm.registerAdapter(['thirdparty-vision'], { stream() {} })
  const nativeTurn = await observeTurn(native, 'thirdparty-vision')
  assert.equal(nativeTurn.observed.ownership, IMAGE_OWNERSHIP.NATIVE)

  const text = boot({ inputModalities: ['text'] })
  text.ctx.llm.registerAdapter(['thirdparty-vision'], { stream() {} })
  const textTurn = await observeTurn(text, 'thirdparty-vision')
  assert.equal(textTurn.observed.ownership, IMAGE_OWNERSHIP.TEXT_ONLY)
})

test('route classification falls back to live agent options and same-session route cache', async () => {
  const harness = boot({ inputModalities: ['text', 'image'] })
  const wrapped = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  const messages = [imageMessage('sha256:restore')]
  let observed
  wrapped.ctx.on('agent/pre-step', async (payload) => {
    observed = currentSessionImageOwnership()
    return { kind: 'continue', messages: payload.messages }
  })

  const restoringSession = {
    requestHeader() {
      throw new Error('restoring')
    },
  }
  const handler = harness.handlers.get('agent/pre-step')
  await handler(
    {
      agent: {
        session: restoringSession,
        options: { provider: 'native-pi', model: 'native-vision' },
      },
      messages,
    },
    async () => ({ kind: 'continue', messages }),
  )
  assert.equal(observed, IMAGE_OWNERSHIP.NATIVE)

  await handler(
    { agent: { session: restoringSession }, messages },
    async () => ({ kind: 'continue', messages }),
  )
  assert.equal(observed, IMAGE_OWNERSHIP.NATIVE)
})

test('turn policy distinguishes text, native, Vision Router and unknown ownership', async () => {
  const text = await observeTurn(boot({ inputModalities: ['text'] }), 'deepseek-official')
  assert.equal(text.observed.policy.ownership, IMAGE_OWNERSHIP.TEXT_ONLY)
  assert.equal(text.observed.policy.preserveRawImages, false)
  assert.equal(text.observed.policy.rewriteCurrentImages, true)
  assert.equal(text.observed.policy.suppressGenericAutoMount, false)

  const native = await observeTurn(boot({ inputModalities: ['text', 'image'] }), 'deepseek-official')
  assert.equal(native.observed.policy.ownership, IMAGE_OWNERSHIP.NATIVE)
  assert.equal(native.observed.policy.preserveRawImages, true)
  assert.equal(native.observed.policy.rewriteCurrentImages, false)
  assert.equal(native.observed.policy.suppressGenericAutoMount, true)
  assert.equal(native.observed.policy.allowStructuredBootstrap, true)

  const unknown = await observeTurn(boot({ resolveThrows: true }), 'mystery-provider')
  assert.equal(unknown.observed.policy.ownership, IMAGE_OWNERSHIP.UNKNOWN)
  assert.equal(unknown.observed.policy.preserveRawImages, true)
  assert.equal(unknown.observed.policy.rewriteCurrentImages, false)

  const ownedHarness = boot({ inputModalities: ['text'] })
  const ownedCtx = contextWithNativeImageCoexistence(ownedHarness.ctx, ownedHarness.persisted)
  ownedCtx.ctx.llm.registerAdapter(['owned-provider'], { stream() {} })
  let ownedPolicy
  ownedCtx.ctx.on('agent/pre-step', async (payload) => {
    ownedPolicy = currentSessionVisionPolicy()
    return { kind: 'continue', messages: payload.messages }
  })
  const messages = [imageMessage('sha256:owned-policy')]
  await ownedHarness.handlers.get('agent/pre-step')(
    { agent: { session: session('owned-provider') }, messages },
    async () => ({ kind: 'continue', messages }),
  )
  assert.equal(ownedPolicy.ownership, IMAGE_OWNERSHIP.VISION_ROUTER)
  assert.equal(ownedPolicy.preserveRawImages, true)
})

test('capability cache is scoped to the exact adapter/provider/model and never guesses after replacement', async () => {
  const harness = boot({ inputModalities: ['text', 'image'] })
  harness.ctx.llm.registerAdapter(['cached-native'], { stream() {} })
  const wrapped = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  let observed
  wrapped.ctx.on('agent/pre-step', async (payload) => {
    observed = currentSessionImageOwnership()
    return { kind: 'continue', messages: payload.messages }
  })
  const messages = [imageMessage('sha256:cached')]
  const handler = harness.handlers.get('agent/pre-step')

  await handler(
    { agent: { session: session('cached-native', 'vision-a') }, messages },
    async () => ({ kind: 'continue', messages }),
  )
  assert.equal(observed, IMAGE_OWNERSHIP.NATIVE)

  harness.setCatalogThrows(true)
  await handler(
    { agent: { session: session('cached-native', 'vision-a') }, messages },
    async () => ({ kind: 'continue', messages }),
  )
  assert.equal(observed, IMAGE_OWNERSHIP.NATIVE)

  await handler(
    { agent: { session: session('cached-native', 'vision-b') }, messages },
    async () => ({ kind: 'continue', messages }),
  )
  assert.equal(observed, IMAGE_OWNERSHIP.UNKNOWN)

  harness.ctx.llm.registerAdapter(['cached-native'], { stream() {} })
  await handler(
    { agent: { session: session('cached-native', 'vision-a') }, messages },
    async () => ({ kind: 'continue', messages }),
  )
  assert.equal(observed, IMAGE_OWNERSHIP.UNKNOWN)
})
