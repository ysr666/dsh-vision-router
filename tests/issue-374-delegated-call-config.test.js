import assert from 'node:assert/strict'
import test from 'node:test'

import { contextWithAgentRequestRouteAuthority } from '../lib/agent-request-route-authority.js'
import { projectDelegatedCallConfig } from '../lib/delegated-call-config.js'
import { installVisionToolRuntimeBoundary } from '../lib/vision-tool-runtime-boundary.js'

const VISION_ROUTER_ADAPTER_OWNER = Symbol.for('dsh-vision-router.adapter-owner')

function finishStream() {
  return (async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

async function drain(iterable) {
  for await (const _chunk of iterable) {
    // Drain the stream so AsyncLocalStorage-backed adapter delegation runs.
  }
}

function markOwned(adapter) {
  Object.defineProperty(adapter, VISION_ROUTER_ADAPTER_OWNER, {
    configurable: true,
    enumerable: true,
    value: Object.freeze({}),
  })
  return adapter
}

test('delegated projection removes source-route call config and preserves request payload/lifecycle', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'look' }] }]
  const tools = [{ name: 'tool', description: 'x', parameters: {} }]
  const signal = new AbortController().signal
  const source = Object.freeze({
    provider: 'source',
    model: 'source-model',
    reasoningEffort: 'max',
    temperature: 0.7,
    maxTokens: 4096,
    stop: ['END'],
    messages,
    system: 'system',
    tools,
    signal,
    sessionId: 'session-1',
    purpose: 'session-title',
  })

  const projected = projectDelegatedCallConfig(source)

  assert.notEqual(projected, source)
  assert.equal(projected.provider, 'source')
  assert.equal(projected.model, 'source-model')
  assert.equal(projected.messages, messages)
  assert.equal(projected.system, 'system')
  assert.equal(projected.tools, tools)
  assert.equal(projected.signal, signal)
  assert.equal(projected.sessionId, 'session-1')
  assert.equal(projected.purpose, 'session-title')
  assert.equal(Object.hasOwn(projected, 'reasoningEffort'), false)
  assert.equal(Object.hasOwn(projected, 'temperature'), false)
  assert.equal(Object.hasOwn(projected, 'maxTokens'), false)
  assert.equal(Object.hasOwn(projected, 'stop'), false)
  assert.equal(source.maxTokens, 4096, 'projection must never mutate frozen caller requests')
})

test('vision tool adapter calls omit generic 4096 so the target adapter can materialize its own default', async () => {
  let registered
  let seen
  let wrapped
  const ctx = {
    tools: {
      register(def) {
        registered = def
        return () => {}
      },
    },
    llm: {
      stream(options) {
        seen = options
        return finishStream()
      },
    },
  }
  wrapped = installVisionToolRuntimeBoundary(ctx, { cache: false })
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      await drain(wrapped.llm.stream({
        provider: 'zhipu',
        model: 'glm-4v-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }] }],
        maxTokens: 4096,
        reasoningEffort: 'max',
        temperature: 0.3,
        stop: ['END'],
      }))
      return 'ok'
    },
  })

  await registered.execute({}, {})

  assert.equal(seen.provider, 'zhipu')
  assert.equal(seen.model, 'glm-4v-flash')
  assert.equal(Object.hasOwn(seen, 'maxTokens'), false)
  assert.equal(Object.hasOwn(seen, 'reasoningEffort'), false)
  assert.equal(Object.hasOwn(seen, 'temperature'), false)
  assert.equal(Object.hasOwn(seen, 'stop'), false)
})

test('Vision Chain nested adapter calls re-enter target call-config authority instead of forwarding outer options', async () => {
  const adapters = new Map()
  let delegated
  let wrapped
  const ctx = {
    llm: {
      registerAdapter(routes, adapter) {
        for (const route of routes) adapters.set(route, adapter)
        return () => {}
      },
      stream(options) {
        delegated = options
        return finishStream()
      },
    },
  }
  wrapped = installVisionToolRuntimeBoundary(ctx)
  wrapped.llm.registerAdapter(['vision-chain'], {
    providerInfo(provider) {
      return { id: provider, name: 'Vision Chain' }
    },
    async *stream(options) {
      yield* wrapped.llm.stream({
        ...options,
        provider: 'zhipu',
        model: 'glm-4v-flash',
        maxTokens: 65536,
        reasoningEffort: 'high',
        temperature: 0.9,
        stop: ['SOURCE_ONLY'],
      })
    },
  })

  await drain(adapters.get('vision-chain').stream({
    provider: 'vision-chain',
    model: 'zhipu/glm-4v-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'image turn' }] }],
    system: 'keep task semantics',
    tools: [{ name: 'vision_crop', description: 'crop', parameters: {} }],
    maxTokens: 65536,
    temperature: 1,
  }))

  assert.equal(delegated.provider, 'zhipu')
  assert.equal(delegated.model, 'glm-4v-flash')
  assert.equal(delegated.system, 'keep task semantics')
  assert.equal(delegated.tools[0].name, 'vision_crop')
  assert.equal(Object.hasOwn(delegated, 'maxTokens'), false)
  assert.equal(Object.hasOwn(delegated, 'reasoningEffort'), false)
  assert.equal(Object.hasOwn(delegated, 'temperature'), false)
  assert.equal(Object.hasOwn(delegated, 'stop'), false)
})

