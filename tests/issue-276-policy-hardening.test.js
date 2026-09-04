import test from 'node:test'
import assert from 'node:assert/strict'

import { rewriteHistoryImages } from '../index.js'
import { installLegacyCoreVisionPolicyBridge } from '../lib/legacy-core-vision-policy-bridge.js'
import { contextWithNativeImageCoexistence } from '../lib/native-image-coexistence.js'
import { installSessionVisionModeBoundary } from '../lib/session-vision-mode-boundary.js'
import { currentSessionVisionModeAuthority } from '../lib/session-vision-mode-authority.js'

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

test('a picker change during one step is applied before the next prompt assembly, not the current one', async () => {
  const OWNER = Symbol.for('dsh-vision-router.adapter-owner')
  const config = {
    tool: true,
    wrapperRoute: 'deepseek-vision',
    chainRoute: 'vision-chain',
  }
  const handlers = new Map()
  const variables = new Map()
  const definitions = new Map()
  const restrictions = new WeakMap()
  const adapters = new Map([
    ['deepseek-official', { stream() {} }],
    ['deepseek-vision', { stream() {}, [OWNER]: { route: 'deepseek-vision' } }],
  ])
  const settings = {
    get(namespace) {
      return namespace === 'vision-router' ? config : undefined
    },
  }
  const sessionProjections = {
    stateOf(session, key) {
      assert.equal(key, 'modelSelection')
      return session.selectionState
    },
  }

  const visibleDefinitions = (agent) => {
    let values = [...definitions.values()]
    for (const filter of restrictions.get(agent) ?? []) {
      if (Array.isArray(filter.deny)) {
        const denied = new Set(filter.deny)
        values = values.filter((definition) => !denied.has(definition.name))
      }
    }
    return values
  }
  const tools = {
    register(definition) {
      definitions.set(definition.name, definition)
      return () => definitions.delete(definition.name)
    },
    schemas(agent) {
      return visibleDefinitions(agent).map(({ name }) => ({ name }))
    },
  }
  const systemPrompt = {
    variable(name, provider) {
      variables.set(name, provider)
      return () => variables.delete(name)
    },
    async assemble(agent) {
      const context = { agent, scope: agent }
      for (const provider of variables.values()) provider(context)
      const assembly = { tools: tools.schemas(agent) }
      const handler = handlers.get('system-prompt/assemble')
      return typeof handler === 'function'
        ? handler(assembly, context, async () => assembly)
        : assembly
    },
  }
  const ctx = {
    llm: {
      registration(provider) {
        const adapter = adapters.get(provider)
        if (!adapter) throw new Error(`no adapter: ${provider}`)
        return { adapter }
      },
    },
    tools,
    systemPrompt,
    sessionProjections,
    get(name) {
      if (name === 'settings') return settings
      if (name === 'systemPrompt') return systemPrompt
      if (name === 'sessionProjections') return sessionProjections
      return undefined
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
  }

  const mode = installSessionVisionModeBoundary(ctx, config)
  let calls = 0
  mode.ctx.tools.register({
    name: 'vision_describe',
    async execute() {
      calls += 1
      return 'seen'
    },
  })
  mode.ctx.tools.register({ name: 'bash', async execute() { return 'ok' } })
  // Same prefix, different owner: the Session switch must not suppress a tool
  // that another plugin registered directly on the Host runtime.
  tools.register({ name: 'vision_foreign', async execute() { return 'foreign' } })

  const session = {
    selectionState: {
      lastUsed: { provider: 'deepseek-official', model: 'm' },
      pending: { provider: 'deepseek-vision', model: 'm' },
    },
    requestHeader() {
      return { config: { provider: 'deepseek-official', model: 'm' } }
    },
  }
  const agent = { session }
  agent.ctx = {
    tools: {
      restrict(filter) {
        const record = {
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
    },
  }

  mode.ctx.on('agent/pre-step', async (_payload, next) => next())
  const preStep = handlers.get('agent/pre-step')
  assert.ok(preStep)

  const firstAssembly = await systemPrompt.assemble(agent)
  assert.deepEqual(
    firstAssembly.tools.map((tool) => tool.name).sort(),
    ['bash', 'vision_describe', 'vision_foreign'],
  )

  // DSH snapshots model selection at prompt assembly. A concurrent picker OFF
  // after that point must not tear the already assembled step in half.
  session.selectionState.pending = { provider: 'deepseek-official', model: 'm' }
  await preStep(
    { turn: 1, agent, messages: [] },
    async () => {
      assert.equal(currentSessionVisionModeAuthority()?.enabled, true)
      return { kind: 'continue', messages: [] }
    },
  )
  assert.equal(await definitions.get('vision_describe').execute({}, { agent }), 'seen')
  assert.equal(calls, 1)

  // The final assembly gate is authoritative even on a support-window Host
  // whose Agent context has no scoped tools.restrict() API. It removes only
  // tools registered through Vision Router's boundary.
  const noRestrictSession = {
    selectionState: {
      lastUsed: { provider: 'deepseek-official', model: 'm' },
      pending: { provider: 'deepseek-official', model: 'm' },
    },
    requestHeader() {
      return { config: { provider: 'deepseek-official', model: 'm' } }
    },
  }
  const noRestrictAgent = { session: noRestrictSession, ctx: { tools: {} } }
  const fallbackAssembly = await systemPrompt.assemble(noRestrictAgent)
  assert.deepEqual(
    fallbackAssembly.tools.map((tool) => tool.name).sort(),
    ['bash', 'vision_foreign'],
  )
  assert.equal(await definitions.get('vision_foreign').execute({}, { agent: noRestrictAgent }), 'foreign')

  // The next assembly runs the private pre-tool sync again even though the
  // Agent never left running state between tool-loop steps.
  const secondAssembly = await systemPrompt.assemble(agent)
  assert.deepEqual(
    secondAssembly.tools.map((tool) => tool.name).sort(),
    ['bash', 'vision_foreign'],
  )
  await preStep(
    { turn: 1, agent, messages: [] },
    async () => {
      assert.equal(currentSessionVisionModeAuthority()?.enabled, false)
      return { kind: 'continue', messages: [] }
    },
  )
  await assert.rejects(
    () => definitions.get('vision_describe').execute({}, { agent }),
    (error) => error?.code === 'VISION_MODE_DISABLED',
  )
  assert.equal(calls, 1)
})
