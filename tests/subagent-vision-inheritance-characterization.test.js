import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveSessionVisionModeAuthority } from '../lib/session-vision-mode-authority.js'

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
