import assert from 'node:assert/strict'
import test from 'node:test'

import { installSessionVisionModeBoundary } from '../lib/session-vision-mode-boundary.js'

const OWNER = Symbol.for('dsh-vision-router.adapter-owner')

function makeHarness({ failRestriction = false } = {}) {
  const handlers = new Map()
  const definitions = new Map()
  const restrictCalls = []
  const warnings = []
  const scopedByAgent = new WeakMap()
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
      if (name === 'settings') return settings
      if (name === 'sessionProjections') return sessionProjections
      return undefined
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
  }
  const mode = installSessionVisionModeBoundary(ctx, config)

  function makeAgent(provider = 'deepseek-official') {
    const activeRestrictions = []
    const agent = {
      session: {
        selectionState: {
          lastUsed: { provider, model: 'model' },
          pending: null,
        },
      },
    }
    const scopedDefinitions = new Map()
    scopedByAgent.set(agent, scopedDefinitions)
    agent.ctx = {
      logger: {
        warn(...args) {
          warnings.push(args)
        },
      },
      tools: {
        get(name) {
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
    handlers,
    definitions,
    restrictCalls,
    warnings,
    makeAgent,
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
