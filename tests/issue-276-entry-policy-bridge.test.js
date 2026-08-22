import test from 'node:test'
import assert from 'node:assert/strict'

import { rewriteHistoryImages } from '../index.js'
import { installLegacyCoreVisionPolicyBridge } from '../lib/legacy-core-vision-policy-bridge.js'
import {
  IMAGE_OWNERSHIP,
  contextWithNativeImageCoexistence,
  currentSessionVisionPolicy,
} from '../lib/native-image-coexistence.js'
import { installLocalVisionStabilizer } from '../lib/local-vision-stabilizer.js'
import { createSessionVisionStateStore } from '../lib/session-vision-state.js'
import { installVisionToolRuntimeBoundary } from '../lib/vision-tool-runtime-boundary.js'

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

function bridgeHarness({ inputModalities = ['text'], resolveThrows = false, config = {} } = {}) {
  const handlers = new Map()
  const adapters = new Map()
  const tools = new Map()
  let catalogThrows = resolveThrows
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
        for (const route of list) {
          if (adapters.get(route) === adapter) adapters.delete(route)
        }
      }
    },
    registration(provider) {
      const adapter = adapters.get(provider)
      if (!adapter) throw new Error(`no adapter: ${provider}`)
      return { adapter }
    },
    async resolveModelInfo(provider, model) {
      if (catalogThrows) throw new Error('catalog unavailable')
      return { provider, id: model, inputModalities }
    },
  }
  const ctx = {
    llm,
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {
          if (tools.get(definition.name) === definition) tools.delete(definition.name)
        }
      },
    },
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
    effect() {},
  }
  return {
    ctx,
    handlers,
    adapters,
    tools,
    persisted,
    setCatalogThrows(value) {
      catalogThrows = value
    },
  }
}

function composeBridge(harness, options = {}) {
  const runtimeCtx = options.toolRuntime === true
    ? installVisionToolRuntimeBoundary(harness.ctx, harness.persisted)
    : harness.ctx
  const native = contextWithNativeImageCoexistence(runtimeCtx, harness.persisted)
  const bridge = installLegacyCoreVisionPolicyBridge(
    native.ctx,
    native.config,
    { rewriteHistoryImages },
  )
  return { native, bridge }
}

async function runCoreLikePreStep(harness, bridge, provider, messages, observe) {
  bridge.ctx.on('agent/pre-step', async (payload) => {
    observe?.(payload)
    return { kind: 'continue', messages: payload.messages }
  })
  const handler = harness.handlers.get('agent/pre-step')
  assert.ok(handler)
  return handler(
    { agent: { session: session(provider) }, messages },
    async () => ({ kind: 'continue', messages }),
  )
}

test('text-only session uses the canonical core writer even when a global wrapper exists', async () => {
  const harness = bridgeHarness({ inputModalities: ['text'] })
  // This registration is intentionally outside Vision Router's private context:
  // it reproduces the old global wrapperRegistered condition without granting
  // ownership of the currently selected Host route.
  harness.ctx.llm.registerAdapter(['deepseek-vision'], { stream() {} })
  const { bridge } = composeBridge(harness)
  const messages = [imageMessage('sha256:text-route')]

  const result = await runCoreLikePreStep(
    harness,
    bridge,
    'deepseek-official',
    messages,
    () => {
      const policy = currentSessionVisionPolicy()
      assert.equal(policy.ownership, IMAGE_OWNERSHIP.TEXT_ONLY)
      assert.equal(policy.rewriteCurrentImages, true)
      assert.equal(bridge.config.rewriteImages, true)
    },
  )

  assert.deepEqual(result.messages[0].content[0].content, [
    {
      type: 'text',
      text: '[attached image: sha256:text-route] The current model cannot see images. To examine it, call vision_describe with attachmentIds: ["sha256:text-route"] and a specific question.',
    },
  ])
})

test('text-only fallback reuses the exact core session memory instead of degrading cached descriptions', async () => {
  const harness = bridgeHarness({ inputModalities: ['text'] })
  harness.ctx.llm.registerAdapter(['deepseek-vision'], { stream() {} })
  const { bridge } = composeBridge(harness)
  const selectedSession = session('deepseek-official')
  const messages = [imageMessage('sha256:cached')]
  const visionState = createSessionVisionStateStore()

  bridge.ctx.on('agent/pre-step', async (payload) => {
    const memory = visionState.memoryForSession(payload.agent.session)
    memory.set('sha256:cached', '缓存里的电路图描述')
    return { kind: 'continue', messages: payload.messages }
  })

  const handler = harness.handlers.get('agent/pre-step')
  assert.ok(handler)
  const result = await handler(
    { agent: { session: selectedSession }, messages },
    async () => ({ kind: 'continue', messages }),
  )

  const text = result.messages[0].content[0].content[0].text
  assert.match(text, /此前由视觉模型读取/)
  assert.match(text, /缓存里的电路图描述/)
  assert.doesNotMatch(text, /call vision_describe/)
})

