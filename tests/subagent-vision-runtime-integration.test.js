import assert from 'node:assert/strict'
import test from 'node:test'

import { installSessionVisionDelegationBoundary } from '../lib/session-vision-delegation-boundary.js'
import { installSessionVisionModeBoundary } from '../lib/session-vision-mode-boundary.js'
import { createVolatileSessionVisionPolicyStore } from '../lib/session-vision-policy.js'
import { resolveSessionVisionModeAuthority } from '../lib/session-vision-mode-authority.js'

const OWNER = Symbol.for('dsh-vision-router.adapter-owner')

function makeSession(provider) {
  return {
    selectionState: {
      lastUsed: { provider, model: 'model' },
      pending: null,
    },
  }
}

test('parent DVR ON delegates Vision tools to an ordinary-model child without changing child route', async () => {
  const handlers = new Map()
  const definitions = new Map()
  const restrictions = new WeakMap()
  let initiator

  const ordinaryAdapter = { stream() {} }
  const visionAdapter = { stream() {}, [OWNER]: { route: 'deepseek-vision' } }
  const ctx = {
    llm: {
      registration(provider) {
        if (provider === 'deepseek-vision') return { adapter: visionAdapter }
        if (provider === 'openai') return { adapter: ordinaryAdapter }
        return undefined
      },
    },
    sessionProjections: {
      stateOf(session, key) {
        assert.equal(key, 'modelSelection')
        return session.selectionState
      },
    },
    settings: undefined,
    get(name) {
      if (name === 'sessionProjections') return this.sessionProjections
      if (name === 'settings') return undefined
      return undefined
    },
    agents: {
      currentInitiator() { return initiator },
      isOwnedBy(id, parent) { return parent === initiator && id === 'child' },
    },
    tools: {
      get(name) { return definitions.get(name) },
      register(definition) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    effect(setup) {
      return setup()
    },
  }

  const parent = {
    id: 'parent',
    session: makeSession('deepseek-vision'),
    ctx: { tools: { get: name => definitions.get(name), restrict() { return () => {} } } },
  }
  const child = {
    id: 'child',
    session: makeSession('openai'),
    ctx: {
      logger: { warn() {} },
      tools: {
        get(name) {
          const denied = restrictions.get(child)
          return denied?.has(name) ? undefined : definitions.get(name)
        },
        restrict({ deny }) {
          const denied = new Set(deny)
          restrictions.set(child, denied)
          return () => restrictions.delete(child)
        },
      },
    },
  }

  const store = createVolatileSessionVisionPolicyStore()
  installSessionVisionDelegationBoundary(
    ctx,
    store,
    agent => resolveSessionVisionModeAuthority(
      ctx,
      agent,
      {},
      { sessionPolicy: store.get(agent.id) },
    ),
  )
  const mode = installSessionVisionModeBoundary(ctx, {}, { sessionVisionPolicyStore: store })
  mode.ctx.tools.register({
    name: 'vision_describe',
    async execute() { return 'vision-ok' },
  })

  initiator = parent
  for (const handler of handlers.get('agent/created') ?? []) {
    await handler({ agent: child })
  }
  initiator = undefined

  assert.deepEqual(store.get('child'), {
    revision: 1,
    enabled: true,
    source: 'delegation',
    inheritedFrom: 'parent',
  })

  const childAuthority = resolveSessionVisionModeAuthority(
    ctx,
    child,
    {},
    { sessionPolicy: store.get('child') },
  )
  assert.equal(childAuthority.enabled, true)
  assert.equal(childAuthority.reason, 'session-policy')
  assert.deepEqual(childAuthority.route, { provider: 'openai', model: 'model' })

  assert.ok(child.ctx.tools.get('vision_describe'))
  const tool = definitions.get('vision_describe')
  assert.ok(tool)
  assert.equal(await tool.execute({}, { agent: child }), 'vision-ok')
})
