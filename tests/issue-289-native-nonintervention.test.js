import test from 'node:test'
import assert from 'node:assert/strict'

import { currentCoreVisionSurface } from '../lib/core-vision-surface.js'
import {
  IMAGE_OWNERSHIP,
  contextWithNativeImageCoexistence,
  currentSessionVisionPolicy,
  resolveSessionVisionPolicy,
} from '../lib/native-image-coexistence.js'
import {
  currentSessionVisionModeAuthority,
  effectiveSessionModelSelection,
  resolveSessionVisionModeAuthority,
} from '../lib/session-vision-mode-authority.js'
import { installSessionVisionModeBoundary } from '../lib/session-vision-mode-boundary.js'
import { installLegacyCoreVisionPolicyBridge } from '../lib/legacy-core-vision-policy-bridge.js'
import { installStructuredFlowHardening } from '../lib/structured-flow-hardening.js'
import { REMOTE_SETTINGS_READABLE_FIELDS } from '../lib/remote-settings-bridge.js'

const OWNER = Symbol.for('dsh-vision-router.adapter-owner')

function session(provider, model = 'model', selectionState) {
  return {
    selectionState,
    requestHeader() {
      return { config: { provider, model } }
    },
  }
}

function boot() {
  const handlers = new Map()
  const defs = new Map()
  const adapters = new Map()
  const restrictions = new WeakMap()
  const persisted = {
    tool: true,
    rewriteImages: true,
    instantDescribe: true,
    routing: false,
    autoActivateOnImage: true,
    structuredVisionBootstrap: true,
    visionTurnBudgetMs: 10_000,
    wrapperRoute: 'deepseek-vision',
    chainRoute: 'vision-chain',
  }
  const scope = {
    get() { return persisted },
    watch() { return () => {} },
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
      return {
        provider,
        id: model,
        inputModalities: provider === 'native-provider' ? ['text', 'image'] : ['text'],
      }
    },
  }

  const visibleDefinitions = (agent) => {
    let definitions = [...defs.values()]
    for (const filter of restrictions.get(agent) ?? []) {
      if (filter.allow) {
        const allow = new Set(filter.allow)
        definitions = definitions.filter((definition) => allow.has(definition.name))
      }
      if (filter.deny) {
        const deny = new Set(filter.deny)
        definitions = definitions.filter((definition) => !deny.has(definition.name))
      }
    }
    return definitions
  }
  const tools = {
    register(def) {
      defs.set(def.name, def)
      return () => defs.delete(def.name)
    },
    schemas(agent) {
      return visibleDefinitions(agent).map((definition) => ({ name: definition.name }))
    },
  }
  const sessionProjections = {
    stateOf(value, key) {
      assert.equal(key, 'modelSelection')
      return value?.selectionState ?? { lastUsed: null, pending: null }
    },
  }
  const ctx = {
    llm,
    tools,
    sessionProjections,
    get(name) {
      if (name === 'settings') return settings
      if (name === 'sessionProjections') return sessionProjections
      return undefined
    },
    inject(_dependencies, callback) {
      return callback({ settings })
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
  }

  function makeAgent(sessionValue) {
    const agent = { session: sessionValue }
    agent.ctx = {
      tools: {
        restrict(filter) {
          const record = {
            ...(Array.isArray(filter?.allow) ? { allow: [...filter.allow] } : {}),
            ...(Array.isArray(filter?.deny) ? { deny: [...filter.deny] } : {}),
          }
          const current = restrictions.get(agent) ?? []
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
          return tools.schemas(agent)
        },
      },
    }
    return agent
  }

  return {
    ctx,
    handlers,
    defs,
    adapters,
    persisted,
    makeAgent,
    registerOrdinary(route) {
      const adapter = { stream() {} }
      adapters.set(route, adapter)
      return adapter
    },
    registerOwned(route) {
      const adapter = { stream() {}, [OWNER]: { route } }
      adapters.set(route, adapter)
      return adapter
    },
  }
}

function compose(harness) {
  const native = contextWithNativeImageCoexistence(harness.ctx, harness.persisted)
  const legacy = installLegacyCoreVisionPolicyBridge(native.ctx, native.config)
  const mode = installSessionVisionModeBoundary(legacy.ctx, legacy.config)
  return { native, legacy, mode }
}

async function runPreStep(harness, mode, agent, turn = 1, observe) {
  mode.ctx.on('agent/pre-step', async (payload, next) => {
    observe?.(payload)
    return next()
  })
  const handler = harness.handlers.get('agent/pre-step')
  assert.ok(handler)
  return handler(
    { turn, agent, messages: [] },
    async () => ({ kind: 'continue', messages: [] }),
  )
}

