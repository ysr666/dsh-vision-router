import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveSessionVisionModeAuthority } from '../lib/session-vision-mode-authority.js'
import { userSessionVisionPolicy } from '../lib/session-vision-policy.js'

const OWNER = Symbol.for('dsh-vision-router.adapter-owner')

function ctx() {
  const adapters = new Map([
    ['deepseek-official', { stream() {} }],
    ['deepseek-vision', { stream() {}, [OWNER]: { route: 'deepseek-vision' } }],
    ['openai', { stream() {} }],
  ])
  return {
    llm: {
      registration(provider) {
        const adapter = adapters.get(provider)
        return adapter === undefined ? undefined : { adapter }
      },
    },
    sessionProjections: {
      stateOf(session, key) {
        assert.equal(key, 'modelSelection')
        return session.selectionState
      },
    },
    get(name) {
      if (name === 'sessionProjections') return this.sessionProjections
      return undefined
    },
  }
}

function agent(provider, model = 'm') {
  return {
    session: {
      selectionState: {
        lastUsed: { provider, model },
        pending: null,
      },
      requestHeader() {
        return { config: { provider, model } }
      },
    },
  }
}

test('optional sessionProjections capability never requires direct Cordis service access', () => {
  const projections = {
    stateOf(session, key) {
      assert.equal(key, 'modelSelection')
      return session.selectionState
    },
  }
  const ordinaryAdapter = { stream() {} }
  const visionAdapter = { stream() {}, [OWNER]: { route: 'deepseek-vision' } }
  const host = new Proxy({
    llm: {
      registration(provider) {
        if (provider === 'deepseek-vision') return { adapter: visionAdapter }
        if (provider === 'openai') return { adapter: ordinaryAdapter }
        return undefined
      },
    },
    get(name) {
      if (name === 'sessionProjections') return projections
      return undefined
    },
  }, {
    get(target, property, receiver) {
      if (property === 'sessionProjections') {
        throw new Error('cannot get property "sessionProjections" without inject')
      }
      return Reflect.get(target, property, receiver)
    },
  })

  const authority = resolveSessionVisionModeAuthority(host, agent('deepseek-vision'), {})
  assert.equal(authority.enabled, true)
  assert.equal(authority.reason, 'vision-router-route')
})

test('subagent characterization: inherited DVR route remains Vision ON', () => {
  // Current DSH resolveChildAgentOptions() inherits the parent requestHeader
  // route when no child model override is supplied. This fixture represents
  // the resulting child route observed by DVR.
  const authority = resolveSessionVisionModeAuthority(ctx(), agent('deepseek-vision'), {})
  assert.equal(authority.enabled, true)
  assert.equal(authority.reason, 'vision-router-route')
})

test('subagent characterization: explicit ordinary child route currently drops Vision ON', () => {
  // Current gap: DSH legitimately lets the child choose another base model,
  // while DVR still derives Session Vision authority only from route ownership.
  // Phase 2 will replace this behavior with inherited Session policy authority.
  const authority = resolveSessionVisionModeAuthority(ctx(), agent('openai'), {})
  assert.equal(authority.enabled, false)
  assert.equal(authority.reason, 'ordinary-route')
})


test('subagent target: inherited Session policy keeps Vision ON across an explicit ordinary child model', () => {
  const authority = resolveSessionVisionModeAuthority(
    ctx(),
    agent('openai'),
    {},
    { sessionPolicy: {
      revision: 1,
      enabled: true,
      source: 'delegation',
      inheritedFrom: 'parent',
    } },
  )
  assert.equal(authority.enabled, true)
  assert.equal(authority.reason, 'session-policy')
  assert.deepEqual(authority.route, { provider: 'openai', model: 'm' })
})

test('child-local explicit OFF policy outranks a DVR-owned route', () => {
  const authority = resolveSessionVisionModeAuthority(
    ctx(),
    agent('deepseek-vision'),
    {},
    { sessionPolicy: userSessionVisionPolicy(false) },
  )
  assert.equal(authority.enabled, false)
  assert.equal(authority.reason, 'session-policy')
  assert.deepEqual(authority.route, { provider: 'deepseek-vision', model: 'm' })
})

test('malformed Session policy is ignored and preserves route-derived compatibility', () => {
  const authority = resolveSessionVisionModeAuthority(
    ctx(),
    agent('openai'),
    {},
    { sessionPolicy: { revision: 1, enabled: true, source: 'delegation' } },
  )
  assert.equal(authority.enabled, false)
  assert.equal(authority.reason, 'ordinary-route')
})
