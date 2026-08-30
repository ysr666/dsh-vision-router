import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bridgeDispositionForFailure,
  bridgeDispositionForObservedFailure,
  contextWithVisionExecutionPolicy,
  isLocalImageCapabilityAdmissionFailure,
  isLocalUnknownModelFailure,
} from '../lib/vision-execution-policy.js'

const localAdmission = (model = 'doubao-seed-2-1-turbo-260628') => ({
  message: `pi-ai model "${model}" does not support image input`,
  code: 'UNSUPPORTED_CONTENT',
})

const unknownModel = (provider = 'doubao', model = 'seed-live-only') => ({
  message: `pi-ai provider "${provider}" has no configured model "${model}"`,
  code: 'UNKNOWN_MODEL',
})

test('only the exact pi-ai pre-wire image-capability rejection authorizes a bridge', () => {
  assert.equal(isLocalImageCapabilityAdmissionFailure(localAdmission()), true)
  assert.equal(
    isLocalImageCapabilityAdmissionFailure({
      message: 'pi-ai image input requires the durable attachment service',
      code: 'UNSUPPORTED_CONTENT',
    }),
    false,
  )
  assert.equal(
    isLocalImageCapabilityAdmissionFailure({
      ...localAdmission(),
      status: 400,
    }),
    false,
  )
  assert.equal(
    isLocalImageCapabilityAdmissionFailure({
      message: 'provider rejected image input',
      code: 'INVALID_REQUEST',
      status: 400,
    }),
    false,
  )
  assert.equal(bridgeDispositionForFailure(localAdmission()), 'allow')
  assert.equal(bridgeDispositionForFailure({ message: 'fetch failed', code: 'NETWORK' }), 'deny')
})

test('UNKNOWN_MODEL recognition is exact and does not trust provider-side errors', () => {
  assert.equal(isLocalUnknownModelFailure(unknownModel(), 'doubao', 'seed-live-only'), true)
  assert.equal(isLocalUnknownModelFailure({ ...unknownModel(), status: 404 }, 'doubao', 'seed-live-only'), false)
  assert.equal(isLocalUnknownModelFailure(unknownModel('other', 'seed-live-only'), 'doubao', 'seed-live-only'), false)
  assert.equal(isLocalUnknownModelFailure({ message: 'unknown model', code: 'UNKNOWN_MODEL' }, 'doubao', 'seed-live-only'), false)
})

test('observed failure classification admits UNKNOWN_MODEL only with exact bridge evidence', () => {
  assert.equal(
    bridgeDispositionForObservedFailure(
      unknownModel('zhipu-glm', 'glm-4.6v-flash'),
      'zhipu-glm',
      'glm-4.6v-flash',
      (provider, model) => provider === 'zhipu-glm' && model === 'glm-4.6v-flash',
    ),
    'allow',
  )
  assert.equal(
    bridgeDispositionForObservedFailure(
      unknownModel('zhipu-glm', 'glm-4.6v-flash'),
      'zhipu-glm',
      'glm-4.6v-flash',
      () => false,
    ),
    'deny',
  )
})

function fakeContext(streamFactory) {
  const privateConfig = { profiles: () => new Map([['doubao', { baseURL: 'https://example.invalid/v1' }]]) }
  const registration = {
    provider: { id: 'doubao' },
    retryPolicy: { maxRetries: 0 },
    adapter: {
      config: privateConfig,
    },
  }
  const settingsValue = {
    providers: {
      doubao: {
        baseURL: 'https://example.invalid/v1',
        api: 'openai-completions',
        apiKeyEnv: 'DOUBAO_API_KEY',
      },
    },
  }
  const settings = {
    get(namespace) {
      return namespace === 'llm-pi-ai' ? settingsValue : undefined
    },
  }
  const llm = {
    registration() {
      return registration
    },
    stream: streamFactory,
  }
  let registered
  const tools = {
    register(definition) {
      registered = definition
      return () => {}
    },
  }
  const ctx = {
    llm,
    tools,
    get(name) {
      return name === 'settings' ? settings : undefined
    },
    effect() {},
  }
  return { ctx, registration, settingsValue, getRegistered: () => registered }
}

function terminalFailureStream(failure) {
  return (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure } }
  })()
}

