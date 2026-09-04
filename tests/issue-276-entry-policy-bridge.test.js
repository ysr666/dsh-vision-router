import test from 'node:test'
import assert from 'node:assert/strict'

import { currentCoreVisionSurface } from '../lib/core-vision-surface.js'
import { installLegacyCoreVisionPolicyBridge } from '../lib/legacy-core-vision-policy-bridge.js'
import {
  IMAGE_OWNERSHIP,
  contextWithNativeImageCoexistence,
  currentSessionVisionPolicy,
} from '../lib/native-image-coexistence.js'
import { currentSessionVisionModeAuthority } from '../lib/session-vision-mode-authority.js'
import { installLocalVisionStabilizer } from '../lib/local-vision-stabilizer.js'
import { installVisionToolRuntimeBoundary } from '../lib/vision-tool-runtime-boundary.js'

function session(provider, model = 'model', modelSelectionState) {
  return {
    modelSelectionState,
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
  const restrictions = new WeakMap()
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
  const visibleDefinitions = (agent) => {
    let defs = [...tools.values()]
    if (agent) {
      const filters = restrictions.get(agent) ?? []
      for (const filter of filters) {
        if (Array.isArray(filter.allow)) {
          const allow = new Set(filter.allow)
          defs = defs.filter((def) => allow.has(def.name))
        }
        if (Array.isArray(filter.deny)) {
          const deny = new Set(filter.deny)
          defs = defs.filter((def) => !deny.has(def.name))
        }
      }
    }
    return defs
  }
  const toolService = {
    register(definition) {
      tools.set(definition.name, definition)
      return () => {
        if (tools.get(definition.name) === definition) tools.delete(definition.name)
      }
    },
    schemas(agent) {
      return visibleDefinitions(agent).map((definition) => ({ name: definition.name }))
    },
  }
  const sessionProjections = {
    stateOf(value, key) {
      assert.equal(key, 'modelSelection')
      return value?.modelSelectionState ?? { lastUsed: null, pending: null }
    },
  }
  const ctx = {
    llm,
    tools: toolService,
    sessionProjections,
    get(name) {
      if (name === 'settings') return settings
      if (name === 'sessionProjections') return sessionProjections
      return undefined
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
  const makeAgent = (sessionValue) => {
    const agent = { session: sessionValue }
    agent.ctx = {
      tools: {
        restrict(filter) {
          const current = restrictions.get(agent) ?? []
          const record = {
            ...(Array.isArray(filter?.allow) ? { allow: [...filter.allow] } : {}),
            ...(Array.isArray(filter?.deny) ? { deny: [...filter.deny] } : {}),
          }
          current.push(record)
          restrictions.set(agent, current)
          let active = true
          return () => {
            if (!active) return
            active = false
            const next = (restrictions.get(agent) ?? []).filter((entry) => entry !== record)
            if (next.length === 0) restrictions.delete(agent)
            else restrictions.set(agent, next)
          }
        },
        schemas() {
          return toolService.schemas(agent)
        },
      },
    }
    return agent
  }
  return {
    ctx,
    handlers,
    adapters,
    tools,
    persisted,
    makeAgent,
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
  const bridge = installLegacyCoreVisionPolicyBridge(native.ctx, native.config)
  return { native, bridge }
}

async function runCoreLikePreStep(harness, bridge, provider, messages, observe, options = {}) {
  bridge.ctx.on('agent/pre-step', async (payload) => {
    observe?.(payload)
    return { kind: 'continue', messages: payload.messages }
  })
  const handler = harness.handlers.get('agent/pre-step')
  assert.ok(handler)
  const sessionValue = options.session ?? session(provider, options.model ?? 'model', options.modelSelectionState)
  const agent = options.agent ?? harness.makeAgent(sessionValue)
  return handler(
    { turn: options.turn ?? 1, agent, messages },
    async () => ({ kind: 'continue', messages }),
  )
}

test('text-only session preserves the durable image even when a global wrapper exists', async () => {
  const harness = bridgeHarness({ inputModalities: ['text'] })
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
      const surface = currentCoreVisionSurface(harness.persisted)
      assert.equal(policy.ownership, IMAGE_OWNERSHIP.TEXT_ONLY)
      assert.equal(currentSessionVisionModeAuthority()?.enabled, false)
      // The legacy policy producer may still expose rewriteCurrentImages, but
      // the Core-facing surface permanently denies that destructive grant.
      assert.equal(surface.preserveRawImages, true)
      assert.equal(surface.rewriteCurrentImages, false)
      assert.equal(surface.rewriteEnabled, false)
      assert.equal(surface.toolAvailable, false)
      assert.equal(bridge.config, harness.persisted)
      assert.equal(bridge.config.rewriteImages, true)
    },
  )

  assert.equal(result.messages, messages)
  assert.equal(result.messages[0].content[0].content[0].type, 'image')
  assert.equal(
    result.messages[0].content[0].content[0].attachment.attachmentId,
    'sha256:text-route',
  )
})

test('text-only pre-step never substitutes cached descriptions into the durable user message', async () => {
  const harness = bridgeHarness({ inputModalities: ['text'] })
  harness.ctx.llm.registerAdapter(['deepseek-vision'], { stream() {} })
  const { bridge } = composeBridge(harness)
  const messages = [imageMessage('sha256:cached')]

  const result = await runCoreLikePreStep(
    harness,
    bridge,
    'deepseek-official',
    messages,
  )

  assert.equal(result.messages, messages)
  assert.equal(result.messages[0].content[0].content[0].type, 'image')
  assert.equal(result.messages[0].content[0].content[0].attachment.attachmentId, 'sha256:cached')
})

test('Vision Router-owned adapter keeps raw image blocks and grants the Router surface', async () => {
  const harness = bridgeHarness({ inputModalities: ['text'] })
  const { native, bridge } = composeBridge(harness)
  native.ctx.llm.registerAdapter(['owned-route'], { stream() {} })
  const messages = [imageMessage('sha256:owned')]

  const result = await runCoreLikePreStep(harness, bridge, 'owned-route', messages, () => {
    const policy = currentSessionVisionPolicy()
    const surface = currentCoreVisionSurface(harness.persisted)
    assert.equal(policy.ownership, IMAGE_OWNERSHIP.VISION_ROUTER)
    assert.equal(currentSessionVisionModeAuthority()?.enabled, true)
    assert.equal(policy.preserveRawImages, true)
    assert.equal(surface.preserveRawImages, true)
    assert.equal(surface.rewriteEnabled, false)
    assert.equal(surface.toolAvailable, true)
    assert.equal(bridge.config, harness.persisted)
    assert.equal(bridge.config.rewriteImages, true)
  })

  assert.equal(result.messages, messages)
  assert.equal(result.messages[0].content[0].content[0].type, 'image')
})

test('native session preserves pixels while the ordinary route keeps Vision Router off', async () => {
  const harness = bridgeHarness({
    inputModalities: ['text', 'image'],
    config: { structuredVisionBootstrap: true },
  })
  const { bridge } = composeBridge(harness)
  const messages = [imageMessage('sha256:native')]

  const result = await runCoreLikePreStep(harness, bridge, 'deepseek-official', messages, () => {
    const policy = currentSessionVisionPolicy()
    const surface = currentCoreVisionSurface(harness.persisted)
    assert.equal(policy.ownership, IMAGE_OWNERSHIP.NATIVE)
    assert.equal(currentSessionVisionModeAuthority()?.enabled, false)
    assert.equal(policy.preserveRawImages, true)
    assert.equal(surface.preserveRawImages, true)
    assert.equal(surface.rewriteEnabled, false)
    assert.equal(surface.instantDescribe, false)
    assert.equal(surface.autoActivateOnImage, false)
    assert.equal(surface.structuredBootstrap, false)
    assert.equal(surface.toolAvailable, false)
    assert.equal(bridge.config, harness.persisted)
    assert.equal(bridge.config.rewriteImages, true)
    assert.equal(bridge.config.instantDescribe, true)
    assert.equal(bridge.config.autoActivateOnImage, true)
    assert.equal(bridge.config.structuredVisionBootstrap, true)
    assert.equal(bridge.config.tool, true)
  })

  assert.equal(result.messages, messages)
  assert.equal(result.messages[0].content[0].content[0].type, 'image')
})

test('UNKNOWN capability preserves pixels but cannot invent Vision Router mode', async () => {
  const harness = bridgeHarness({ resolveThrows: true })
  const { bridge } = composeBridge(harness)
  const messages = [imageMessage('sha256:cold-resume')]

  const result = await runCoreLikePreStep(harness, bridge, 'native-pi', messages, () => {
    const policy = currentSessionVisionPolicy()
    const surface = currentCoreVisionSurface(harness.persisted)
    assert.equal(policy.ownership, IMAGE_OWNERSHIP.UNKNOWN)
    assert.equal(currentSessionVisionModeAuthority()?.enabled, false)
    assert.equal(policy.preserveRawImages, true)
    assert.equal(surface.preserveRawImages, true)
    assert.equal(surface.rewriteEnabled, false)
    assert.equal(surface.toolAvailable, false)
    assert.equal(bridge.config, harness.persisted)
    assert.equal(bridge.config.rewriteImages, true)
  })

  assert.equal(result.messages, messages)
  assert.equal(result.messages[0].content[0].content[0].type, 'image')
})

test('pending OFF selection beats a stale wrapper request header and hides/guards vision tools', async () => {
  const harness = bridgeHarness({
    inputModalities: ['text'],
    config: { structuredVisionBootstrap: true },
  })
  const { native, bridge } = composeBridge(harness)
  native.ctx.llm.registerAdapter(['deepseek-vision'], { stream() {} })

  let calls = 0
  bridge.ctx.tools.register({
    name: 'vision_describe',
    async execute() {
      calls += 1
      return 'seen'
    },
  })
  bridge.ctx.tools.register({ name: 'bash', async execute() { return 'ok' } })

  const selected = {
    lastUsed: { provider: 'deepseek-vision', model: 'model' },
    pending: { provider: 'deepseek-official', model: 'model' },
  }
  const staleWrapperSession = session('deepseek-vision', 'model', selected)
  const agent = harness.makeAgent(staleWrapperSession)
  let observed

  await runCoreLikePreStep(
    harness,
    bridge,
    'deepseek-vision',
    [],
    () => {
      const surface = currentCoreVisionSurface(harness.persisted)
      observed = {
        authority: currentSessionVisionModeAuthority(),
        toolAvailable: surface.toolAvailable,
        structuredBootstrap: surface.structuredBootstrap,
      }
    },
    { session: staleWrapperSession, agent },
  )

  assert.equal(observed.authority.enabled, false)
  assert.deepEqual(observed.authority.route, { provider: 'deepseek-official', model: 'model' })
  assert.equal(observed.toolAvailable, false)
  assert.equal(observed.structuredBootstrap, false)
  assert.deepEqual(agent.ctx.tools.schemas().map((schema) => schema.name), ['bash'])

  const registered = harness.tools.get('vision_describe')
  await assert.rejects(
    () => registered.execute({}, { agent }),
    (error) => error?.code === 'VISION_MODE_DISABLED',
  )
  assert.equal(calls, 0)
})

test('pending ON selection beats stale source history, restores scoped tools, and snapshots one whole step', async () => {
  const harness = bridgeHarness({
    inputModalities: ['text', 'image'],
    config: { structuredVisionBootstrap: true },
  })
  const { native, bridge } = composeBridge(harness)
  native.ctx.llm.registerAdapter(['deepseek-vision'], { stream() {} })

  let calls = 0
  bridge.ctx.tools.register({
    name: 'vision_describe',
    async execute() {
      calls += 1
      return 'seen'
    },
  })
  bridge.ctx.tools.register({ name: 'bash', async execute() { return 'ok' } })

  const selectionState = {
    lastUsed: { provider: 'deepseek-official', model: 'model' },
    pending: { provider: 'deepseek-vision', model: 'model' },
  }
  const staleSourceSession = session('deepseek-official', 'model', selectionState)
  const agent = harness.makeAgent(staleSourceSession)

  await runCoreLikePreStep(
    harness,
    bridge,
    'deepseek-official',
    [],
    () => {
      const surface = currentCoreVisionSurface(harness.persisted)
      assert.equal(currentSessionVisionModeAuthority()?.enabled, true)
      assert.equal(surface.toolAvailable, true)
      assert.equal(surface.structuredBootstrap, true)
    },
    { session: staleSourceSession, agent, turn: 1 },
  )

  assert.deepEqual(
    agent.ctx.tools.schemas().map((schema) => schema.name).sort(),
    ['bash', 'vision_describe'],
  )

  // A model switch during the already-assembled step belongs to the next step.
  // The current tool call must use the captured ON snapshot rather than tearing
  // the prompt/tool surface in half.
  selectionState.pending = { provider: 'deepseek-official', model: 'model' }
  const registered = harness.tools.get('vision_describe')
  assert.equal(await registered.execute({}, { agent }), 'seen')
  assert.equal(calls, 1)

  await runCoreLikePreStep(
    harness,
    bridge,
    'deepseek-official',
    [],
    () => {
      assert.equal(currentSessionVisionModeAuthority()?.enabled, false)
      assert.equal(currentCoreVisionSurface(harness.persisted).toolAvailable, false)
    },
    { session: staleSourceSession, agent, turn: 2 },
  )
  assert.deepEqual(agent.ctx.tools.schemas().map((schema) => schema.name), ['bash'])
  await assert.rejects(
    () => registered.execute({}, { agent }),
    (error) => error?.code === 'VISION_MODE_DISABLED',
  )
  assert.equal(calls, 1)
})

test('tool=false stays real through the authority bridge while execution follows live settings', async () => {
  const harness = bridgeHarness({ config: { tool: false } })
  const { bridge } = composeBridge(harness, { toolRuntime: true })

  let liveScope
  bridge.ctx.inject(['settings'], (child) => {
    liveScope = child.settings.register('vision-router')
  })
  assert.equal(bridge.config, harness.persisted)
  assert.equal(bridge.config.tool, false)
  assert.equal(liveScope.get(), harness.persisted)
  assert.equal(liveScope.get().tool, false)
  assert.equal(Object.hasOwn(bridge, 'finishSchemaBootstrap'), false)

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
