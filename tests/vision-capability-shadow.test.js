import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  autoExecutionConfigFor,
  buildCapabilityShadowPlan,
  collectCapabilityShadowCandidates,
  generatedCapabilityRoute,
  installCapabilityShadowRuntime,
} from '../lib/vision-capability-shadow.js'
import { currentVisionExecutionOrder } from '../lib/vision-execution-order.js'

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

function fakeCtx(initialSettings = {}) {
  let settingsValue = initialSettings
  const registered = new Map()
  const logs = []
  const injections = []
  let settingsRegisterCalls = 0
  const settingsScope = {
    get() { return settingsValue },
  }
  const settingsService = {
    get() { return settingsValue },
    register() {
      settingsRegisterCalls += 1
      return settingsScope
    },
  }
  const ctx = {
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
    },
    get(name) {
      if (name === 'settings') return settingsService
      return undefined
    },
    inject(dependencies, callback) {
      injections.push(dependencies)
      return callback({ settings: settingsService })
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
  return {
    ctx,
    registered,
    logs,
    injections,
    settingsScope,
    get settingsRegisterCalls() { return settingsRegisterCalls },
    setSettings(value) { settingsValue = value },
  }
}

function orderIds(order) {
  return Array.isArray(order) ? order.map((row) => `${row.provider}/${row.model}`) : undefined
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
  assert.equal(Object.hasOwn(candidate, 'credentialFingerprint'), false)
  assert.match(candidate.endpointFingerprint, /^ep2_[0-9a-f]{32}$/)
})

test('capability evidence keeps old measurements and labels Benchmark latency as non-routing observation', async () => {
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
      listModels: async () => provider === 'auto-discovered'
        ? [{ id: 'not-selected', inputModalities: ['text', 'image'] }]
        : [],
    },
  })
  const rows = await collectCapabilityShadowCandidates(
    ctx,
    config,
    fakeCore(),
    { async get() { return undefined } },
  )
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
  const rows = await collectCapabilityShadowCandidates(
    fakeCtx(config).ctx,
    config,
    core,
    { async get() { return undefined } },
  )
  assert.deepEqual(rows.slice(0, 2).map((row) => row.key), ['http:ovh-free/qwen3-vl', 'custom/chosen'])
  assert.equal(rows[0].routeRole, 'user')
})

test('unselected built-in HTTP tier is fixed fallback-only', async () => {
  const config = { providers: [{ provider: 'custom', model: 'chosen', fallbacks: [] }] }
  const core = { ...fakeCore(), localProvidersOf: () => [] }
  const rows = await collectCapabilityShadowCandidates(
    fakeCtx(config).ctx,
    config,
    core,
    { async get() { return undefined } },
  )
  const fallback = rows.find((row) => row.key === 'http:ovh-free/qwen3-vl')
  assert.ok(fallback)
  assert.equal(fallback.routeRole, 'fallback-only')
})

test('planner reports product mode/preference while reusing the internal scorer strategy', async () => {
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

test('prototype strategy is ignored when the product preference is absent', async () => {
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
  assert.equal(plan.routingPreference, 'balanced')
  assert.equal(plan.strategy, 'balanced')
})

test('prototype fields cannot trigger planning or execution changes in ordered mode', async () => {
  const settings = {
    capabilityRoutingShadow: true,
    routingMode: 'ordered',
    routingPreference: 'balanced',
    providers: [{ provider: 'custom', model: 'm', fallbacks: [] }],
  }
  const { ctx, registered, logs } = fakeCtx(settings)
  let storeReads = 0
  const wrapped = installCapabilityShadowRuntime(ctx, settings, fakeCore(), {
    store: { async get() { storeReads += 1; return undefined } },
    logger: ctx.logger,
  })
  const originalResult = '{"ok":true,"answer":"same"}'
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      assert.equal(currentVisionExecutionOrder(), undefined)
      return originalResult
    },
  })
  const result = await registered.get('vision_describe').execute(
    { question: 'what is in this photo?' },
    { agent: { session: {} } },
  )
  assert.equal(result, originalResult)
  assert.equal(storeReads, 0)
  assert.equal(logs.length, 0)
})

test('runtime does not impersonate Settings get/register anymore', () => {
  const settings = {
    routingMode: 'auto',
    routingPreference: 'local',
    providers: [{ provider: 'custom', model: 'generic', fallbacks: [] }],
  }
  const fixture = fakeCtx(settings)
  const wrapped = installCapabilityShadowRuntime(fixture.ctx, settings, fakeCore(), {
    store: { async get() { return undefined } },
    logger: fixture.ctx.logger,
  })
  let captured
  wrapped.inject(['settings'], (child) => {
    captured = child.settings.register('vision-router', {}, { base: settings })
  })
  assert.equal(fixture.settingsRegisterCalls, 1)
  assert.equal(captured, fixture.settingsScope)
  assert.deepEqual(captured.get(), settings)
  assert.equal(currentVisionExecutionOrder(), undefined)
})