test('Host-native image ownership remains distinct from Vision Router mode authority', async () => {
  const harness = boot()
  const native = await resolveSessionVisionPolicy(
    harness.ctx,
    session('native-provider'),
    harness.persisted,
  )
  assert.equal(native.ownership, IMAGE_OWNERSHIP.NATIVE)
  assert.equal(native.preserveRawImages, true)
  assert.equal(native.suppressGenericAutoMount, true)
  assert.equal(native.allowStructuredBootstrap, false)

  const text = await resolveSessionVisionPolicy(
    harness.ctx,
    session('text-provider'),
    harness.persisted,
  )
  assert.equal(text.ownership, IMAGE_OWNERSHIP.TEXT_ONLY)
  assert.equal(text.allowStructuredBootstrap, true)
})

test('ordinary native and text routes keep the Router surface off without mutating Settings/config', async () => {
  const harness = boot()
  const { mode } = compose(harness)
  let observed

  mode.ctx.on('agent/pre-step', async (payload, next) => {
    const surface = currentCoreVisionSurface(mode.config)
    observed = {
      ownership: currentSessionVisionPolicy()?.ownership,
      modeEnabled: currentSessionVisionModeAuthority()?.enabled,
      surfaceStructuredBootstrap: surface.structuredBootstrap,
      surfaceToolAvailable: surface.toolAvailable,
      persistedStructuredBootstrap: mode.config.structuredVisionBootstrap,
      persistedTool: mode.config.tool,
    }
    return next()
  })

  const handler = harness.handlers.get('agent/pre-step')
  assert.ok(handler)
  await handler(
    { turn: 1, agent: { session: session('native-provider') }, messages: [] },
    async () => ({ kind: 'continue', messages: [] }),
  )
  assert.deepEqual(observed, {
    ownership: IMAGE_OWNERSHIP.NATIVE,
    modeEnabled: false,
    surfaceStructuredBootstrap: false,
    surfaceToolAvailable: false,
    persistedStructuredBootstrap: true,
    persistedTool: true,
  })

  await handler(
    { turn: 2, agent: { session: session('text-provider') }, messages: [] },
    async () => ({ kind: 'continue', messages: [] }),
  )
  assert.deepEqual(observed, {
    ownership: IMAGE_OWNERSHIP.TEXT_ONLY,
    modeEnabled: false,
    surfaceStructuredBootstrap: false,
    surfaceToolAvailable: false,
    persistedStructuredBootstrap: true,
    persistedTool: true,
  })
})

test('an ordinary native model cannot call Vision Router tools while composer Vision mode is off', async () => {
  const harness = boot()
  const { mode } = compose(harness)
  const structured = installStructuredFlowHardening(mode.ctx, mode.config)
  const nativeSession = session('native-provider')
  const agent = { session: nativeSession }

  structured.tools.register({
    name: 'vision_ocr',
    async execute() {
      return 'native-requested OCR evidence'
    },
  })
  structured.on('agent/pre-step', async (_payload, next) => next())

  const handler = harness.handlers.get('agent/pre-step')
  assert.ok(handler)
  const decision = await handler(
    { turn: 1, agent, messages: [] },
    async () => ({ kind: 'continue', messages: [] }),
  )
  assert.equal(
    decision.messages.some((message) => String(message?.id).includes('structured-')),
    false,
    'ordinary native turns must not receive a Router 1+x guard while Vision mode is off',
  )

  await assert.rejects(
    () => harness.defs.get('vision_ocr').execute({}, { agent }),
    (error) => error?.code === 'VISION_MODE_DISABLED',
  )
})

test('pending composer OFF beats a stale wrapper request header', async () => {
  const harness = boot()
  harness.registerOrdinary('deepseek-official')
  harness.registerOwned('deepseek-vision')
  const { mode } = compose(harness)

  let calls = 0
  mode.ctx.tools.register({
    name: 'vision_describe',
    async execute() {
      calls += 1
      return 'seen'
    },
  })
  mode.ctx.tools.register({ name: 'bash', async execute() { return 'ok' } })

  const state = {
    lastUsed: { provider: 'deepseek-vision', model: 'm' },
    pending: { provider: 'deepseek-official', model: 'm' },
  }
  const staleWrapper = session('deepseek-vision', 'm', state)
  const agent = harness.makeAgent(staleWrapper)

  assert.deepEqual(effectiveSessionModelSelection(harness.ctx, agent), {
    provider: 'deepseek-official',
    model: 'm',
  })
  await runPreStep(harness, mode, agent, 1, () => {
    assert.equal(currentSessionVisionModeAuthority()?.enabled, false)
    assert.equal(currentCoreVisionSurface(mode.config).toolAvailable, false)
  })
  assert.deepEqual(agent.ctx.tools.schemas().map((schema) => schema.name), ['bash'])
  await assert.rejects(
    () => harness.defs.get('vision_describe').execute({}, { agent }),
    (error) => error?.code === 'VISION_MODE_DISABLED',
  )
  assert.equal(calls, 0)
})