test('Vision Router-owned transparent wrappers preserve caller config and scope reasoning memory per session', async () => {
  const adapters = new Map()
  const delegated = []
  let wrapped
  let staleWrapperEffort
  const ctx = {
    llm: {
      registerAdapter(routes, adapter) {
        for (const route of routes) adapters.set(route, adapter)
        return () => {}
      },
      stream(options) {
        delegated.push(options)
        return finishStream()
      },
    },
  }
  wrapped = installVisionToolRuntimeBoundary(ctx)
  wrapped.llm.registerAdapter(['third-party-vision'], markOwned({
    providerInfo(provider) {
      return { id: provider, name: 'Third Party + 自动识图' }
    },
    async *stream(options) {
      if (options.reasoningEffort !== undefined) staleWrapperEffort = options.reasoningEffort
      yield* wrapped.llm.stream({
        ...options,
        provider: 'third-party',
        reasoningEffort: options.reasoningEffort ?? staleWrapperEffort,
      })
    },
  }))

  const twin = adapters.get('third-party-vision')
  await drain(twin.stream({
    provider: 'third-party-vision',
    model: 'm',
    sessionId: 's1',
    messages: [],
    reasoningEffort: 'high',
    maxTokens: 777,
    temperature: 0.25,
    stop: ['DONE'],
  }))
  await drain(twin.stream({
    provider: 'third-party-vision',
    model: 'm',
    sessionId: 's2',
    messages: [],
    reasoningEffort: 'low',
  }))
  // Core's legacy provider/model-only cache would inject s2's `low` here.
  // The runtime boundary must recover s1's picker state instead.
  await drain(twin.stream({
    provider: 'third-party-vision',
    model: 'm',
    sessionId: 's1',
    messages: [],
  }))
  // A one-shot request with no session proof must not inherit any old effort.
  await drain(twin.stream({
    provider: 'third-party-vision',
    model: 'm',
    messages: [],
  }))

  assert.equal(delegated[0].provider, 'third-party')
  assert.equal(delegated[0].reasoningEffort, 'high')
  assert.equal(delegated[0].maxTokens, 777)
  assert.equal(delegated[0].temperature, 0.25)
  assert.deepEqual(delegated[0].stop, ['DONE'])
  assert.equal(delegated[1].reasoningEffort, 'low')
  assert.equal(delegated[2].reasoningEffort, 'high')
  assert.equal(Object.hasOwn(delegated[3], 'reasoningEffort'), false)
})

test('agent/request provider-model handoff drops source route call config but preserves payload and lifecycle', async () => {
  let registered
  const ctx = {
    on(event, handler) {
      assert.equal(event, 'agent/request')
      registered = handler
      return () => {}
    },
  }
  const wrapped = contextWithAgentRequestRouteAuthority(ctx)
  wrapped.on('agent/request', async (_payload, next) => {
    const source = await next()
    return { ...source, provider: 'zhipu', model: 'glm-4v-flash' }
  })

  const messages = [{ role: 'user', content: [] }]
  const signal = new AbortController().signal
  const source = Object.freeze({
    provider: 'source',
    model: 'text-model',
    reasoningEffort: 'max',
    temperature: 0.8,
    maxTokens: 65536,
    stop: ['SOURCE'],
    messages,
    signal,
    sessionId: 's1',
    purpose: 'chat',
  })
  const result = await registered({}, async () => source)

  assert.equal(result.provider, 'zhipu')
  assert.equal(result.model, 'glm-4v-flash')
  assert.equal(result.messages, messages)
  assert.equal(result.signal, signal)
  assert.equal(result.sessionId, 's1')
  assert.equal(result.purpose, 'chat')
  assert.equal(Object.hasOwn(result, 'reasoningEffort'), false)
  assert.equal(Object.hasOwn(result, 'temperature'), false)
  assert.equal(Object.hasOwn(result, 'maxTokens'), false)
  assert.equal(Object.hasOwn(result, 'stop'), false)
  assert.equal(source.maxTokens, 65536)
})

test('agent/request same-route edits and incomplete route evidence remain caller-owned', async () => {
  let registered
  const ctx = {
    on(_event, handler) {
      registered = handler
      return () => {}
    },
  }
  const wrapped = contextWithAgentRequestRouteAuthority(ctx)
  wrapped.on('agent/request', async (_payload, next) => {
    const source = await next()
    return { ...source, temperature: 0.9 }
  })

  const sameRoute = await registered({}, async () => ({
    provider: 'a',
    model: 'm',
    maxTokens: 123,
  }))
  assert.deepEqual(sameRoute, {
    provider: 'a',
    model: 'm',
    maxTokens: 123,
    temperature: 0.9,
  })

  const incomplete = await registered({}, async () => ({ model: 'm', maxTokens: 456 }))
  assert.deepEqual(incomplete, { model: 'm', maxTokens: 456, temperature: 0.9 })
})

test('ordinary non-delegated llm calls remain byte-for-byte caller-owned', async () => {
  let seen
  const source = {
    provider: 'zhipu',
    model: 'glm-4v-flash',
    messages: [],
    maxTokens: 777,
    temperature: 0.4,
    stop: ['DONE'],
  }
  const ctx = {
    llm: {
      stream(options) {
        seen = options
        return finishStream()
      },
    },
  }
  const wrapped = installVisionToolRuntimeBoundary(ctx)
  await drain(wrapped.llm.stream(source))
  assert.equal(seen, source)
  assert.equal(seen.maxTokens, 777)
  assert.equal(seen.temperature, 0.4)
  assert.deepEqual(seen.stop, ['DONE'])
})