function thrownFailureStream(failure) {
  return (async function* () {
    throw Object.assign(new Error(failure.message), failure)
  })()
}

test('a real provider failure hides both raw and resolved bridge transport inside the same vision tool', async () => {
  const fixture = fakeContext(() => terminalFailureStream({
    message: 'provider returned 400 invalid_request',
    code: 'INVALID_REQUEST',
    status: 400,
  }))
  const wrapped = contextWithVisionExecutionPolicy(fixture.ctx)
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      for await (const _chunk of wrapped.llm.stream({ provider: 'doubao', model: 'seed', messages: [] })) {
        // consume the terminal failure chunk exactly like the core assembler
      }
      const registration = wrapped.llm.registration('doubao')
      const raw = wrapped.get('settings').get('llm-pi-ai')
      return {
        privateConfigVisible: registration.adapter.config !== undefined,
        rawProviderVisible: raw.providers.doubao !== undefined,
      }
    },
  })
  const result = await fixture.getRegistered().execute()
  assert.deepEqual(result, { privateConfigVisible: false, rawProviderVisible: false })
  // Host-owned objects are never mutated by the private context view.
  assert.equal(fixture.registration.adapter.config !== undefined, true)
  assert.equal(fixture.settingsValue.providers.doubao !== undefined, true)
})

test('the exact local image admission failure keeps bridge transport visible', async () => {
  const fixture = fakeContext(() => terminalFailureStream(localAdmission('seed')))
  const wrapped = contextWithVisionExecutionPolicy(fixture.ctx)
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      for await (const _chunk of wrapped.llm.stream({ provider: 'doubao', model: 'seed', messages: [] })) {
        // consume terminal failure
      }
      return {
        privateConfigVisible: wrapped.llm.registration('doubao').adapter.config !== undefined,
        rawProviderVisible:
          wrapped.get('settings').get('llm-pi-ai').providers.doubao !== undefined,
      }
    },
  })
  const result = await fixture.getRegistered().execute()
  assert.deepEqual(result, { privateConfigVisible: true, rawProviderVisible: true })
})

test('live endpoint evidence authorizes only the exact local UNKNOWN_MODEL pair', async () => {
  const fixture = fakeContext(() => terminalFailureStream(unknownModel()))
  const denied = contextWithVisionExecutionPolicy(fixture.ctx, {
    isLiveDiscovered: () => false,
  })
  denied.tools.register({
    name: 'vision_describe',
    async execute() {
      for await (const _chunk of denied.llm.stream({ provider: 'doubao', model: 'seed-live-only', messages: [] })) {}
      return denied.llm.registration('doubao').adapter.config !== undefined
    },
  })
  assert.equal(await fixture.getRegistered().execute(), false)

  const fixtureAllowed = fakeContext(() => terminalFailureStream(unknownModel()))
  const allowed = contextWithVisionExecutionPolicy(fixtureAllowed.ctx, {
    isLiveDiscovered: (provider, model) => provider === 'doubao' && model === 'seed-live-only',
  })
  allowed.tools.register({
    name: 'vision_describe',
    async execute() {
      for await (const _chunk of allowed.llm.stream({ provider: 'doubao', model: 'seed-live-only', messages: [] })) {}
      return allowed.llm.registration('doubao').adapter.config !== undefined
    },
  })
  assert.equal(await fixtureAllowed.getRegistered().execute(), true)
})

