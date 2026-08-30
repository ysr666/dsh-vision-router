import assert from 'node:assert/strict'
import test from 'node:test'
import { format } from 'node:util'

import { contextWithVisionExecutionPolicy } from '../lib/vision-execution-policy.js'
import { installVisionModelRegistry } from '../lib/vision-model-registry.js'

function captureLogger() {
  const entries = []
  const logger = {}
  for (const level of ['debug', 'info', 'warn', 'error']) {
    logger[level] = (...args) => entries.push({ level, args, text: format(...args) })
  }
  return { logger, entries }
}

function terminalThrow(failure) {
  return (async function* () {
    throw Object.assign(new Error(failure.message), failure)
  })()
}

function unknownModel(provider, model) {
  return {
    message: `pi-ai provider "${provider}" has no configured model "${model}"`,
    code: 'UNKNOWN_MODEL',
  }
}

function diagnosticFixture({ provider = 'zhipu-glm', streamFactory } = {}) {
  const privateConfig = { profiles: () => new Map([[provider, { baseURL: 'https://open.bigmodel.cn/api/paas/v4' }]]) }
  const registration = {
    provider: { id: provider },
    retryPolicy: { maxRetries: 0 },
    adapter: { config: privateConfig },
  }
  const settingsValue = {
    providers: {
      [provider]: {
        baseURL: 'https://open.bigmodel.cn/api/paas/v4',
        api: 'openai-completions',
        apiKeyEnv: 'ZHIPU_GLM_API_KEY',
      },
    },
  }
  const settings = {
    get(namespace) {
      return namespace === 'llm-pi-ai' ? settingsValue : undefined
    },
  }
  let registered
  const tools = {
    register(definition) {
      registered = definition
      return () => {}
    },
  }
  const { logger, entries } = captureLogger()
  const ctx = {
    logger,
    llm: {
      registration() { return registration },
      stream: streamFactory,
    },
    tools,
    get(name) {
      return name === 'settings' ? settings : undefined
    },
    effect() {},
  }
  return {
    ctx,
    logger,
    entries,
    registration,
    getRegistered: () => registered,
  }
}

function messages(entries) {
  return entries.map((entry) => entry.text)
}

test('diagnostics show known-model adapter miss -> bridge attempt -> direct-bridge success', async () => {
  const provider = 'zhipu-glm'
  const model = 'glm-4.6v-flash'
  const fixture = diagnosticFixture({
    provider,
    streamFactory: () => terminalThrow(unknownModel(provider, model)),
  })
  const wrapped = contextWithVisionExecutionPolicy(fixture.ctx, {
    isBridgeEvidence: (candidateProvider, candidateModel) => (
      candidateProvider === provider && candidateModel === model
    ),
    evidenceSource: () => 'known',
    logger: fixture.logger,
  })

  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      await assert.rejects(async () => {
        for await (const _chunk of wrapped.llm.stream({ provider, model, messages: [] })) {}
      }, (error) => error?.code === 'UNKNOWN_MODEL')
      // Existing execution-policy tests already assert the transport view itself.
      // Here we only need to exercise the same registration lookup that the
      // legacy direct bridge performs so the provenance logger marks entry.
      void wrapped.llm.registration(provider)
      return 'direct bridge answer'
    },
  })

  assert.equal(await fixture.getRegistered().execute(), 'direct bridge answer')
  const lines = messages(fixture.entries)
  assert.equal(lines.some((line) => line.includes(`vision backend attempt [${provider}/${model}]`) && line.includes('source=known')), true)
  assert.equal(lines.some((line) => line.includes(`vision backend failed [${provider}/${model}]`) && line.includes('code=UNKNOWN_MODEL') && line.includes('bridge=allow')), true)
  assert.equal(lines.some((line) => line.includes(`vision bridge attempt [${provider}/${model}]`) && line.includes('source=known')), true)
  assert.equal(lines.some((line) => line.includes(`vision backend success [${provider}/${model}] via=direct-bridge`) && line.includes('source=known')), true)
})

