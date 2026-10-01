import assert from 'node:assert/strict'
import test from 'node:test'

import { installSessionVisionDelegationBoundary } from '../lib/session-vision-delegation-boundary.js'
import { installSessionVisionModeBoundary } from '../lib/session-vision-mode-boundary.js'
import {
  createSessionVisionPolicyRuntimeStore,
  sessionVisionPolicyDomainSpec,
} from '../lib/session-vision-policy-domain.js'
import { resolveSessionVisionModeAuthority } from '../lib/session-vision-mode-authority.js'

const OWNER = Symbol.for('dsh-vision-router.adapter-owner')

test('cold-resumed child hydrates delegated DVR ON before first tool projection', async () => {
  const durableRows = new Map([
    ['child', {
      revision: 1,
      enabled: true,
      source: 'delegation',
      inheritedFrom: 'parent',
    }],
  ])
  const handlers = new Map()
  const definitions = new Map()
  const restrictCalls = []

  const ctx = {
    storageDomain: {
      async open(spec) {
        assert.equal(spec, sessionVisionPolicyDomainSpec)
        return {
          table(name) {
            assert.equal(name, 'policies')
            return {
              get(key) { return durableRows.get(key) },
              async put(key, value) { durableRows.set(key, value) },
              async delete(key) { return durableRows.delete(key) },
            }
          },
          async close() {},
        }
      },
    },
    llm: {
      registration(provider) {
        if (provider === 'openai') return { adapter: { stream() {} } }
        if (provider === 'deepseek-vision') {
          return { adapter: { stream() {}, [OWNER]: { route: 'deepseek-vision' } } }
        }
        return undefined
      },
    },
    sessionProjections: {
      stateOf(session, key) {
        assert.equal(key, 'modelSelection')
        return session.selectionState
      },
    },
    get(name) {
      if (name === 'storageDomain') return this.storageDomain
      if (name === 'sessionProjections') return this.sessionProjections
      return undefined
    },
    agents: {
      currentInitiator() { return undefined },
      isOwnedBy() { return false },
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
    logger: { warn() {} },
  }

  const child = {
    id: 'child',
    session: {
      selectionState: {
        lastUsed: { provider: 'openai', model: 'gpt-x' },
        pending: null,
      },
    },
    ctx: {
      logger: { warn() {} },
      tools: {
        get(name) { return definitions.get(name) },
        restrict({ deny }) {
          restrictCalls.push([...deny])
          return () => {}
        },
      },
    },
  }

  const store = createSessionVisionPolicyRuntimeStore(ctx)
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
    async execute() { return 'cold-resume-ok' },
  })

  assert.equal(store.get('child'), undefined)

  // DSH dispatches serial agent/created listeners in registration order.
  // Delegation hydration is installed before the mode boundary in runtime
  // composition, so persisted policy must be present before tool restriction.
  for (const handler of handlers.get('agent/created') ?? []) {
    await handler({ agent: child })
  }

  assert.deepEqual(store.get('child'), durableRows.get('child'))
  assert.deepEqual(restrictCalls, [])

  const authority = resolveSessionVisionModeAuthority(
    ctx,
    child,
    {},
    { sessionPolicy: store.get('child') },
  )
  assert.equal(authority.enabled, true)
  assert.equal(authority.reason, 'session-policy')
  assert.deepEqual(authority.route, { provider: 'openai', model: 'gpt-x' })

  const tool = definitions.get('vision_describe')
  assert.ok(tool)
  assert.equal(await tool.execute({}, { agent: child }), 'cold-resume-ok')
})