test('pending composer ON beats stale source history and snapshots one complete step', async () => {
  const harness = boot()
  harness.registerOrdinary('deepseek-official')
  harness.registerOwned('deepseek-vision')
  const { mode } = compose(harness)

  let calls = 0
  mode.ctx.tools.register({
    name: 'vision_describe',
    async execute() {
      calls += 1
      return 'seen'
    },
  })
  mode.ctx.tools.register({ name: 'bash', async execute() { return 'ok' } })

  const state = {
    lastUsed: { provider: 'deepseek-official', model: 'm' },
    pending: { provider: 'deepseek-vision', model: 'm' },
  }
  const staleSource = session('deepseek-official', 'm', state)
  const agent = harness.makeAgent(staleSource)

  await runPreStep(harness, mode, agent, 1, () => {
    assert.equal(currentSessionVisionModeAuthority()?.enabled, true)
    assert.equal(currentCoreVisionSurface(mode.config).toolAvailable, true)
  })
  assert.deepEqual(
    agent.ctx.tools.schemas().map((schema) => schema.name).sort(),
    ['bash', 'vision_describe'],
  )

  state.pending = { provider: 'deepseek-official', model: 'm' }
  assert.equal(await harness.defs.get('vision_describe').execute({}, { agent }), 'seen')
  assert.equal(calls, 1)

  await runPreStep(harness, mode, agent, 2, () => {
    assert.equal(currentSessionVisionModeAuthority()?.enabled, false)
  })
  assert.deepEqual(agent.ctx.tools.schemas().map((schema) => schema.name), ['bash'])
  await assert.rejects(
    () => harness.defs.get('vision_describe').execute({}, { agent }),
    (error) => error?.code === 'VISION_MODE_DISABLED',
  )
  assert.equal(calls, 1)
})

test('ON and OFF Sessions stay isolated although vision definitions are global', async () => {
  const harness = boot()
  harness.registerOrdinary('deepseek-official')
  harness.registerOwned('deepseek-vision')
  const { mode } = compose(harness)
  mode.ctx.tools.register({ name: 'vision_ocr', async execute() { return 'ocr' } })
  mode.ctx.tools.register({ name: 'bash', async execute() { return 'ok' } })
  harness.ctx.tools.register({ name: 'vision_foreign', async execute() { return 'foreign' } })

  const onAgent = harness.makeAgent(session('deepseek-vision', 'm', {
    lastUsed: { provider: 'deepseek-vision', model: 'm' }, pending: null,
  }))
  const offAgent = harness.makeAgent(session('deepseek-official', 'm', {
    lastUsed: { provider: 'deepseek-official', model: 'm' }, pending: null,
  }))
  await runPreStep(harness, mode, offAgent, 1)
  await runPreStep(harness, mode, onAgent, 1)

  assert.deepEqual(
    offAgent.ctx.tools.schemas().map((schema) => schema.name).sort(),
    ['bash', 'vision_foreign'],
  )
  assert.deepEqual(
    onAgent.ctx.tools.schemas().map((schema) => schema.name).sort(),
    ['bash', 'vision_foreign', 'vision_ocr'],
  )
  await assert.rejects(
    () => harness.defs.get('vision_ocr').execute({}, { agent: offAgent }),
    (error) => error?.code === 'VISION_MODE_DISABLED',
  )
  assert.equal(await harness.defs.get('vision_foreign').execute({}, { agent: offAgent }), 'foreign')
  assert.equal(await harness.defs.get('vision_ocr').execute({}, { agent: onAgent }), 'ocr')
})

test('a foreign adapter on the configured wrapper route cannot manufacture Vision authority', () => {
  const harness = boot()
  harness.registerOrdinary('deepseek-vision')
  const agent = harness.makeAgent(session('deepseek-vision', 'm', {
    lastUsed: { provider: 'deepseek-vision', model: 'm' }, pending: null,
  }))
  const authority = resolveSessionVisionModeAuthority(harness.ctx, agent, harness.persisted)
  assert.equal(authority.enabled, false)
  assert.equal(authority.reason, 'ordinary-route')
})

test('the turn budget is available through the trusted remote settings channel', () => {
  assert.equal(REMOTE_SETTINGS_READABLE_FIELDS.includes('visionTurnBudgetMs'), true)
})
