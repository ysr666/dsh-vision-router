import test from 'node:test'
import assert from 'node:assert/strict'

import {
  IMAGE_OWNERSHIP,
  classifySessionImageOwnership,
  contextWithNativeImageCoexistence,
  currentSessionImageOwnership,
  currentSessionVisionPolicy,
  resolveSessionVisionPolicy,
} from '../lib/native-image-coexistence.js'
import { installLocalVisionStabilizer } from '../lib/local-vision-stabilizer.js'

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
  return {
    ctx,
    handlers,
    persisted,
    registeredTools,
    setCatalogThrows(value) {
      catalogThrows = value
    },
    setInputModalities(value) {
      modalities = value
    },
  }
}

async function runPreStep(harness, provider, messages, callback) {
  const wrapped = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  wrapped.ctx.on('agent/pre-step', async (payload) => {
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

test('a globally registered wrapper no longer suppresses rewriting for an unrelated text-only session', async () => {
  const harness = boot({ inputModalities: ['text'] })
  harness.ctx.llm.registerAdapter(['deepseek-vision'], { stream() {} })
  const wrapped = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
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

test('explicit Vision Router registrations retain image blocks for their adapter boundary', async () => {
  const harness = boot({ inputModalities: ['text'] })
  const wrapped = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  const dispose = wrapped.ctx.llm.registerAdapter(['deepseek-vision'], { stream() {} })
  wrapped.ctx.on('agent/pre-step', async (payload) => {
    assert.equal(currentSessionImageOwnership(), IMAGE_OWNERSHIP.VISION_ROUTER)
    assert.equal(currentSessionVisionPolicy()?.preserveRawImages, true)
    return { kind: 'continue', messages: payload.messages }
  })

  const input = [imageMessage('sha256:owned')]
  const result = await harness.handlers.get('agent/pre-step')(
    { agent: { session: session('deepseek-vision') }, messages: input },
    async () => ({ kind: 'continue', messages: input }),
  )
  assert.equal(result.messages[0].content[0].content[0].type, 'image')

  dispose()
  const afterDispose = await harness.handlers.get('agent/pre-step')(
    { agent: { session: session('deepseek-vision') }, messages: input },
    async () => ({ kind: 'continue', messages: input }),
  )
  assert.equal(
    afterDispose.messages[0].content[0].content[0].type,
    'text',
    'disposing the plugin registration also releases ownership of that route',
  )
})

test('registration handle replace moves ownership without losing the DSH handle contract', async () => {
  const harness = boot({ inputModalities: ['text'] })
  const wrapped = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  const adapter = { stream() {} }
  const handle = wrapped.ctx.llm.registerAdapter(['owned-a'], adapter)
  assert.equal(typeof handle, 'function')
  assert.equal(typeof handle.replace, 'function')

  assert.equal(
    await resolveSessionVisionPolicy(harness.ctx, session('owned-a'), harness.persisted, {
      state: undefined,
    }).then((policy) => policy.ownership),
    IMAGE_OWNERSHIP.TEXT_ONLY,
    'direct helper calls do not inherit private-context ownership state',
  )

  let observed
  wrapped.ctx.on('agent/pre-step', async (payload) => {
    observed = currentSessionImageOwnership()
    return { kind: 'continue', messages: payload.messages }
  })
  const input = [imageMessage('sha256:replace')]
  await harness.handlers.get('agent/pre-step')(
    { agent: { session: session('owned-a') }, messages: input },
    async () => ({ kind: 'continue', messages: input }),
  )
  assert.equal(observed, IMAGE_OWNERSHIP.VISION_ROUTER)

  handle.replace(['owned-b'])
  const oldRoute = await harness.handlers.get('agent/pre-step')(
    { agent: { session: session('owned-a') }, messages: input },
    async () => ({ kind: 'continue', messages: input }),
  )
  assert.equal(observed, IMAGE_OWNERSHIP.TEXT_ONLY)
  assert.equal(oldRoute.messages[0].content[0].content[0].type, 'text')

  const newRoute = await harness.handlers.get('agent/pre-step')(
    { agent: { session: session('owned-b') }, messages: input },
    async () => ({ kind: 'continue', messages: input }),
  )
  assert.equal(observed, IMAGE_OWNERSHIP.VISION_ROUTER)
  assert.equal(newRoute.messages[0].content[0].content[0].type, 'image')
})

test('foreign replacement of the same provider invalidates plugin ownership by adapter identity', async () => {
  const harness = boot({ inputModalities: ['text'] })
  const wrapped = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  wrapped.ctx.llm.registerAdapter(['shared-provider'], { stream() {} })
  harness.ctx.llm.registerAdapter(['shared-provider'], { stream() {} })

  wrapped.ctx.on('agent/pre-step', async (payload) => {
    assert.equal(currentSessionImageOwnership(), IMAGE_OWNERSHIP.TEXT_ONLY)
    return { kind: 'continue', messages: payload.messages }
  })
  const input = [imageMessage('sha256:foreign-replace')]
  const result = await harness.handlers.get('agent/pre-step')(
    { agent: { session: session('shared-provider') }, messages: input },
    async () => ({ kind: 'continue', messages: input }),
  )
  assert.equal(result.messages[0].content[0].content[0].type, 'text')
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

  wrapped.ctx.on('agent/pre-step', async (payload) => {
    assert.notEqual(currentSessionImageOwnership(), IMAGE_OWNERSHIP.VISION_ROUTER)
    return { kind: 'continue', messages: payload.messages }
  })
  const input = [imageMessage('sha256:failed-register')]
  const result = await harness.handlers.get('agent/pre-step')(
    { agent: { session: session('failed-provider') }, messages: input },
    async () => ({ kind: 'continue', messages: input }),
  )
  assert.equal(result.messages[0].content[0].content[0].type, 'text')
})

test('third-party providers ending in -vision are classified by model metadata, not their name', async () => {
  const nativeHarness = boot({ inputModalities: ['text', 'image'] })
  nativeHarness.ctx.llm.registerAdapter(['thirdparty-vision'], { stream() {} })
  const nativeWrapped = contextWithNativeImageCoexistence(nativeHarness.ctx, nativeHarness.persisted)
  nativeWrapped.ctx.on('agent/pre-step', async (payload) => {
    assert.equal(currentSessionImageOwnership(), IMAGE_OWNERSHIP.NATIVE)
    return { kind: 'continue', messages: payload.messages }
  })
  const nativeInput = [imageMessage('sha256:thirdparty-native')]
  const nativeResult = await nativeHarness.handlers.get('agent/pre-step')(
    { agent: { session: session('thirdparty-vision') }, messages: nativeInput },
    async () => ({ kind: 'continue', messages: nativeInput }),
  )
  assert.equal(nativeResult.messages[0].content[0].content[0].type, 'image')

  const textHarness = boot({ inputModalities: ['text'] })
  textHarness.ctx.llm.registerAdapter(['thirdparty-vision'], { stream() {} })
  const textWrapped = contextWithNativeImageCoexistence(textHarness.ctx, textHarness.persisted)
  textWrapped.ctx.on('agent/pre-step', async (payload) => ({ kind: 'continue', messages: payload.messages }))
  const textInput = [imageMessage('sha256:thirdparty-text')]
  const textResult = await textHarness.handlers.get('agent/pre-step')(
    { agent: { session: session('thirdparty-vision') }, messages: textInput },
    async () => ({ kind: 'continue', messages: textInput }),
  )
  assert.equal(textResult.messages[0].content[0].content[0].type, 'text')
})

test('route classification falls back to live agent options and then the same-session route cache', async () => {
  const harness = boot({ inputModalities: ['text', 'image'] })
  const wrapped = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  wrapped.ctx.on('agent/pre-step', async (payload) => {
    assert.equal(currentSessionImageOwnership(), IMAGE_OWNERSHIP.NATIVE)
    return { kind: 'continue', messages: payload.messages }
  })
  const input = [imageMessage('sha256:agent-fallback')]
  let headerAvailable = false
  const restoringSession = {
    requestHeader() {
      if (!headerAvailable) throw new Error('restoring')
      return { config: { provider: 'native-pi', model: 'native-vision' } }
    },
  }
  const handler = harness.handlers.get('agent/pre-step')
  await handler(
    {
      agent: {
        session: restoringSession,
        options: { provider: 'native-pi', model: 'native-vision' },
      },
      messages: input,
    },
    async () => ({ kind: 'continue', messages: input }),
  )

  // The second restored step has neither a readable header nor agent route;
  // only the route previously confirmed for this exact session object remains.
  await handler(
    { agent: { session: restoringSession }, messages: input },
    async () => ({ kind: 'continue', messages: input }),
  )
  headerAvailable = true
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

test('catalog failure is conservative unless a capability was cached for the same live adapter', async () => {
  const unknown = boot({ resolveThrows: true })
  const unknownResult = await runPreStep(
    unknown,
    'mystery-provider',
    [imageMessage('sha256:unknown')],
  )
  assert.equal(
    unknownResult.result.messages[0].content[0].content[0].type,
    'text',
    'without positive native-image evidence an unknown route must fail back to the safe text bridge',
  )

  const cached = boot({ inputModalities: ['text', 'image'] })
  cached.ctx.llm.registerAdapter(['cached-native'], { stream() {} })
  const wrapped = contextWithNativeImageCoexistence(cached.ctx, cached.persisted)
  wrapped.ctx.on('agent/pre-step', async (payload) => ({ kind: 'continue', messages: payload.messages }))
  const input = [imageMessage('sha256:cached-native')]
  const handler = cached.handlers.get('agent/pre-step')
  const first = await handler(
    { agent: { session: session('cached-native') }, messages: input },
    async () => ({ kind: 'continue', messages: input }),
  )
  assert.equal(first.messages[0].content[0].content[0].type, 'image')

  cached.setCatalogThrows(true)
  const second = await handler(
    { agent: { session: session('cached-native') }, messages: input },
    async () => ({ kind: 'continue', messages: input }),
  )
  assert.equal(
    second.messages[0].content[0].content[0].type,
    'image',
    'the capability cache remains trusted only because the registered adapter identity is unchanged',
  )

  cached.ctx.llm.registerAdapter(['cached-native'], { stream() {} })
  const afterReplacement = await handler(
    { agent: { session: session('cached-native') }, messages: input },
    async () => ({ kind: 'continue', messages: input }),
  )
  assert.equal(
    afterReplacement.messages[0].content[0].content[0].type,
    'text',
    'a new adapter identity cannot inherit the previous adapter capability cache',
  )
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

function screenshotHarness(initial) {
  let settings = { ...initial }
  let watcher
  const tools = new Map()
  const scope = {
    get() {
      return settings
    },
    watch(callback) {
      watcher = callback
      return () => {
        if (watcher === callback) watcher = undefined
      }
    },
  }
  const settingsCtx = {
    settings: {
      register() {
        return scope
      },
    },
    effect() {},
  }
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {
          if (tools.get(definition.name) === definition) tools.delete(definition.name)
        }
      },
    },
    llm: {
      registerAdapter() {
        return () => {}
      },
    },
    get() {
      return undefined
    },
    on() {
      return () => {}
    },
    inject(dependencies, callback) {
      if (Array.isArray(dependencies) && dependencies.includes('settings')) callback(settingsCtx)
    },
    effect(effect) {
      return effect()
    },
  }
  return {
    ctx,
    tools,
    setSettings(next) {
      settings = { ...next }
      watcher?.(settings)
    },
  }
}

function localCoreStub() {
  return {
    localProvidersOf() {
      return []
    },
    async downscaleImage(bytes) {
      return bytes
    },
    toOpenAIContent() {
      return []
    },
    async callLocalBackend() {
      return ''
    },
    classifyVisionFailure() {
      return { kind: 'other' }
    },
    VISION_FAILURE_KINDS: { AUTH: 'auth', RATE_LIMIT: 'rate-limit', TIMEOUT: 'timeout' },
  }
}

test('desktop screenshot follows both desktopScreenshot and the global live tool gate', async () => {
  const harness = screenshotHarness({ tool: false, desktopScreenshot: false })
  const { ctx } = installLocalVisionStabilizer(
    harness.ctx,
    { tool: false, desktopScreenshot: false },
    localCoreStub(),
  )

  ctx.inject(['settings'], (child) => {
    const scope = child.settings.register('vision-router', {}, { base: {} })
    scope.watch(() => {})
  })

  let calls = 0
  ctx.tools.register({
    name: 'vision_screenshot',
    async execute() {
      calls += 1
      return 'shot'
    },
  })
  assert.equal(harness.tools.has('vision_screenshot'), false)

  harness.setSettings({ tool: false, desktopScreenshot: true })
  assert.equal(
    harness.tools.has('vision_screenshot'),
    false,
    'desktop opt-in cannot bypass the global tool=false gate',
  )

  harness.setSettings({ tool: true, desktopScreenshot: true })
  assert.equal(harness.tools.has('vision_screenshot'), true)
  const mounted = harness.tools.get('vision_screenshot')
  assert.equal(await mounted.execute({}, {}), 'shot')
  assert.equal(calls, 1)

  harness.setSettings({ tool: false, desktopScreenshot: true })
  assert.equal(harness.tools.has('vision_screenshot'), false)
  await assert.rejects(
    () => mounted.execute({}, {}),
    /vision tools are disabled/,
    'a stale captured definition must also fail closed after tool=false',
  )
  assert.equal(calls, 1)
})
