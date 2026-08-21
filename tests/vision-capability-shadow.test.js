import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCapabilityShadowPlan,
  collectCapabilityShadowCandidates,
  generatedCapabilityRoute,
  installCapabilityShadowRuntime,
} from '../lib/vision-capability-shadow.js'

const OVH = {
  name: 'ovh-free',
  baseURL: 'https://example.test/v1',
  model: 'qwen3-vl',
  apiKeyEnv: '',
}

function fakeCore() {
  return {
    DEFAULT_HTTP_PROVIDERS: [OVH],
    adapterAvailable: () => true,
    decideVisionBackendCapability: () => ({ image: true, attemptable: true }),
    localProvidersOf: () => [{
      name: 'local-ollama',
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5vl',
      apiKeyEnv: '',
    }],
    httpProvidersOf: () => [OVH],
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
      registration() { return { adapter: { constructor: { name: 'FakeRegisteredAdapter' } } } },
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
  assert.equal(generatedCapabilityRoute('my-wrapper', { wrapperRoute: 'my-wrapper', chainRoute: 'my-chain' }), true)
})

test('registered DSH adapter without a pi-ai baseURL gets a stable adapter-route benchmark identity', async () => {
  const config = { providers: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', fallbacks: [] }] }
  const rows = await collectCapabilityShadowCandidates(
    fakeCtx(config).ctx, config, fakeCore(), { async get() { return undefined } },
  )
  const candidate = rows.find((row) => row.provider === 'deepseek-official' && row.model === 'deepseek-v4-flash')
  assert.ok(candidate)
  assert.equal(candidate.benchmarkable, true)
  assert.equal(candidate.evidenceScope, 'adapter-route')
  assert.equal(candidate.routeRole, 'user')
  assert.match(candidate.endpointFingerprint, /^ep2_[0-9a-f]{32}$/)
  assert.match(candidate.endpoint, /^dsh-adapter:\/\/registered\/deepseek-official$/)
})

test('configured pi-ai provider keeps its credential ref only for benchmark execution, not capability identity', async () => {
  const config = { providers: [{ provider: 'zhipu-glm', model: 'glm-4.6v-flash', fallbacks: [] }] }
  const ctx = {
    get(name) {
      if (name !== 'settings') return undefined
      return {
        get(namespace) {
          if (namespace === 'vision-router') return config
          if (namespace === 'llm-pi-ai') {
            return { providers: { 'zhipu-glm': { baseURL: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions', apiKeyEnv: 'ZHIPU_API_KEY' } } }
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
    ctx, config, { ...fakeCore(), localProvidersOf: () => [], httpProvidersOf: () => [] },
    { async get() { return undefined } },
  )
  const candidate = rows.find((row) => row.provider === 'zhipu-glm' && row.model === 'glm-4.6v-flash')
  assert.ok(candidate)
  assert.equal(candidate.evidenceScope, 'endpoint')
  assert.equal(candidate.endpoint, 'https://open.bigmodel.cn/api/paas/v4')
  assert.equal(candidate.endpointConfig.api, 'openai-completions')
  assert.equal(candidate.endpointCredentialRef, 'ZHIPU_API_KEY')
  assert.equal(Object.hasOwn(candidate, 'credentialFingerprint'), false)
  assert.match(candidate.endpointFingerprint, /^ep2_[0-9a-f]{32}$/)
})

test('shadow keeps old capability evidence and labels Benchmark latency as non-routing observation', async () => {
  const oldRows = await collectCapabilityShadowCandidates(fakeCtx().ctx, {}, fakeCore(), {
    async get() {
      return {
        measuredAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
        scores: { general: 1 },
        benchmarkLatencyMs: 100,
        benchmarkMedianLatencyMsByAxis: { general: 100 },
      }
    },
  })
  assert.ok(oldRows.length > 0)
  assert.ok(oldRows.some((row) => row.measured?.general === 1))
  assert.ok(oldRows.some((row) => row.benchmarkMedianLatencyMsByAxis?.general === 100))
  assert.ok(oldRows.every((row) => row.runtimeLatencyMsByAxis === undefined))
})

test('arbitrary DSH-discovered vision models never enter the automatic routing pool', async () => {
  const config = { providers: [{ provider: 'custom', model: 'chosen', fallbacks: [] }] }
  const { ctx } = fakeCtx(config)
  ctx.llm.listProviders = () => [{ id: 'auto-discovered' }]
  ctx.llm.registration = (provider) => ({
    adapter: {
      constructor: { name: 'FakeRegisteredAdapter' },
      listModels: async () => provider === 'auto-discovered' ? [{ id: 'not-selected', inputModalities: ['text', 'image'] }] : [],
    },
  })
  const rows = await collectCapabilityShadowCandidates(ctx, config, fakeCore(), { async get() { return undefined } })
  assert.ok(rows.some((row) => row.key === 'custom/chosen'))
  assert.ok(rows.every((row) => !row.key.includes('auto-discovered') && !row.key.includes('not-selected')))
})

test('explicit vision-http rows preserve their configured position and are not treated as fallback-only', async () => {
  const config = {
    providers: [
      { provider: 'vision-http', model: 'ovh-free/qwen3-vl', fallbacks: [] },
      { provider: 'custom', model: 'chosen', fallbacks: [] },
    ],
  }
  const core = { ...fakeCore(), localProvidersOf: () => [] }
  const rows = await collectCapabilityShadowCandidates(fakeCtx(config).ctx, config, core, { async get() { return undefined } })
  assert.deepEqual(rows.slice(0, 2).map((row) => row.key), ['http:ovh-free/qwen3-vl', 'custom/chosen'])
  assert.equal(rows[0].routeRole, 'user')
})

test('unselected built-in HTTP tier is fixed fallback-only', async () => {
  const config = { providers: [{ provider: 'custom', model: 'chosen', fallbacks: [] }] }
  const core = { ...fakeCore(), localProvidersOf: () => [] }
  const rows = await collectCapabilityShadowCandidates(fakeCtx(config).ctx, config, core, { async get() { return undefined } })
  const fallback = rows.find((row) => row.key === 'http:ovh-free/qwen3-vl')
  assert.ok(fallback)
  assert.equal(fallback.routeRole, 'fallback-only')
})

test('shadow plan reports product mode/preference while reusing the internal scorer strategy', async () => {
  const plan = await buildCapabilityShadowPlan({
    ctx: fakeCtx().ctx,
    core: fakeCore(),
    store: { async get() { return undefined } },
    config: {
      providers: [{ provider: 'custom', model: 'generic', fallbacks: [] }],
      routingMode: 'auto',
      routingPreference: 'local',
    },
    toolName: 'vision_describe',
    args: { question: 'read all text exactly' },
  })
  assert.equal(plan.intent, 'ocr')
  assert.equal(plan.routingMode, 'auto')
  assert.equal(plan.routingPreference, 'local')
  assert.equal(plan.strategy, 'privacy')
  assert.deepEqual(plan.currentOrder, ['custom/generic', 'vision-http/local-ollama/qwen2.5vl', 'http:ovh-free/qwen3-vl'])
  assert.deepEqual(plan.autoPreviewOrder, ['vision-http/local-ollama/qwen2.5vl', 'custom/generic', 'http:ovh-free/qwen3-vl'])
  assert.deepEqual(plan.suggestedOrder, plan.autoPreviewOrder)
  assert.ok(Array.isArray(plan.decisions))
  assert.ok(Array.isArray(plan.incomparableBackends))
})

test('legacy prototype strategy remains readable when the product preference is absent', async () => {
  const plan = await buildCapabilityShadowPlan({
    ctx: fakeCtx().ctx,
    core: fakeCore(),
    store: { async get() { return undefined } },
    config: {
      capabilityRoutingStrategy: 'privacy',
      providers: [{ provider: 'custom', model: 'generic', fallbacks: [] }],
    },
    toolName: 'vision_describe',
    args: { question: 'what is in this photo?' },
  })
  assert.equal(plan.routingMode, 'ordered')
  assert.equal(plan.routingPreference, 'local')
  assert.equal(plan.strategy, 'privacy')
})

test('shadow wrapper logs a plan but returns the original tool result byte-for-byte', async () => {
  const settings = {
    capabilityRoutingShadow: true,
    routingMode: 'ordered',
    routingPreference: 'balanced',
    providers: [{ provider: 'custom', model: 'm', fallbacks: [] }],
  }
  const { ctx, registered, logs } = fakeCtx(settings)
  const wrapped = installCapabilityShadowRuntime(ctx, settings, fakeCore(), {
    store: { async get() { return undefined } }, logger: ctx.logger,
  })
  const originalResult = '{"ok":true,"answer":"same"}'
  wrapped.tools.register({ name: 'vision_describe', async execute() { return originalResult } })
  const result = await registered.get('vision_describe').execute(
    { question: 'what is in this photo?' }, { agent: { session: {} } },
  )
  assert.equal(result, originalResult)
  assert.ok(logs.some((entry) => entry[0] === 'info' && String(entry[1]).includes('v2 shadow')))
})

test('disabled shadow performs zero planning work and leaves execution untouched', async () => {
  const settings = { capabilityRoutingShadow: false }
  const { ctx, registered, logs } = fakeCtx(settings)
  let storeReads = 0
  const wrapped = installCapabilityShadowRuntime(ctx, settings, fakeCore(), {
    store: { async get() { storeReads += 1; return undefined } }, logger: ctx.logger,
  })
  wrapped.tools.register({ name: 'vision_describe', async execute() { return 'ok' } })
  assert.equal(await registered.get('vision_describe').execute({ question: 'x' }, { agent: { session: {} } }), 'ok')
  assert.equal(storeReads, 0)
  assert.equal(logs.length, 0)
})

test('bootstrap evidence is remembered only for shadow intent fallback on the same session', async () => {
  const settings = {
    capabilityRoutingShadow: true,
    routingMode: 'ordered',
    routingPreference: 'balanced',
    providers: [{ provider: 'custom', model: 'm', fallbacks: [] }],
  }
  const { ctx, registered, logs } = fakeCtx(settings)
  const wrapped = installCapabilityShadowRuntime(ctx, settings, fakeCore(), {
    store: { async get() { return undefined } }, logger: ctx.logger,
  })
  wrapped.tools.register({
    name: 'vision_bootstrap',
    async execute() {
      return JSON.stringify({ ok: true, evidence: { visual_kind: 'code', content_kind: 'unknown', mixed_of: [] } })
    },
  })
  wrapped.tools.register({ name: 'vision_describe', async execute() { return 'done' } })
  const session = {}
  await registered.get('vision_bootstrap').execute({}, { agent: { session } })
  await registered.get('vision_describe').execute({ question: 'check the important details' }, { agent: { session } })
  const shadowLogs = logs.filter((entry) => entry[0] === 'info' && String(entry[1]).includes('v2 shadow'))
  assert.equal(shadowLogs.length, 2)
  assert.equal(shadowLogs[0][4], 'structured')
  assert.equal(shadowLogs[1][4], 'code_screenshot')
})
