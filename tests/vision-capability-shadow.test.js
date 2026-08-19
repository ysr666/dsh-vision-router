import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCapabilityShadowPlan,
  generatedCapabilityRoute,
  installCapabilityShadowRuntime,
} from '../lib/vision-capability-shadow.js'

function fakeCore() {
  return {
    adapterAvailable: () => true,
    decideVisionBackendCapability: () => ({ image: true, attemptable: true }),
    localProvidersOf: () => [{
      name: 'local-ollama',
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5vl',
      apiKeyEnv: '',
    }],
    httpProvidersOf: () => [{
      name: 'ovh-free',
      baseURL: 'https://example.test/v1',
      model: 'qwen3-vl',
      apiKeyEnv: '',
    }],
  }
}

function fakeCtx(settingsValue = {}) {
  const registered = new Map()
  const logs = []
  const ctx = {
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
    },
    get(name) {
      if (name === 'settings') return { get: () => settingsValue }
      return undefined
    },
    llm: {
      listProviders: () => [],
      async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
    },
    tools: {
      register(def) {
        registered.set(def.name, def)
        return () => registered.delete(def.name)
      },
    },
  }
  return { ctx, registered, logs }
}

test('only the two router-owned generated routes are filtered', () => {
  assert.equal(generatedCapabilityRoute('deepseek-vision', {}), true)
  assert.equal(generatedCapabilityRoute('vision-chain', {}), true)
  assert.equal(generatedCapabilityRoute('custom-vision', {}), false)
  assert.equal(generatedCapabilityRoute('zhipu-vision', {}), false)
  assert.equal(
    generatedCapabilityRoute('my-wrapper', { wrapperRoute: 'my-wrapper', chainRoute: 'my-chain' }),
    true,
  )
})

test('shadow plan mirrors the current candidate order but may recommend a different capability specialist', async () => {
  const ctx = fakeCtx().ctx
  const core = fakeCore()
  const store = { async get() { return undefined } }
  const plan = await buildCapabilityShadowPlan({
    ctx,
    core,
    store,
    config: {
      providers: [{ provider: 'custom', model: 'generic', fallbacks: [] }],
      capabilityRoutingStrategy: 'quality',
    },
    toolName: 'vision_describe',
    args: { question: 'read all text exactly' },
  })
  assert.equal(plan.intent, 'ocr')
  assert.deepEqual(plan.currentOrder, [
    'custom/generic',
    'vision-http/local-ollama/qwen2.5vl',
    'http:ovh-free/qwen3-vl',
  ])
  assert.equal(plan.suggestedOrder.length, plan.currentOrder.length)
  assert.equal(new Set(plan.suggestedOrder).size, plan.currentOrder.length)
})

test('shadow wrapper logs a plan but returns the original tool result byte-for-byte', async () => {
  const settings = {
    capabilityRoutingShadow: true,
    capabilityRoutingStrategy: 'balanced',
    providers: [{ provider: 'custom', model: 'm', fallbacks: [] }],
  }
  const { ctx, registered, logs } = fakeCtx(settings)
  const wrapped = installCapabilityShadowRuntime(ctx, settings, fakeCore(), {
    store: { async get() { return undefined } },
    logger: ctx.logger,
  })
  const originalResult = '{"ok":true,"answer":"same"}'
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() { return originalResult },
  })
  const session = {}
  const result = await registered.get('vision_describe').execute(
    { question: 'what is in this photo?' },
    { agent: { session } },
  )
  assert.equal(result, originalResult)
  assert.ok(logs.some((entry) => entry[0] === 'info' && String(entry[1]).includes('v2 shadow')))
})

test('disabled shadow performs zero planning work and leaves execution untouched', async () => {
  const settings = { capabilityRoutingShadow: false }
  const { ctx, registered, logs } = fakeCtx(settings)
  let storeReads = 0
  const wrapped = installCapabilityShadowRuntime(ctx, settings, fakeCore(), {
    store: { async get() { storeReads += 1; return undefined } },
    logger: ctx.logger,
  })
  wrapped.tools.register({ name: 'vision_describe', async execute() { return 'ok' } })
  assert.equal(await registered.get('vision_describe').execute({ question: 'x' }, { agent: { session: {} } }), 'ok')
  assert.equal(storeReads, 0)
  assert.equal(logs.length, 0)
})

test('bootstrap evidence is remembered only for shadow intent fallback on the same session', async () => {
  const settings = {
    capabilityRoutingShadow: true,
    capabilityRoutingStrategy: 'balanced',
    providers: [{ provider: 'custom', model: 'm', fallbacks: [] }],
  }
  const { ctx, registered, logs } = fakeCtx(settings)
  const wrapped = installCapabilityShadowRuntime(ctx, settings, fakeCore(), {
    store: { async get() { return undefined } },
    logger: ctx.logger,
  })
  wrapped.tools.register({
    name: 'vision_bootstrap',
    async execute() {
      return JSON.stringify({
        ok: true,
        evidence: { visual_kind: 'code', content_kind: 'unknown', mixed_of: [] },
      })
    },
  })
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() { return 'done' },
  })
  const session = {}
  await registered.get('vision_bootstrap').execute({}, { agent: { session } })
  await registered.get('vision_describe').execute(
    { question: 'check the important details' },
    { agent: { session } },
  )
  const shadowLogs = logs.filter((entry) => entry[0] === 'info' && String(entry[1]).includes('v2 shadow'))
  assert.equal(shadowLogs.length, 2)
  assert.equal(shadowLogs[0][2], 'structured')
  assert.equal(shadowLogs[1][2], 'code_screenshot')
})
