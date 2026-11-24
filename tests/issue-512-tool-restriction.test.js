import assert from 'node:assert/strict'
import test from 'node:test'

import { installSessionVisionModeBoundary } from '../lib/session-vision-mode-boundary.js'

const OWNER = Symbol.for('dsh-vision-router.adapter-owner')

function makeHarness({ failRestriction = false, sessionVisionPolicyStore, hostGetRequiresExplicitScope = false } = {}) {
  const handlers = new Map()
  const definitions = new Map()
  const restrictCalls = []
  const warnings = []
  const effects = []
  const scopedByAgent = new WeakMap()
  const liveAgents = []
  let screenshotCandidate

  const config = {
    tool: true,
    wrapperRoute: 'deepseek-vision',
    chainRoute: 'vision-chain',
  }
  const settings = {
    get(namespace) {
      return namespace === 'vision-router' ? config : undefined
    },
  }
  const ordinaryAdapter = { stream() {} }
  const wrapperAdapter = { stream() {}, [OWNER]: { route: 'deepseek-vision' } }
  const llm = {
    registration(provider) {
      if (provider === 'deepseek-official') return { adapter: ordinaryAdapter }
      if (provider === 'deepseek-vision') return { adapter: wrapperAdapter }
      return undefined
    },
  }
  const sessionProjections = {
    stateOf(session, key) {
      assert.equal(key, 'modelSelection')
      return session.selectionState
    },
  }
  const tools = {
    get(name) {
      return definitions.get(name)
    },
    register(definition) {
      if (definition.name === 'vision_screenshot') {
        screenshotCandidate = definition
        return () => {
          if (screenshotCandidate === definition) screenshotCandidate = undefined
          if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
        }
      }
      definitions.set(definition.name, definition)
      return () => {
        if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
      }
    },
  }
  const ctx = {
    llm,
    tools,
    sessionProjections,
    get(name) {
      if (name === 'agents') return { list: () => [...liveAgents] }
      if (name === 'settings') return settings
      if (name === 'sessionProjections') return sessionProjections
      return undefined
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    effect(setup) {
      const cleanup = setup()
      if (typeof cleanup === 'function') effects.push(cleanup)
      return cleanup
    },
  }
  const mode = installSessionVisionModeBoundary(ctx, config, { sessionVisionPolicyStore })

  function makeAgent(provider = 'deepseek-official', id = 'agent') {
    const activeRestrictions = []
    const agent = {
      id,
      session: {
        selectionState: {
          lastUsed: { provider, model: 'model' },
          pending: null,
        },
      },
    }
    const scopedDefinitions = new Map()
    scopedByAgent.set(agent, scopedDefinitions)
    liveAgents.push(agent)
    agent.ctx = {
      logger: {
        warn(...args) {
          warnings.push(args)
        },
      },
      tools: {
        get(name, scope) {
          // DSH 0.2.1-rc.3 defaults an omitted scope to the global view,
          // even when called via agent.ctx.tools. Older test Hosts did not.
          if (hostGetRequiresExplicitScope && scope !== agent) return definitions.get(name)
          if (scopedDefinitions.has(name)) return scopedDefinitions.get(name)
          if (activeRestrictions.some((deny) => deny.has(name))) return undefined
          return definitions.get(name)
        },
        restrict(filter) {
          const deny = Array.isArray(filter?.deny) ? [...filter.deny] : []
          restrictCalls.push(deny)
          const unknown = deny.filter((name) => !definitions.has(name))
          if (failRestriction || unknown.length > 0) {
            throw new Error(
              `tools.restrict() names unknown global tool; known global tools: ${[
                ...definitions.keys(),
                ...Array.from({ length: 120 }, (_, index) => `foreign_${index}`),
              ].join(', ')}`,
            )
          }
          const record = new Set(deny)
          activeRestrictions.push(record)
          let active = true
          return () => {
            if (!active) return
            active = false
            const index = activeRestrictions.indexOf(record)
            if (index >= 0) activeRestrictions.splice(index, 1)
          }
        },
      },
    }
    return agent
  }

  return {
    mode,
    ctx,
    config,
    handlers,
    definitions,
    restrictCalls,
    warnings,
    makeAgent,
    disposeBoundaryEffects() {
      for (const cleanup of effects.splice(0).reverse()) cleanup()
    },
    shadowForAgent(agent, name, definition) {
      const scoped = scopedByAgent.get(agent)
      assert.ok(scoped)
      scoped.set(name, definition)
    },
    mountScreenshot() {
      assert.ok(screenshotCandidate)
      definitions.set('vision_screenshot', screenshotCandidate)
    },
    unmountScreenshot() {
      definitions.delete('vision_screenshot')
    },
  }
}

test('issue #512: conditional owned tools are projected to current Host registrations before restrict()', () => {
  const harness = makeHarness()
  harness.mode.ctx.tools.register({ name: 'vision_describe', async execute() {} })
  harness.mode.ctx.tools.register({ name: 'vision_screenshot', async execute() {} })

  const agent = harness.makeAgent()
  harness.handlers.get('agent/created')?.({ agent })
  assert.deepEqual(harness.restrictCalls, [['vision_describe']])
  assert.equal(harness.warnings.length, 0)

  harness.mountScreenshot()
  harness.handlers.get('agent/status')?.({ agent, status: 'running' })
  assert.deepEqual(harness.restrictCalls, [
    ['vision_describe'],
    ['vision_describe', 'vision_screenshot'],
  ])

  harness.unmountScreenshot()
  harness.handlers.get('agent/status')?.({ agent, status: 'running' })
  assert.deepEqual(harness.restrictCalls, [
    ['vision_describe'],
    ['vision_describe', 'vision_screenshot'],
    ['vision_describe'],
  ])
  assert.equal(harness.warnings.length, 0)
})

test('issue #512: repeated OFF sync cannot unmask a restriction through scoped get()', () => {
  const harness = makeHarness()
  harness.mode.ctx.tools.register({ name: 'vision_describe', async execute() {} })

  const agent = harness.makeAgent()
  harness.handlers.get('agent/created')?.({ agent })
  assert.equal(agent.ctx.tools.get('vision_describe'), undefined)
  assert.deepEqual(harness.restrictCalls, [['vision_describe']])

  // Real DSH get() is restriction-aware. The second sync must consult the
  // unscoped global registry rather than mistake its own mask for unregistration.
  harness.handlers.get('agent/status')?.({ agent, status: 'running' })
  assert.equal(agent.ctx.tools.get('vision_describe'), undefined)
  assert.deepEqual(harness.restrictCalls, [['vision_describe']])
})


test('issue #512: boundary teardown releases Agent-scoped masks before HMR re-registration', async () => {
  const harness = makeHarness()
  const disposeFirstTool = harness.mode.ctx.tools.register({ name: 'vision_describe', async execute() {} })
  const agent = harness.makeAgent()

  harness.handlers.get('agent/created')?.({ agent })
  assert.equal(agent.ctx.tools.get('vision_describe'), undefined)
  assert.deepEqual(harness.restrictCalls, [['vision_describe']])

  // Settings/HMR disposes the plugin fiber, but the Agent scope survives. The
  // tool registration disappears with the old fiber; its Agent-scoped deny
  // must disappear too or the next generation cannot make the same tool visible.
  disposeFirstTool()
  harness.disposeBoundaryEffects()

  agent.session.selectionState = {
    lastUsed: { provider: 'deepseek-vision', model: 'model' },
    pending: null,
  }
  const nextMode = installSessionVisionModeBoundary(harness.ctx, harness.config)
  nextMode.ctx.tools.register({ name: 'vision_describe', async execute() {} })
  harness.handlers.get('agent/status')?.({ agent, status: 'running' })

  assert.ok(agent.ctx.tools.get('vision_describe'))
  const assembly = { tools: agent.ctx.tools.get('vision_describe') ? [{ name: 'vision_describe' }] : [] }
  const projected = await harness.handlers.get('system-prompt/assemble')?.(
    assembly,
    { agent },
    async () => assembly,
  )
  assert.deepEqual(projected.tools.map((tool) => tool.name), ['vision_describe'])
})

test('issue #512: genuine restriction failures keep bounded diagnostics', () => {
  const harness = makeHarness({ failRestriction: true })
  harness.mode.ctx.tools.register({ name: 'vision_describe', async execute() {} })

  const agent = harness.makeAgent()
  harness.handlers.get('agent/created')?.({ agent })

  assert.equal(harness.warnings.length, 1)
  const rendered = harness.warnings[0].map((value) => String(value)).join(' ')
  assert.match(rendered, /attempted=%s failed=%s/)
  assert.match(rendered, /vision_describe/)
  assert.doesNotMatch(rendered, /known global tools/)
  assert.doesNotMatch(rendered, /foreign_119/)
})


test('issue #512: a foreign Agent-scoped shadow survives DVR global restriction and assembly projection', async () => {
  const harness = makeHarness()
  harness.mode.ctx.tools.register({ name: 'vision_describe', async execute() {} })

  const agent = harness.makeAgent()
  const foreign = {
    name: 'vision_describe',
    async execute() {
      return 'foreign scoped describe'
    },
  }
  harness.shadowForAgent(agent, 'vision_describe', foreign)

  harness.handlers.get('agent/created')?.({ agent })
  assert.deepEqual(harness.restrictCalls, [['vision_describe']])
  assert.equal(agent.ctx.tools.get('vision_describe'), foreign)

  const assemble = harness.handlers.get('system-prompt/assemble')
  assert.ok(assemble)
  const assembly = {
    tools: [
      { name: 'vision_describe' },
      { name: 'foreign_tool' },
    ],
  }
  const projected = await assemble(
    assembly,
    { agent },
    async () => assembly,
  )
  assert.deepEqual(projected.tools.map((tool) => tool.name), [
    'vision_describe',
    'foreign_tool',
  ])
})

test('DSH RC3: explicit Agent scope preserves foreign same-name schemas when global get is misleading', async () => {
  const harness = makeHarness({ hostGetRequiresExplicitScope: true })
  harness.mode.ctx.tools.register({ name: 'vision_describe', async execute() {} })
  const agent = harness.makeAgent()
  const foreign = { name: 'vision_describe', description: 'Agent-local foreign tool' }
  harness.shadowForAgent(agent, 'vision_describe', foreign)

  // Exact official RC3 ToolRuntime semantics: get(name) is unscoped.
  assert.notEqual(agent.ctx.tools.get('vision_describe'), foreign)
  assert.equal(agent.ctx.tools.get('vision_describe', agent), foreign)
  harness.handlers.get('agent/created')?.({ agent })

  const assembly = { tools: [{ name: 'vision_describe' }, { name: 'foreign_tool' }] }
  const assemble = harness.handlers.get('system-prompt/assemble')
  assert.ok(assemble)
  const projected = await assemble(assembly, { agent }, async () => assembly)
  assert.deepEqual(projected.tools.map((tool) => tool.name), [
    'vision_describe',
    'foreign_tool',
  ])

  // Without an Agent-local shadow, only the actual DVR-owned global tool is removed.
  const plain = harness.makeAgent('deepseek-official', 'plain')
  harness.handlers.get('agent/created')?.({ agent: plain })
  const plainProjection = await assemble(assembly, { agent: plain }, async () => assembly)
  assert.deepEqual(plainProjection.tools.map((tool) => tool.name), ['foreign_tool'])
})

test('issue #512: a foreign tool that reuses an unmounted DVR name is not restricted or filtered', async () => {
  const harness = makeHarness()
  harness.mode.ctx.tools.register({ name: 'vision_describe', async execute() {} })
  harness.mode.ctx.tools.register({ name: 'vision_screenshot', async execute() {} })

  harness.definitions.set('vision_screenshot', {
    name: 'vision_screenshot',
    async execute() {
      return 'foreign screenshot'
    },
  })

  const agent = harness.makeAgent()
  harness.handlers.get('agent/created')?.({ agent })
  assert.deepEqual(harness.restrictCalls, [['vision_describe']])

  const assemble = harness.handlers.get('system-prompt/assemble')
  assert.ok(assemble)
  const assembly = {
    tools: [
      { name: 'vision_describe' },
      { name: 'vision_screenshot' },
      { name: 'foreign_tool' },
    ],
  }
  const projected = await assemble(
    assembly,
    { agent },
    async () => assembly,
  )
  assert.deepEqual(projected.tools.map((tool) => tool.name), [
    'vision_screenshot',
    'foreign_tool',
  ])
})


test('Session policy keeps an ordinary child route enabled through direct tool execution', async () => {
  const sessionVisionPolicyStore = {
    get(id) {
      if (id !== 'child') return undefined
      return {
        revision: 1,
        enabled: true,
        source: 'delegation',
        inheritedFrom: 'parent',
      }
    },
  }
  const harness = makeHarness({ sessionVisionPolicyStore })
  harness.mode.ctx.tools.register({
    name: 'vision_describe',
    async execute() {
      return 'policy-enabled'
    },
  })

  const child = harness.makeAgent('deepseek-official', 'child')
  harness.handlers.get('agent/created')?.({ agent: child })

  assert.deepEqual(harness.restrictCalls, [])
  const definition = harness.definitions.get('vision_describe')
  assert.ok(definition)
  assert.equal(await definition.execute({}, { agent: child }), 'policy-enabled')
})


test('committed model selection materializes user Session Vision authority over delegation snapshots', async () => {
  const rows = new Map([
    ['agent', { revision: 1, enabled: false, source: 'delegation', inheritedFrom: 'parent' }],
  ])
  const store = {
    get(id) { return rows.get(id) },
    async set(id, policy) {
      rows.set(id, policy)
      return policy
    },
    async delete(id) { rows.delete(id) },
  }
  const h = makeHarness({ sessionVisionPolicyStore: store })
  const onSessionEvent = h.handlers.get('session/event')
  assert.equal(typeof onSessionEvent, 'function')

  onSessionEvent(
    { id: 'agent' },
    { type: 'model/selection', data: { provider: 'deepseek-vision', model: 'model' } },
  )
  await Promise.resolve()
  assert.deepEqual(rows.get('agent'), { revision: 1, enabled: true, source: 'user' })

  onSessionEvent(
    { id: 'agent' },
    { type: 'model/selection', data: { provider: 'deepseek-official', model: 'model' } },
  )
  await Promise.resolve()
  assert.deepEqual(rows.get('agent'), { revision: 1, enabled: false, source: 'user' })
})

test('Session Vision boundary establishes lifecycle ownership before admitting long-lived Agent hooks', () => {
  let onCalls = 0
  const ctx = {
    tools: {},
    get() { return undefined },
    on() { onCalls += 1; return () => {} },
    effect() { throw new Error('inactive fiber') },
  }

  const result = installSessionVisionModeBoundary(ctx, { tool: true })

  assert.equal(result.ctx, ctx)
  assert.equal(onCalls, 0, 'an unowned generation must not register hooks that can create Agent-scoped masks')
})

test('Issue #759: HMR restoration immediately reinstates OFF Agent tool restrictions without waiting for an agent/status event', () => {
  const harness = makeHarness()
  harness.mode.ctx.tools.register({ name: 'vision_describe', async execute() {} })
  const agent = harness.makeAgent()
  assert.ok(agent.ctx.tools.get('vision_describe'), 'without reconciliation an existing OFF Agent sees remounted schemas')

  harness.mode.reconcileExistingAgents()
  assert.equal(agent.ctx.tools.get('vision_describe'), undefined)
  assert.deepEqual(harness.restrictCalls, [['vision_describe']])
  harness.mode.reconcileExistingAgents()
  assert.deepEqual(harness.restrictCalls, [['vision_describe']], 'reconciliation must be idempotent')
})

test('Issue #759: HMR restoration preserves existing Vision ON Agent access and ignores Hosts without Agent listing', () => {
  const harness = makeHarness()
  harness.mode.ctx.tools.register({ name: 'vision_describe', async execute() {} })
  const agent = harness.makeAgent('deepseek-vision')
  harness.mode.reconcileExistingAgents()
  assert.ok(agent.ctx.tools.get('vision_describe'))
  assert.deepEqual(harness.restrictCalls, [])

  const noRegistry = installSessionVisionModeBoundary({
    get() { return undefined },
    effect(setup) { return setup() },
    on() { return () => {} },
  })
  assert.doesNotThrow(() => noRegistry.reconcileExistingAgents())
})

test('HMR restoration respects pending durable model selections instead of initial Agent constructor routes', () => {
  const harness = makeHarness()
  harness.mode.ctx.tools.register({ name: 'vision_describe', async execute() {} })
  const initiallyOn = harness.makeAgent('deepseek-vision', 'initially-on')
  const initiallyOff = harness.makeAgent('deepseek-official', 'initially-off')

  // Real DSH session-controller modelSelection projection returns pending
  // composer intent ahead of the last-used/constructor route.
  initiallyOn.session.selectionState.pending = { provider: 'deepseek-official', model: 'model' }
  initiallyOff.session.selectionState.pending = { provider: 'deepseek-vision', model: 'model' }

  harness.mode.reconcileExistingAgents()
  assert.equal(initiallyOn.ctx.tools.get('vision_describe'), undefined, 'ON->OFF selection stays denied after remount')
  assert.ok(initiallyOff.ctx.tools.get('vision_describe'), 'OFF->ON selection stays accessible after remount')
  assert.deepEqual(harness.restrictCalls, [['vision_describe']])
})


test('issue #865: effort-only model selection does not reset explicit Session Vision policy', async () => {
  const rows = new Map()
  let writes = 0
  const store = { get: id => rows.get(id), async set(id, p) { writes++; rows.set(id, p) } }
  const h = makeHarness({ sessionVisionPolicyStore: store })
  const agent = h.makeAgent('deepseek-official', 'native-session')
  agent.session.id = agent.id
  rows.set(agent.id, { revision: 1, enabled: true, source: 'user' })
  h.handlers.get('agent/created')({ agent })
  h.handlers.get('session/event')(agent.session, { type: 'model/selection',
    data: { provider: 'deepseek-official', model: 'model', reasoningEffort: 'high' } })
  assert.equal(writes, 0, 'effort-only change must retain explicitly enabled tools')
  assert.equal(rows.get(agent.id).enabled, true)
  h.handlers.get('session/event')(agent.session, { type: 'model/selection',
    data: { provider: 'deepseek-official', model: 'other' } })
  assert.equal(writes, 1)
  assert.equal(rows.get(agent.id).enabled, false, 'deliberate route change re-evaluates legacy policy')
})

test('stage 2: unchanged Session Vision policy preserves exact ordered tool schema and OFF remains denied', async () => {
  const policies = new Map([['stage-2-agent', { revision: 1, enabled: false, source: 'user' }]])
  const h = makeHarness({ sessionVisionPolicyStore: { get: id => policies.get(id) } })
  const execution = []
  for (const name of ['vision_ocr', 'vision_describe']) {
    h.mode.ctx.tools.register({ name, description: 'stable:' + name,
      async execute() { execution.push(name); return name } })
  }
  h.mode.ctx.tools.register({ name: 'foreign_helper', async execute() { return 'foreign' } })
  const agent = h.makeAgent('deepseek-official', 'stage-2-agent')
  agent.session.id = agent.id
  h.handlers.get('agent/created')?.({ agent })
  const input = {
    tools: [
      { name: 'foreign_helper', description: 'other plugin' },
      { name: 'vision_ocr', description: 'stable:vision_ocr' },
      { name: 'vision_describe', description: 'stable:vision_describe' },
    ],
  }
  const original = structuredClone(input)
  const assemble = h.handlers.get('system-prompt/assemble')
  assert.equal(typeof assemble, 'function')
  async function projected() {
    // Real Host assembly snapshots a Session's visible schema, with tool order
    // meaningful to the downstream DeepSeek prefix serializer.
    const result = await assemble(input, { agent }, async () => input)
    assert.deepEqual(input, original, 'DVR must never mutate the Host assembly input')
    return result.tools
  }
  const off = await projected()
  assert.deepEqual(off.map(x => x.name), ['foreign_helper'])
  assert.deepEqual(await projected(), off, 'OFF->OFF cannot alter the tool declarations')
  await assert.rejects(h.definitions.get('vision_describe').execute({}, { agent }), /Vision mode is off/)
  policies.set(agent.id, { revision: 1, enabled: true, source: 'user' })
  h.handlers.get('agent/status')?.({ agent, status: 'running' })
  const on = await projected()
  assert.deepEqual(on, input.tools, 'ON exposes only the same three owned/foreign tool definitions')
  assert.deepEqual(await projected(), on, 'ON->ON cannot reorder or mutate tool schemas')
  assert.equal(await h.definitions.get('vision_describe').execute({}, { agent }), 'vision_describe')
  assert.deepEqual(execution, ['vision_describe'])
  policies.set(agent.id, { revision: 1, enabled: false, source: 'user' })
  h.handlers.get('agent/status')?.({ agent, status: 'running' })
  assert.deepEqual(await projected(), off, 'OFF restored original declarations exactly')
  await assert.rejects(h.definitions.get('vision_ocr').execute({}, { agent }), /Vision mode is off/)
  assert.equal(agent.ctx.tools.get('vision_ocr'), undefined)
})

test('HMR hydrates durable existing Agent policy before any Core tool registration', async () => {
  const durable = new Map([
    ['native-on', { revision: 1, enabled: true, source: 'user' }],
    ['wrapper-off', { revision: 1, enabled: false, source: 'user' }],
  ])
  const hot = new Map()
  const hydrateCalls = []
  let releaseHydration, writes = 0
  const pending = new Promise(resolve => { releaseHydration = resolve })
  const store = {
    durable: true,
    get: id => hot.get(id),
    async hydrate(id) {
      hydrateCalls.push(id)
      await pending
      const row = durable.get(id)
      if (row !== undefined && !hot.has(id)) hot.set(id, row)
      return hot.get(id)
    },
    async set(id, policy) { writes++; hot.set(id, policy) },
  }
  const h = makeHarness({ sessionVisionPolicyStore: store })
  const on = h.makeAgent('deepseek-official', 'native-on')
  const off = h.makeAgent('deepseek-vision', 'wrapper-off')
  on.session.id = on.id
  off.session.id = off.id
  let coreCalls = 0
  const activation = h.mode.withHydratedExistingAgents(() => {
    coreCalls++
    h.mode.ctx.tools.register({ name: 'vision_describe', async execute() { return 'ok' } })
    h.mode.reconcileExistingAgents()
    return 'core-ready'
  })
  assert.equal(coreCalls, 0, 'no newly mounted schemas before persisted policy is available')
  assert.deepEqual(hydrateCalls.sort(), ['native-on', 'wrapper-off'])
  h.handlers.get('session/event')(on.session, {
    type: 'model/selection',
    data: { provider: 'deepseek-official', model: 'model', reasoningEffort: 'high' },
  })
  assert.equal(writes, 0, 'effort-only event during cold hydration cannot overwrite durable user policy')
  releaseHydration()
  assert.equal(await activation, 'core-ready')
  assert.equal(coreCalls, 1)
  assert.ok(on.ctx.tools.get('vision_describe'), 'persisted native ON restores')
  assert.equal(off.ctx.tools.get('vision_describe'), undefined, 'persisted wrapper OFF cannot be replaced by route fallback')
  await assert.rejects(h.definitions.get('vision_describe').execute({}, { agent: off }), /Vision mode is off/)
})

test('existing-Agent hydration keeps empty startup synchronous and refuses late Core after disposal', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const h = makeHarness({ sessionVisionPolicyStore: {
    durable: true, get() {}, hydrate: () => pending,
  } })
  assert.equal(h.mode.withHydratedExistingAgents(() => 7), 7)
  const agent = h.makeAgent('deepseek-official', 'disposed-during-hydration')
  agent.session.id = agent.id
  let called = false
  const activation = h.mode.withHydratedExistingAgents(() => { called = true })
  h.disposeBoundaryEffects()
  release()
  await assert.rejects(activation, /generation disposed/)
  assert.equal(called, false)
})