test('Auto execution exposes only provider/model order inside the current visual-tool call', async () => {
  const settings = {
    routingMode: 'auto',
    routingPreference: 'local',
    providers: [{ provider: 'custom', model: 'generic', fallbacks: [] }],
  }
  const fixture = fakeCtx(settings)
  const wrapped = installCapabilityShadowRuntime(fixture.ctx, settings, fakeCore(), {
    store: { async get() { return undefined } },
    logger: fixture.ctx.logger,
  })
  assert.equal(currentVisionExecutionOrder(), undefined)

  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      const order = currentVisionExecutionOrder()
      assert.ok(Object.isFrozen(order))
      assert.ok(order.every((pair) => Object.isFrozen(pair)))
      assert.ok(order.every((pair) => Object.keys(pair).sort().join(',') === 'model,provider'))
      return orderIds(order)
    },
  })
  const result = await fixture.registered.get('vision_describe').execute(
    { question: 'what is here?' },
    { agent: { session: {} } },
  )
  assert.deepEqual(result, [
    'vision-http/local-ollama/qwen2.5vl',
    'custom/generic',
  ])
  assert.equal(currentVisionExecutionOrder(), undefined, 'execution order must disappear after the call')
  assert.ok(fixture.logs.some((entry) => entry[0] === 'info' && String(entry[1]).includes('v2 auto execute')))
})

test('Auto execution rechecks live authority after planning and refuses a stale plan after revocation', async () => {
  const initial = {
    routingMode: 'auto',
    routingPreference: 'local',
    providers: [{ provider: 'custom', model: 'generic', fallbacks: [] }],
  }
  const fixture = fakeCtx(initial)
  let enteredResolve
  let releaseResolve
  const entered = new Promise((resolve) => { enteredResolve = resolve })
  const release = new Promise((resolve) => { releaseResolve = resolve })
  let first = true
  const wrapped = installCapabilityShadowRuntime(fixture.ctx, initial, fakeCore(), {
    store: {
      async get() {
        if (first) {
          first = false
          enteredResolve()
          await release
        }
        return undefined
      },
    },
    logger: fixture.ctx.logger,
  })
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      return orderIds(currentVisionExecutionOrder()) ?? ['custom/generic']
    },
  })

  const running = fixture.registered.get('vision_describe').execute(
    { question: 'what is here?' },
    { agent: { session: {} } },
  )
  await entered
  fixture.setSettings({ ...initial, routingMode: 'ordered' })
  releaseResolve()
  const result = await running
  assert.deepEqual(result, ['custom/generic'])
  assert.equal(currentVisionExecutionOrder(), undefined)
  assert.ok(fixture.logs.some((entry) =>
    entry[0] === 'info' && entry.slice(1).some((part) => String(part).includes('authority-revoked')),
  ))
})

test('Auto execution rejects a plan when any live settings field changes during evidence collection', async () => {
  const initial = {
    routingMode: 'auto',
    routingPreference: 'local',
    providers: [{ provider: 'custom', model: 'generic', fallbacks: [] }],
  }
  const fixture = fakeCtx(initial)
  let enteredResolve
  let releaseResolve
  const entered = new Promise((resolve) => { enteredResolve = resolve })
  const release = new Promise((resolve) => { releaseResolve = resolve })
  let first = true
  const wrapped = installCapabilityShadowRuntime(fixture.ctx, initial, fakeCore(), {
    store: {
      async get() {
        if (first) {
          first = false
          enteredResolve()
          await release
        }
        return undefined
      },
    },
    logger: fixture.ctx.logger,
  })
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      return orderIds(currentVisionExecutionOrder()) ?? ['custom/generic']
    },
  })
  const running = fixture.registered.get('vision_describe').execute(
    { question: 'what is here?' },
    { agent: { session: {} } },
  )
  await entered
  fixture.setSettings({ ...initial, routingPreference: 'quality' })
  releaseResolve()
  const result = await running
  assert.deepEqual(result, ['custom/generic'])
  assert.ok(fixture.logs.some((entry) =>
    entry[0] === 'info' && entry.slice(1).some((part) => String(part).includes('settings-changed')),
  ))
})

test('Auto planner failure is fail-closed to the original configured order', async () => {
  const settings = {
    routingMode: 'auto',
    routingPreference: 'local',
    providers: [{ provider: 'custom', model: 'generic', fallbacks: [] }],
  }
  const fixture = fakeCtx(settings)
  const wrapped = installCapabilityShadowRuntime(fixture.ctx, settings, fakeCore(), {
    store: { async get() { throw new Error('profile store unavailable') } },
    logger: fixture.ctx.logger,
  })
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      return orderIds(currentVisionExecutionOrder()) ?? ['custom/generic']
    },
  })
  const result = await fixture.registered.get('vision_describe').execute(
    { question: 'what is here?' },
    { agent: { session: {} } },
  )
  assert.deepEqual(result, ['custom/generic'])
  assert.equal(currentVisionExecutionOrder(), undefined)
  assert.ok(fixture.logs.some((entry) => entry[0] === 'warn' && String(entry[1]).includes('auto planning failed')))
})

test('legacy parity helper never synthesizes an unconfigured direct HTTP route', () => {
  const config = {
    providers: [{ provider: 'custom', model: 'generic', fallbacks: [] }],
  }
  assert.equal(
    autoExecutionConfigFor(config, ['http:paid/model', 'custom/generic']),
    undefined,
  )
})
