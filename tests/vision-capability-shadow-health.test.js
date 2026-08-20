import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCapabilityShadowPlan,
  installCapabilityShadowRuntime,
} from '../lib/vision-capability-shadow.js'

function coreWithoutExtraCandidates() {
  return {
    adapterAvailable: () => true,
    decideVisionBackendCapability: () => ({ image: true, attemptable: true }),
    localProvidersOf: () => [],
    httpProvidersOf: () => [],
  }
}

function contextFor(settingsValue = {}) {
  const registered = new Map()
  const ctx = {
    get(name) {
      if (name === 'settings') return { get: () => settingsValue }
      return undefined
    },
    llm: {
      listProviders: () => [],
      registration() {
        return { adapter: { constructor: { name: 'FakeAdapter' } } }
      },
      async resolveModelInfo() {
        return { inputModalities: ['text', 'image'] }
      },
    },
    tools: {
      register(def) {
        registered.set(def.name, def)
        return () => registered.delete(def.name)
      },
    },
    logger: { info() {}, warn() {} },
  }
  return { ctx, registered }
}

test('shadow health can demote a circuit-open backend without changing current order', async () => {
  const config = {
    routingMode: 'ordered',
    routingPreference: 'balanced',
    providers: [
      { provider: 'custom-a', model: 'qwen-vl-a', fallbacks: [] },
      { provider: 'custom-b', model: 'generic-b', fallbacks: [] },
    ],
  }
  const { ctx } = contextFor(config)
  const plan = await buildCapabilityShadowPlan({
    ctx,
    config,
    core: coreWithoutExtraCandidates(),
    store: { async get() { return undefined } },
    toolName: 'vision_describe',
    args: { question: 'what is in this image?' },
    healthForCandidate(candidate) {
      return candidate.key === 'custom-a/qwen-vl-a'
        ? { circuitOpen: true }
        : { recentSuccess: true }
    },
  })

  assert.deepEqual(plan.currentOrder, ['custom-a/qwen-vl-a', 'custom-b/generic-b'])
  assert.deepEqual(plan.blockedBackends, ['custom-a/qwen-vl-a'])
  assert.deepEqual(plan.healthBackends, ['custom-a/qwen-vl-a', 'custom-b/generic-b'])
  assert.equal(plan.suggestedOrder.at(-1), 'custom-a/qwen-vl-a')
  assert.equal(plan.explanation.find((row) => row.backend === 'custom-a/qwen-vl-a').health, 0)
})

test('shadow health observation failures stay neutral instead of blocking execution', async () => {
  const config = {
    providers: [{ provider: 'custom-a', model: 'generic-a', fallbacks: [] }],
  }
  const { ctx } = contextFor(config)
  const plan = await buildCapabilityShadowPlan({
    ctx,
    config,
    core: coreWithoutExtraCandidates(),
    store: { async get() { return undefined } },
    toolName: 'vision_describe',
    args: { question: 'describe it' },
    healthForCandidate() {
      throw new Error('health observer unavailable')
    },
  })

  assert.deepEqual(plan.healthBackends, [])
  assert.deepEqual(plan.blockedBackends, [])
  assert.equal(plan.explanation[0].health, 1)
})

test('disabled runtime shadow never reads health and returns the original result', async () => {
  const settings = { capabilityRoutingShadow: false }
  const { ctx, registered } = contextFor(settings)
  let healthReads = 0
  const wrapped = installCapabilityShadowRuntime(ctx, settings, coreWithoutExtraCandidates(), {
    store: { async get() { return undefined } },
    healthForCandidate() {
      healthReads += 1
      return { circuitOpen: true }
    },
  })

  wrapped.tools.register({
    name: 'vision_describe',
    async execute() { return 'v1-result' },
  })
  const result = await registered.get('vision_describe').execute(
    { question: 'x' },
    { agent: { session: {} } },
  )

  assert.equal(result, 'v1-result')
  assert.equal(healthReads, 0)
})
