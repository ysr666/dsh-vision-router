import test from 'node:test'
import assert from 'node:assert/strict'

import { currentSessionSurfacePolicy } from '../lib/session-surface-policy.js'
import {
  currentSessionVisionModeAuthority,
  effectiveSessionModelSelection,
  resolveSessionVisionModeAuthority,
} from '../lib/session-vision-mode-authority.js'
import { installSessionVisionModeBoundary } from '../lib/session-vision-mode-boundary.js'

const OWNER = Symbol.for('dsh-vision-router.adapter-owner')

function harness() {
  const handlers = new Map()
  const adapters = new Map()
  const tools = new Map()
  const restrictions = new WeakMap()
  const settingsValue = {
    tool: true,
    rewriteImages: true,
    instantDescribe: true,
    autoActivateOnImage: true,
    structuredVisionBootstrap: true,
    wrapperRoute: 'deepseek-vision',
    chainRoute: 'vision-chain',
  }

  const visibleDefinitions = (agent) => {
    let definitions = [...tools.values()]
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
    registration(route) {
      const adapter = adapters.get(route)
      return adapter === undefined ? undefined : { adapter }
    },
  }

  const sessionProjections = {
    stateOf(session, key) {
      assert.equal(key, 'modelSelection')
      return session?.selectionState ?? { lastUsed: null, pending: null }
    },
  }

  const settings = {
    get(namespace) {
      return namespace === 'vision-router' ? settingsValue : undefined
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
  }

  function makeAgent({ header, selectionState }) {
    const session = {
      selectionState,
      requestHeader() {
        return header === undefined ? undefined : { config: header }
      },
    }
    const agent = { session }
    agent.ctx = {
      tools: {
        restrict(filter) {
          const entry = {
            ...(Array.isArray(filter?.allow) ? { allow: [...filter.allow] } : {}),
            ...(Array.isArray(filter?.deny) ? { deny: [...filter.deny] } : {}),
          }
          const entries = restrictions.get(agent) ?? []
          entries.push(entry)
          restrictions.set(agent, entries)
          let active = true
          return () => {
            if (!active) return
            active = false
            const next = (restrictions.get(agent) ?? []).filter((value) => value !== entry)
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

  const boundary = installSessionVisionModeBoundary(ctx, settingsValue)
  return {
    boundary,
    ctx,
    handlers,
    adapters,
    tools,
    settingsValue,
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

async function preStep(harness, agent, turn, observe) {
  harness.boundary.ctx.on('agent/pre-step', async (payload, next) => {
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

test('effective selection uses pending composer choice before stale request history', () => {
  const h = harness()
  const agent = h.makeAgent({
    header: { provider: 'deepseek-vision', model: 'm' },
    selectionState: {
      lastUsed: { provider: 'deepseek-vision', model: 'm' },
      pending: { provider: 'deepseek-official', model: 'm' },
    },
  })

  assert.deepEqual(effectiveSessionModelSelection(h.ctx, agent), {
    provider: 'deepseek-official',
    model: 'm',
  })
})

test('pending OFF beats a stale wrapper header, hides Router tools, and fails closed on execution', async () => {
  const h = harness()
  h.registerOrdinary('deepseek-official')
  h.registerOwned('deepseek-vision')

  let calls = 0
  h.boundary.ctx.tools.register({
    name: 'vision_describe',
    async execute() {
      calls += 1
      return 'seen'
    },
  })
  h.boundary.ctx.tools.register({ name: 'bash', async execute() { return 'ok' } })

  const agent = h.makeAgent({
    header: { provider: 'deepseek-vision', model: 'm' },
    selectionState: {
      lastUsed: { provider: 'deepseek-vision', model: 'm' },
      pending: { provider: 'deepseek-official', model: 'm' },
    },
  })
  let snapshot
  await preStep(h, agent, 1, () => {
    snapshot = currentSessionVisionModeAuthority()
    const surface = currentSessionSurfacePolicy(h.settingsValue)
    assert.equal(surface.visionModeEnabled, false)
    assert.equal(surface.surface.visionTools, false)
    assert.equal(surface.surface.structuredBootstrap, false)
    assert.equal(surface.surface.genericAutoMount, false)
    assert.equal(surface.surface.instantDescribe, false)
  })

  assert.equal(snapshot.enabled, false)
  assert.deepEqual(snapshot.route, { provider: 'deepseek-official', model: 'm' })
  assert.deepEqual(agent.ctx.tools.schemas().map((schema) => schema.name), ['bash'])
  await assert.rejects(
    () => h.tools.get('vision_describe').execute({}, { agent }),
    (error) => error?.code === 'VISION_MODE_DISABLED',
  )
  assert.equal(calls, 0)
})

test('pending ON beats stale ordinary history and one assembled step stays internally consistent', async () => {
  const h = harness()
  h.registerOrdinary('deepseek-official')
  h.registerOwned('deepseek-vision')

  let calls = 0
  h.boundary.ctx.tools.register({
    name: 'vision_describe',
    async execute() {
      calls += 1
      return 'seen'
    },
  })
  h.boundary.ctx.tools.register({ name: 'bash', async execute() { return 'ok' } })

  const selectionState = {
    lastUsed: { provider: 'deepseek-official', model: 'm' },
    pending: { provider: 'deepseek-vision', model: 'm' },
  }
  const agent = h.makeAgent({
    header: { provider: 'deepseek-official', model: 'm' },
    selectionState,
  })

  await preStep(h, agent, 1, () => {
    assert.equal(currentSessionVisionModeAuthority()?.enabled, true)
    const surface = currentSessionSurfacePolicy(h.settingsValue)
    assert.equal(surface.surface.visionTools, true)
    assert.equal(surface.surface.structuredBootstrap, true)
  })
  assert.deepEqual(
    agent.ctx.tools.schemas().map((schema) => schema.name).sort(),
    ['bash', 'vision_describe'],
  )

  // The user switches OFF while the already-assembled step is still executing.
  // The current tool call must retain the captured ON authority.
  selectionState.pending = { provider: 'deepseek-official', model: 'm' }
  assert.equal(await h.tools.get('vision_describe').execute({}, { agent }), 'seen')
  assert.equal(calls, 1)

  await preStep(h, agent, 2, () => {
    assert.equal(currentSessionVisionModeAuthority()?.enabled, false)
  })
  assert.deepEqual(agent.ctx.tools.schemas().map((schema) => schema.name), ['bash'])
  await assert.rejects(
    () => h.tools.get('vision_describe').execute({}, { agent }),
    (error) => error?.code === 'VISION_MODE_DISABLED',
  )
  assert.equal(calls, 1)
})

test('ON and OFF Sessions remain isolated although tool definitions are global', async () => {
  const h = harness()
  h.registerOrdinary('deepseek-official')
  h.registerOwned('deepseek-vision')
  h.boundary.ctx.tools.register({ name: 'vision_ocr', async execute() { return 'ocr' } })
  h.boundary.ctx.tools.register({ name: 'bash', async execute() { return 'ok' } })

  const onAgent = h.makeAgent({
    header: { provider: 'deepseek-vision', model: 'm' },
    selectionState: { lastUsed: { provider: 'deepseek-vision', model: 'm' }, pending: null },
  })
  const offAgent = h.makeAgent({
    header: { provider: 'deepseek-official', model: 'm' },
    selectionState: { lastUsed: { provider: 'deepseek-official', model: 'm' }, pending: null },
  })

  await preStep(h, offAgent, 1)
  await preStep(h, onAgent, 1)
  assert.deepEqual(offAgent.ctx.tools.schemas().map((schema) => schema.name), ['bash'])
  assert.deepEqual(
    onAgent.ctx.tools.schemas().map((schema) => schema.name).sort(),
    ['bash', 'vision_ocr'],
  )
  await assert.rejects(
    () => h.tools.get('vision_ocr').execute({}, { agent: offAgent }),
    (error) => error?.code === 'VISION_MODE_DISABLED',
  )
  assert.equal(await h.tools.get('vision_ocr').execute({}, { agent: onAgent }), 'ocr')
})

test('a foreign adapter occupying the configured wrapper route cannot manufacture Vision authority', () => {
  const h = harness()
  h.registerOrdinary('deepseek-vision')
  const agent = h.makeAgent({
    header: { provider: 'deepseek-vision', model: 'm' },
    selectionState: {
      lastUsed: { provider: 'deepseek-vision', model: 'm' },
      pending: null,
    },
  })

  const authority = resolveSessionVisionModeAuthority(h.ctx, agent, h.settingsValue)
  assert.equal(authority.enabled, false)
  assert.equal(authority.reason, 'ordinary-route')
})

test('unknown route fails closed while no-Agent internal execution keeps historical semantics', async () => {
  const h = harness()
  const agent = h.makeAgent({
    header: undefined,
    selectionState: { lastUsed: null, pending: null },
  })
  const authority = resolveSessionVisionModeAuthority(h.ctx, agent, h.settingsValue)
  assert.equal(authority.enabled, false)
  assert.equal(authority.reason, 'unknown-route')

  h.boundary.ctx.tools.register({ name: 'vision_trace', async execute() { return 'trace' } })
  assert.equal(await h.tools.get('vision_trace').execute({}, {}), 'trace')
})