test('Vision Router-owned adapter keeps raw image blocks at the adapter boundary', async () => {
  const harness = bridgeHarness({ inputModalities: ['text'] })
  const { native, bridge } = composeBridge(harness)
  native.ctx.llm.registerAdapter(['owned-route'], { stream() {} })
  const messages = [imageMessage('sha256:owned')]

  const result = await runCoreLikePreStep(harness, bridge, 'owned-route', messages, () => {
    const policy = currentSessionVisionPolicy()
    assert.equal(policy.ownership, IMAGE_OWNERSHIP.VISION_ROUTER)
    assert.equal(policy.preserveRawImages, true)
    assert.equal(bridge.config.rewriteImages, false)
  })

  assert.equal(result.messages[0].content[0].content[0].type, 'image')
})

test('native session preserves pixels, suppresses generic auto-mount, and keeps explicit 1+x', async () => {
  const harness = bridgeHarness({
    inputModalities: ['text', 'image'],
    config: { structuredVisionBootstrap: true },
  })
  const { bridge } = composeBridge(harness)
  const messages = [imageMessage('sha256:native')]

  const result = await runCoreLikePreStep(harness, bridge, 'deepseek-official', messages, () => {
    const policy = currentSessionVisionPolicy()
    assert.equal(policy.ownership, IMAGE_OWNERSHIP.NATIVE)
    assert.equal(bridge.config.rewriteImages, false)
    assert.equal(bridge.config.instantDescribe, false)
    assert.equal(bridge.config.autoActivateOnImage, false)
    assert.equal(bridge.config.structuredVisionBootstrap, true)
  })

  assert.equal(result.messages[0].content[0].content[0].type, 'image')
})

test('UNKNOWN capability preserves the existing Host image contract instead of forcing a text bridge', async () => {
  const harness = bridgeHarness({ resolveThrows: true })
  const { bridge } = composeBridge(harness)
  const messages = [imageMessage('sha256:cold-resume')]

  const result = await runCoreLikePreStep(harness, bridge, 'native-pi', messages, () => {
    const policy = currentSessionVisionPolicy()
    assert.equal(policy.ownership, IMAGE_OWNERSHIP.UNKNOWN)
    assert.equal(policy.preserveRawImages, true)
    assert.equal(bridge.config.rewriteImages, false)
  })

  assert.equal(result.messages[0].content[0].content[0].type, 'image')
})

test('tool=false is projected only while legacy core builds schema; execution follows the live setting', async () => {
  const harness = bridgeHarness({ config: { tool: false } })
  const { bridge } = composeBridge(harness, { toolRuntime: true })

  let projectedScope
  bridge.ctx.inject(['settings'], (child) => {
    projectedScope = child.settings.register('vision-router')
  })
  assert.equal(bridge.config.tool, true)
  assert.equal(projectedScope.get().tool, true)

  let calls = 0
  bridge.ctx.tools.register({
    name: 'vision_describe',
    async execute() {
      calls += 1
      return 'ok'
    },
  })
  const registered = harness.tools.get('vision_describe')
  assert.ok(registered)

  bridge.finishSchemaBootstrap()
  assert.equal(bridge.config.tool, false)
  assert.equal(projectedScope.get().tool, false)
  await assert.rejects(() => registered.execute({}, {}), /vision tools are disabled/)
  assert.equal(calls, 0)

  harness.persisted.tool = true
  assert.equal(await registered.execute({}, {}), 'ok')
  assert.equal(calls, 1)
  assert.equal(harness.tools.get('vision_describe'), registered, 'tool schema must not churn on enable')

  harness.persisted.tool = false
  await assert.rejects(() => registered.execute({}, {}), /vision tools are disabled/)
  assert.equal(calls, 1)
  assert.equal(harness.tools.get('vision_describe'), registered, 'tool schema must not churn on disable')
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

test('desktopScreenshot owns screenshot schema while the global tool toggle only gates execution', async () => {
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
  const mounted = harness.tools.get('vision_screenshot')
  assert.ok(mounted, 'desktop opt-in mounts the schema even while global tools are disabled')
  await assert.rejects(() => mounted.execute({}, {}), /vision tools are disabled/)
  assert.equal(calls, 0)

  harness.setSettings({ tool: true, desktopScreenshot: true })
  assert.equal(harness.tools.get('vision_screenshot'), mounted, 'enabling tools must not remount schema')
  assert.equal(await mounted.execute({}, {}), 'shot')
  assert.equal(calls, 1)

  harness.setSettings({ tool: false, desktopScreenshot: true })
  assert.equal(harness.tools.get('vision_screenshot'), mounted, 'disabling tools must not unmount schema')
  await assert.rejects(() => mounted.execute({}, {}), /vision tools are disabled/)
  assert.equal(calls, 1)

  harness.setSettings({ tool: false, desktopScreenshot: false })
  assert.equal(harness.tools.has('vision_screenshot'), false, 'desktop opt-out removes the screenshot schema')
})