test('thrown UNKNOWN_MODEL keeps bridge transport visible only with trusted evidence', async () => {
  const failure = unknownModel('doubao', 'seed-live-only')
  const deniedFixture = fakeContext(() => thrownFailureStream(failure))
  const denied = contextWithVisionExecutionPolicy(deniedFixture.ctx, {
    isBridgeEvidence: () => false,
  })
  denied.tools.register({
    name: 'vision_describe',
    async execute() {
      await assert.rejects(async () => {
        for await (const _chunk of denied.llm.stream({ provider: 'doubao', model: 'seed-live-only', messages: [] })) {}
      }, (error) => error?.code === 'UNKNOWN_MODEL')
      return denied.llm.registration('doubao').adapter.config !== undefined
    },
  })
  assert.equal(await deniedFixture.getRegistered().execute(), false)

  const allowedFixture = fakeContext(() => thrownFailureStream(failure))
  const allowed = contextWithVisionExecutionPolicy(allowedFixture.ctx, {
    isBridgeEvidence: (provider, model) => provider === 'doubao' && model === 'seed-live-only',
  })
  allowed.tools.register({
    name: 'vision_describe',
    async execute() {
      await assert.rejects(async () => {
        for await (const _chunk of allowed.llm.stream({ provider: 'doubao', model: 'seed-live-only', messages: [] })) {}
      }, (error) => error?.code === 'UNKNOWN_MODEL')
      return {
        privateConfigVisible: allowed.llm.registration('doubao').adapter.config !== undefined,
        rawProviderVisible: allowed.get('settings').get('llm-pi-ai').providers.doubao !== undefined,
      }
    },
  })
  assert.deepEqual(await allowedFixture.getRegistered().execute(), {
    privateConfigVisible: true,
    rawProviderVisible: true,
  })
})

test('thrown exact local image admission still authorizes the compatibility bridge', async () => {
  const fixture = fakeContext(() => thrownFailureStream(localAdmission('seed')))
  const wrapped = contextWithVisionExecutionPolicy(fixture.ctx)
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      await assert.rejects(async () => {
        for await (const _chunk of wrapped.llm.stream({ provider: 'doubao', model: 'seed', messages: [] })) {}
      }, (error) => error?.code === 'UNSUPPORTED_CONTENT')
      return wrapped.llm.registration('doubao').adapter.config !== undefined
    },
  })
  assert.equal(await fixture.getRegistered().execute(), true)
})

test('thrown provider-side errors remain fail-closed and cannot trigger a second transport', async () => {
  const failure = {
    message: 'provider returned 400 invalid_request',
    code: 'INVALID_REQUEST',
    status: 400,
  }
  const fixture = fakeContext(() => thrownFailureStream(failure))
  const wrapped = contextWithVisionExecutionPolicy(fixture.ctx, {
    isBridgeEvidence: () => true,
  })
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      await assert.rejects(async () => {
        for await (const _chunk of wrapped.llm.stream({ provider: 'doubao', model: 'seed', messages: [] })) {}
      }, (error) => error?.code === 'INVALID_REQUEST')
      return wrapped.llm.registration('doubao').adapter.config !== undefined
    },
  })
  assert.equal(await fixture.getRegistered().execute(), false)
})

test('synchronous pre-wire UNKNOWN_MODEL receives the same evidence policy', async () => {
  const failure = unknownModel('doubao', 'seed-live-only')
  const fixture = fakeContext(() => {
    throw Object.assign(new Error(failure.message), failure)
  })
  const wrapped = contextWithVisionExecutionPolicy(fixture.ctx, {
    isBridgeEvidence: () => true,
  })
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      await assert.rejects(async () => {
        for await (const _chunk of wrapped.llm.stream({ provider: 'doubao', model: 'seed-live-only', messages: [] })) {}
      }, (error) => error?.code === 'UNKNOWN_MODEL')
      return wrapped.llm.registration('doubao').adapter.config !== undefined
    },
  })
  assert.equal(await fixture.getRegistered().execute(), true)
})

test('policy state is isolated to vision tool execution and reset by the next adapter attempt', async () => {
  let attempt = 0
  const fixture = fakeContext(() => {
    attempt += 1
    return attempt === 1
      ? terminalFailureStream({ message: 'network failed', code: 'NETWORK' })
      : terminalFailureStream(localAdmission('seed'))
  })
  const wrapped = contextWithVisionExecutionPolicy(fixture.ctx)
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      for await (const _chunk of wrapped.llm.stream({ provider: 'doubao', model: 'seed', messages: [] })) {}
      assert.equal(wrapped.llm.registration('doubao').adapter.config, undefined)
      for await (const _chunk of wrapped.llm.stream({ provider: 'doubao', model: 'seed', messages: [] })) {}
      assert.notEqual(wrapped.llm.registration('doubao').adapter.config, undefined)
      return 'ok'
    },
  })
  assert.equal(await fixture.getRegistered().execute(), 'ok')
  // Outside a vision tool there is no execution-policy scope.
  assert.notEqual(wrapped.llm.registration('doubao').adapter.config, undefined)
})