test('exact bridge failure persists its kind/detail and later HTTP fallback is not misattributed', async () => {
  const provider = 'zhipu-glm'
  const model = 'glm-4.6v-flash'
  const fixture = diagnosticFixture({
    provider,
    streamFactory: () => terminalThrow(unknownModel(provider, model)),
  })
  const wrapped = contextWithVisionExecutionPolicy(fixture.ctx, {
    isBridgeEvidence: () => true,
    evidenceSource: () => 'known',
    logger: fixture.logger,
  })

  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      await assert.rejects(async () => {
        for await (const _chunk of wrapped.llm.stream({ provider, model, messages: [] })) {}
      })
      void wrapped.llm.registration(provider)
      wrapped.logger.warn(
        'vision-router: vision_describe fallback [%s] (%s, %d ms): %s',
        `${provider}/${model}`,
        'auth',
        167,
        '401: {"error":"invalid api key"}',
      )
      wrapped.logger.warn(
        'vision-router: vision_describe http fallback [%s] (%s, %d ms): %s',
        'http:ovh/Qwen2.5-VL-72B-Instruct',
        'rate_limit',
        2900,
        '429: too many requests',
      )
      return 'fallback answer'
    },
  })

  assert.equal(await fixture.getRegistered().execute(), 'fallback answer')
  const lines = messages(fixture.entries)
  const bridgeFailures = lines.filter((line) => line.includes(`vision bridge failed [${provider}/${model}]`))
  assert.equal(bridgeFailures.length, 1)
  assert.equal(bridgeFailures[0].includes('source=known'), true)
  assert.equal(bridgeFailures[0].includes('kind=auth'), true)
  assert.equal(bridgeFailures[0].includes('401:'), true)
  assert.equal(bridgeFailures[0].includes('429:'), false)
  assert.equal(lines.some((line) => line.includes(`vision backend success [${provider}/${model}] via=direct-bridge`)), false)
})

test('adapter success is logged with provider/model provenance', async () => {
  const provider = 'native-mm'
  const model = 'vision-model'
  const fixture = diagnosticFixture({
    provider,
    streamFactory: () => (async function* () {
      yield { type: 'text-delta', delta: 'ok' }
    })(),
  })
  const wrapped = contextWithVisionExecutionPolicy(fixture.ctx, {
    evidenceSource: () => 'live',
    logger: fixture.logger,
  })
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      for await (const _chunk of wrapped.llm.stream({ provider, model, messages: [] })) {}
      return 'ok'
    },
  })

  assert.equal(await fixture.getRegistered().execute(), 'ok')
  const lines = messages(fixture.entries)
  assert.equal(lines.some((line) => line.includes(`vision backend attempt [${provider}/${model}]`) && line.includes('source=live')), true)
  assert.equal(lines.some((line) => line.includes(`vision backend success [${provider}/${model}] via=adapter`) && line.includes('source=live')), true)
})

test('private model registry reports live vs known evidence without promoting saved-only ids', () => {
  const active = new Set(['zhipu-glm'])
  const settings = {
    get(namespace) {
      if (namespace === 'llm-pi-ai') {
        return {
          providers: {
            'zhipu-glm': {
              baseURL: 'https://open.bigmodel.cn/api/paas/v4',
              api: 'openai-completions',
            },
          },
        }
      }
      if (namespace === 'vision-router') {
        return { providers: [{ provider: 'zhipu-glm', model: 'saved-only', fallbacks: [] }] }
      }
      return undefined
    },
  }
  const effects = []
  const ctx = {
    get(name) { return name === 'settings' ? settings : undefined },
    llm: {
      registration(provider) {
        if (!active.has(provider)) throw new Error('unknown provider')
        return { provider: { id: provider } }
      },
    },
    effect(factory) {
      const dispose = factory()
      effects.push(dispose)
      return dispose
    },
  }
  const manager = {
    async snapshot() { return { ok: true, version: 1, refreshing: false, providers: [] } },
    hasModel(provider, model) {
      return provider === 'zhipu-glm' && model === 'live-only'
    },
  }

  installVisionModelRegistry(ctx, manager)
  assert.equal(manager.evidenceSource('zhipu-glm', 'live-only'), 'live')
  assert.equal(manager.evidenceSource('zhipu-glm', 'glm-4.6v-flash'), 'known')
  assert.equal(manager.evidenceSource('zhipu-glm', 'saved-only'), undefined)
  assert.equal(manager.evidenceSource('zhipu-glm', 'made-up'), undefined)

  effects[0]()
  assert.equal(manager.evidenceSource, undefined)
})
