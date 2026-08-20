import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCapabilityShadowPlan,
  collectCapabilityShadowCandidates,
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
      registration() {
        return { adapter: { constructor: { name: 'FakeRegisteredAdapter' } } }
      },
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

test('registered DSH adapter without a pi-ai baseURL gets a stable adapter-route benchmark identity', async () => {
  const config = {
    providers: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', fallbacks: [] }],
  }
  const ctx = fakeCtx(config).ctx
  const rows = await collectCapabilityShadowCandidates(
    ctx,
    config,
    fakeCore(),
    { async get() { return undefined } },
  )
  const candidate = rows.find((row) => row.provider === 'deepseek-official' && row.model === 'deepseek-v4-flash')
  assert.ok(candidate)
  assert.equal(candidate.benchmarkable, true)
  assert.equal(candidate.evidenceScope, 'adapter-route')
  assert.match(candidate.endpointFingerprint, /^ep2_[0-9a-f]{32}$/)
  assert.match(candidate.endpoint, /^dsh-adapter:\/\/registered\/deepseek-official$/)
})

test('configured pi-ai provider keeps its exact endpoint credential ref private for benchmark execution', async () => {
  const config = {
    providers: [{ provider: 'zhipu-glm', model: 'glm-4.6v-flash', fallbacks: [] }],
  }
  const ctx = {
    get(name) {
      if (name !== 'settings') return undefined
      return {
        get(namespace) {
          if (namespace === 'vision-router') return config
          if (namespace === 'llm-pi-ai') {
            return {
              providers: {
                'zhipu-glm': {
                  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
                  api: 'openai-completions',
                  apiKeyEnv: 'ZHIPU_API_KEY',
                },
              },
            }
          }
          return undefined
        },
      }
    },
    llm: {
      listProviders: () => [],
      registration() { return { adapter: { constructor: { name: 'PiAiAdapter' } } } },
      async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
    },
  }
  const rows = await collectCapabilityShadowCandidates(
    ctx,
    config,
    { ...fakeCore(), localProvidersOf: () => [], httpProvidersOf: () => [] },
    { async get() { return undefined } },
  )
  const candidate = rows.find((row) => row.provider === 'zhipu-glm' && row.model === 'glm-4.6v-flash')
  assert.ok(candidate)
  assert.equal(candidate.evidenceScope, 'endpoint')
  assert.equal(candidate.endpoint, 'https://open.bigmodel.cn/api/paas/v4')
  assert.equal(candidate.endpointConfig.api, 'openai-completions')
  assert.equal(candidate.endpointCredentialRef, 'ZHIPU_API_KEY')
  assert.match(candidate.endpointFingerprint, /^ep2_[0-9a-f]{32}$/)
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
