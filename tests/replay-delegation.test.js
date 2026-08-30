import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  configuredVisionAdapterModels,
  contextWithDelegatedReplay,
  MAX_LIVE_EFFORT_MEMORY,
  rebindDelegatedReplayOptions,
  rebindDelegatedReplaySources,
} from '../lib/replay-delegation.js'

function assistant({
  sourceProvider = 'opencodex-vision',
  sourceModel = 'deepseek-v4-flash',
  replayProvider = 'opencodex',
  replayModel = sourceModel,
  replay = true,
} = {}) {
  return {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'hidden' },
      { type: 'tool-call', id: 't1', name: 'vision_describe', arguments: '{}' },
    ],
    source: {
      kind: 'model',
      provider: sourceProvider,
      model: sourceModel,
      ...(replay
        ? {
            replayState: {
              kind: 'pi-ai',
              provider: replayProvider,
              model: replayModel,
              blocks: [{ type: 'reasoning' }],
            },
          }
        : {}),
    },
  }
}

test('rebindDelegatedReplaySources restores the delegate provider without mutating replay metadata', () => {
  const input = assistant()
  const state = input.source.replayState
  const messages = [input]
  const output = rebindDelegatedReplaySources(messages, 'opencodex')

  assert.notEqual(output, messages)
  assert.notEqual(output[0], input)
  assert.notEqual(output[0].source, input.source)
  assert.equal(output[0].source.provider, 'opencodex')
  assert.equal(output[0].source.replayState, state)
  assert.equal(input.source.provider, 'opencodex-vision')
})

test('rebindDelegatedReplaySources rejects foreign, model-mismatched, replay-less and non-assistant history', () => {
  const cases = [
    assistant({ replayProvider: 'another-provider' }),
    assistant({ replayModel: 'another-model' }),
    assistant({ replay: false }),
    assistant({ sourceProvider: 'opencodex' }),
    {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      source: {
        kind: 'model',
        provider: 'opencodex-vision',
        model: 'deepseek-v4-flash',
        replayState: { provider: 'opencodex', model: 'deepseek-v4-flash' },
      },
    },
  ]
  for (const input of cases) {
    const messages = [input]
    assert.equal(rebindDelegatedReplaySources(messages, 'opencodex'), messages)
  }
})

test('rebindDelegatedReplayOptions only clones request options when a source is actually rebound', () => {
  const unchanged = { provider: 'opencodex', messages: [{ role: 'user', content: [] }] }
  assert.equal(rebindDelegatedReplayOptions(unchanged), unchanged)

  const changed = { provider: 'opencodex', messages: [assistant()], reasoningEffort: 'high' }
  const output = rebindDelegatedReplayOptions(changed)
  assert.notEqual(output, changed)
  assert.equal(output.provider, 'opencodex')
  assert.equal(output.reasoningEffort, 'high')
  assert.equal(output.messages[0].source.provider, 'opencodex')
})

test('contextWithDelegatedReplay scopes rebinding to the context view and preserves llm method receivers', async () => {
  let seen
  const llm = {
    marker: 'original',
    registerAdapter() {
      assert.equal(this, llm)
      return 'registered'
    },
    async *stream(options) {
      assert.equal(this, llm)
      seen = options
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const ctx = {
    llm,
    ping() {
      assert.equal(this, ctx)
      return 'pong'
    },
  }
  const wrapped = contextWithDelegatedReplay(ctx)
  assert.notEqual(wrapped, ctx)
  assert.equal(wrapped.ping(), 'pong')
  assert.equal(wrapped.llm.registerAdapter(), 'registered')

  const input = assistant()
  for await (const _chunk of wrapped.llm.stream({
    provider: 'opencodex',
    model: 'deepseek-v4-flash',
    messages: [input],
  })) {
    // drain
  }
  assert.equal(seen.messages[0].source.provider, 'opencodex')
  assert.equal(input.source.provider, 'opencodex-vision')
  assert.equal(ctx.llm, llm)
  assert.equal(contextWithDelegatedReplay(ctx), wrapped)
})

function liveWrapperHarness({ initialProvider = 'deepseek-official', native = false } = {}) {
  let textProvider = initialProvider
  let registeredAdapter
  const calls = []
  const registrations = new Map()
  registrations.set('deepseek-official', {
    retryPolicy: 'deepseek-retry',
    adapter: {
      async listModels(provider) {
        return [
          { provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', inputModalities: ['text'] },
          { provider, id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', inputModalities: ['text'] },
        ]
      },
      async resolveModel(provider, model) {
        return { provider, id: model, name: model, inputModalities: ['text'] }
      },
    },
  })
  registrations.set('relay-openai', {
    retryPolicy: 'relay-retry',
    adapter: {
      async listModels(provider) {
        return [{ provider, id: 'k3', name: 'Kimi K3', inputModalities: ['text'] }]
      },
      async resolveModel(provider, model) {
        return { provider, id: model, name: model, inputModalities: ['text'] }
      },
    },
  })
  if (native) registrations.set('deepseek-official-native', {})
  const settings = {
    get(namespace) {
      if (namespace !== 'vision-router') return undefined
      return {
        wrapperRoute: 'deepseek-vision',
        textProvider: { provider: textProvider },
      }
    },
  }
  const llm = {
    registration(provider) {
      return registrations.get(provider)
    },
    registerAdapter(providers, adapter) {
      assert.deepEqual(providers, ['deepseek-vision'])
      registeredAdapter = adapter
      return () => {}
    },
    async *stream(options) {
      calls.push(options)
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const ctx = {
    llm,
    get(name) {
      return name === 'settings' ? settings : undefined
    },
  }
  const wrapped = contextWithDelegatedReplay(ctx)

  // Emulate the core wrapper's legacy stale provider/reasoning caches and its
  // old metadata dependence on textProvider. The entry-layer boundary must
  // keep the public DeepSeek identity true at both metadata and network time.
  let staleReasoningEffort
  const coreWrapper = {
    async listModels() {
      return registrations.get(textProvider)?.adapter?.listModels(textProvider) ?? []
    },
    async resolveModel(_provider, model) {
      return registrations.get(textProvider)?.adapter?.resolveModel(textProvider, model)
    },
    providerRetryPolicy() {
      return registrations.get(textProvider)?.retryPolicy
    },
    async *stream(options) {
      const explicit =
        typeof options.reasoningEffort === 'string' && options.reasoningEffort !== ''
          ? options.reasoningEffort
          : undefined
      if (explicit !== undefined) staleReasoningEffort = explicit
      const effort = explicit ?? staleReasoningEffort
      yield* wrapped.llm.stream({
        ...options,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        provider: textProvider,
      })
    },
  }
  wrapped.llm.registerAdapter(['deepseek-vision'], coreWrapper)

  const drain = async (options = {}) => {
    for await (const _chunk of registeredAdapter.stream({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      sessionId: 'session-a',
      ...options,
    })) {
      // drain
    }
  }
  return {
    calls,
    drain,
    adapter: () => registeredAdapter,
    setProvider(value) { textProvider = value },
  }
}

test('main DeepSeek auto-vision wrapper never follows an arbitrary live textProvider', async () => {
  const harness = liveWrapperHarness()
  await harness.drain({ reasoningEffort: 'high' })
  harness.setProvider('relay-openai')
  await harness.drain({})
  await harness.drain({ reasoningEffort: 'low' })
  harness.setProvider('deepseek-official')
  await harness.drain({})

  assert.deepEqual(harness.calls.map((call) => call.provider), [
    'deepseek-official',
    'deepseek-official',
    'deepseek-official',
    'deepseek-official',
  ])
  assert.deepEqual(harness.calls.map((call) => call.reasoningEffort), [
    'high',
    'high',
    'low',
    'low',
  ])
})

test('main wrapper metadata stays DeepSeek even when textProvider is a Kimi/relay route', async () => {
  const harness = liveWrapperHarness({ initialProvider: 'relay-openai' })
  const adapter = harness.adapter()
  const listed = await adapter.listModels('deepseek-vision')
  assert.deepEqual(listed.map((model) => model.id), ['deepseek-v4-pro', 'deepseek-v4-flash'])
  assert.ok(listed.every((model) => model.provider === 'deepseek-vision'))
  assert.ok(listed.every((model) => model.inputModalities.includes('image')))

  const resolved = await adapter.resolveModel('deepseek-vision', 'deepseek-v4-pro')
  assert.equal(resolved.provider, 'deepseek-vision')
  assert.equal(resolved.id, 'deepseek-v4-pro')
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
  assert.equal(adapter.providerRetryPolicy('deepseek-vision'), 'deepseek-retry')
})

test('main wrapper listModels restores only config-driven composite rows while pinning DeepSeek mirrors', async () => {
  let routingEnabled = false
  let registeredAdapter
  const registeredTools = new Map()
  const networkCalls = []
  const registrations = new Map()
  registrations.set('deepseek-official', {
    retryPolicy: 'deepseek-retry',
    adapter: {
      async listModels(provider) {
        return [
          { provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', inputModalities: ['text'] },
          { provider, id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', inputModalities: ['text'] },
        ]
      },
    },
  })
  registrations.set('kimi-coding', {
    adapter: {
      async listModels(provider) {
        return [{ provider, id: 'k3', name: 'Kimi K3', inputModalities: ['text', 'image'] }]
      },
    },
  })
  registrations.set('xiaomi-token-plan-cn', {
    adapter: {
      async listModels(provider) {
        return [{ provider, id: 'xiaomi-vision', name: 'Xiaomi Vision', inputModalities: ['text', 'image'] }]
      },
    },
  })
  const settings = {
    get(namespace) {
      if (namespace !== 'vision-router') return undefined
      return {
        wrapperRoute: 'deepseek-vision',
        routing: routingEnabled,
        textProvider: { provider: 'relay-openai' },
        providers: [{ provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: [] }],
      }
    },
  }
  const llm = {
    registration(provider) {
      return registrations.get(provider)
    },
    listProviders() {
      // Host-wide DSH catalog: Kimi/Xiaomi are configured in DSH but are NOT
      // authorized in Vision Router.
      return [
        { id: 'kimi-coding', name: 'Kimi' },
        { id: 'xiaomi-token-plan-cn', name: 'Xiaomi' },
        { id: 'zhipu', name: 'Zhipu' },
      ]
    },
    registerAdapter(_providers, adapter) {
      registeredAdapter = adapter
      return () => {}
    },
    async *stream(options) {
      networkCalls.push(options)
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const tools = {
    register(definition) {
      registeredTools.set(definition.name, definition)
      return () => {}
    },
  }
  const ctx = {
    llm,
    tools,
    get(name) {
      return name === 'settings' ? settings : undefined
    },
  }
  const wrapped = contextWithDelegatedReplay(ctx)

  // Core-like wrapper. Like the real core it mirrors only the two DeepSeek
  // ids from the (stale) relay catalog, and appends config-driven composite
  // rows only when whole-turn routing is on. It deliberately leaks a stray
  // non-composite Kimi row to prove the boundary drops it.
  const coreWrapper = {
    async listModels() {
      const rows = [
        { provider: 'deepseek-vision', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', inputModalities: ['text', 'image'] },
        { provider: 'deepseek-vision', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', inputModalities: ['text', 'image'] },
      ]
      if (routingEnabled) {
        rows.push(
          {
            provider: 'deepseek-vision',
            id: 'zhipu/glm-4.6v-flash',
            name: 'zhipu/glm-4.6v-flash（视觉）',
            inputModalities: ['text', 'image'],
          },
          { provider: 'deepseek-vision', id: 'k3', name: 'Kimi K3', inputModalities: ['text', 'image'] },
        )
      }
      return rows
    },
    async resolveModel(_provider, model) {
      return { provider: 'deepseek-vision', id: model, name: model, inputModalities: ['text', 'image'] }
    },
    providerRetryPolicy() {
      return 'deepseek-retry'
    },
    async *stream(options) {
      yield* wrapped.llm.stream(options)
    },
  }
  wrapped.llm.registerAdapter(['deepseek-vision'], coreWrapper)

  // routing=false: pinned official DeepSeek only, no composite noise.
  const listedOff = await registeredAdapter.listModels('deepseek-vision')
  assert.deepEqual(listedOff.map((model) => model.id), ['deepseek-v4-pro', 'deepseek-v4-flash'])
  assert.ok(listedOff.every((model) => model.provider === 'deepseek-vision'))
  assert.ok(listedOff.every((model) => model.inputModalities.includes('image')))

  // routing=true: the authorized composite row joins the pinned mirrors; the
  // stray non-composite Kimi row and any DSH-only provider never appear.
  routingEnabled = true
  const listedOn = await registeredAdapter.listModels('deepseek-vision')
  const idsOn = listedOn.map((model) => model.id)
  assert.ok(idsOn.includes('deepseek-v4-pro') && idsOn.includes('deepseek-v4-flash'))
  assert.ok(idsOn.includes('zhipu/glm-4.6v-flash'), 'authorized composite row kept')
  assert.ok(!idsOn.includes('k3'), 'stray non-composite row dropped')
  assert.ok(!idsOn.some((id) => id.includes('kimi') || id.includes('xiaomi')), 'DSH-only providers never listed')

  // P0 surface stays intact during a vision tool call: host-wide discovery is
  // hidden, and an unauthorized DSH system model cannot produce a network call.
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      assert.deepEqual(wrapped.llm.listProviders(), [], 'host catalog hidden inside a vision tool')
      await assert.rejects(
        (async () => {
          for await (const _chunk of wrapped.llm.stream({ provider: 'kimi-coding', model: 'k3', messages: [] })) {
            // drain
          }
        })(),
        (error) => error && error.code === 'NO_ADAPTER',
        'unauthorized system model must be denied at the stream gate',
      )
    },
  })
  await registeredTools.get('vision_describe').execute()
  assert.equal(networkCalls.length, 0, 'no network call for DSH-only providers')
})

test('hidden native DeepSeek route owns the main wrapper regardless of textProvider', async () => {
  const harness = liveWrapperHarness({ initialProvider: 'relay-openai', native: true })
  await harness.drain({ reasoningEffort: 'high' })
  harness.setProvider('deepseek-official')
  await harness.drain({})
  assert.deepEqual(harness.calls.map((call) => call.provider), [
    'deepseek-official-native',
    'deepseek-official-native',
  ])
  assert.deepEqual(harness.calls.map((call) => call.reasoningEffort), ['high', 'high'])
})

test('reasoning effort memory is isolated by DSH sessionId even when core cache is globally stale', async () => {
  const harness = liveWrapperHarness()
  await harness.drain({ sessionId: 'session-a', reasoningEffort: 'high' })
  await harness.drain({ sessionId: 'session-b', reasoningEffort: 'low' })
  await harness.drain({ sessionId: 'session-a' })
  await harness.drain({ sessionId: 'session-b' })
  assert.deepEqual(harness.calls.map((call) => call.reasoningEffort), [
    'high',
    'low',
    'high',
    'low',
  ])
})

test('requests without sessionId do not inherit provider/model reasoning state', async () => {
  const harness = liveWrapperHarness()
  await harness.drain({ sessionId: undefined, reasoningEffort: 'high' })
  await harness.drain({ sessionId: undefined })
  assert.deepEqual(harness.calls.map((call) => call.reasoningEffort), ['high', undefined])
})

test('reasoning effort memory is capped so long-running processes cannot grow it without bound', async () => {
  const harness = liveWrapperHarness()
  const total = MAX_LIVE_EFFORT_MEMORY + 10
  for (let i = 0; i < total; i++) {
    await harness.drain({ sessionId: `session-${i}`, reasoningEffort: 'high' })
  }
  await harness.drain({ sessionId: 'session-0' })
  const evicted = harness.calls[harness.calls.length - 1]
  assert.equal(evicted.reasoningEffort, undefined)
  await harness.drain({ sessionId: `session-${total - 1}` })
  const hot = harness.calls[harness.calls.length - 1]
  assert.equal(hot.reasoningEffort, 'high')
})

test('configuredVisionAdapterModels grants only exact Vision Router rows and row fallbacks', () => {
  const allowed = configuredVisionAdapterModels({
    providers: [
      { provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: ['glm-4v-flash'] },
      { provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] },
    ],
  })
  assert.deepEqual([...allowed.keys()], ['zhipu'])
  assert.deepEqual([...allowed.get('zhipu')], ['glm-4.6v-flash', 'glm-4v-flash'])
  assert.equal(allowed.has('vision-http'), false)
  assert.equal(allowed.has('kimi-coding'), false)
})

test('vision tools cannot auto-discover or call DSH system models that were not selected in Vision Router', async () => {
  let visionConfig = {
    providers: [{ provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: [] }],
  }
  const calls = []
  const registeredTools = new Map()
  const llm = {
    listProviders() {
      return [
        { id: 'kimi-coding', name: 'Kimi' },
        { id: 'xiaomi-token-plan-cn', name: 'Xiaomi' },
        { id: 'zhipu', name: 'Zhipu' },
      ]
    },
    registration(provider) {
      return {
        adapter: {
          async listModels() {
            return provider === 'kimi-coding'
              ? [{ id: 'k3', provider, inputModalities: ['text', 'image'] }]
              : [{ id: 'glm-4.6v-flash', provider, inputModalities: ['text', 'image'] }]
          },
        },
      }
    },
    async *stream(options) {
      calls.push(options)
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const tools = {
    register(definition) {
      registeredTools.set(definition.name, definition)
      return () => {}
    },
  }
  const ctx = {
    llm,
    tools,
    get(name) {
      if (name !== 'settings') return undefined
      return {
        get(namespace) {
          return namespace === 'vision-router' ? visionConfig : undefined
        },
      }
    },
  }
  const wrapped = contextWithDelegatedReplay(ctx, { visionConfig })
  assert.deepEqual(wrapped.llm.listProviders().map((entry) => entry.id), [
    'kimi-coding',
    'xiaomi-token-plan-cn',
    'zhipu',
  ])

  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      const discoveredInside = wrapped.llm.listProviders()
      // Mutating settings after the tool starts must not expand this call's
      // frozen authorization snapshot.
      visionConfig = {
        providers: [{ provider: 'kimi-coding', model: 'k3', fallbacks: [] }],
      }
      let blocked
      try {
        for await (const _chunk of wrapped.llm.stream({
          provider: 'kimi-coding',
          model: 'k3',
          messages: [],
        })) {
          // drain
        }
      } catch (error) {
        blocked = error
      }
      for await (const _chunk of wrapped.llm.stream({
        provider: 'zhipu',
        model: 'glm-4.6v-flash',
        messages: [],
      })) {
        // drain
      }
      return { discoveredInside, blocked }
    },
  })

  const result = await registeredTools.get('vision_describe').execute()
  assert.deepEqual(result.discoveredInside, [])
  assert.equal(result.blocked?.code, 'NO_ADAPTER')
  assert.match(result.blocked?.message ?? '', /blocked unconfigured vision backend/)
  assert.deepEqual(calls.map((call) => `${call.provider}/${call.model}`), [
    'zhipu/glm-4.6v-flash',
  ])
})

test('a system model becomes callable by a vision tool only after explicit Vision Router selection', async () => {
  const calls = []
  let captured
  const llm = {
    listProviders: () => [{ id: 'kimi-coding', name: 'Kimi' }],
    async *stream(options) {
      calls.push(options)
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const tools = {
    register(definition) {
      captured = definition
      return () => {}
    },
  }
  const ctx = { llm, tools }
  const wrapped = contextWithDelegatedReplay(ctx, {
    visionConfig: {
      providers: [{ provider: 'kimi-coding', model: 'k3', fallbacks: [] }],
    },
  })
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      for await (const _chunk of wrapped.llm.stream({
        provider: 'kimi-coding',
        model: 'k3',
        messages: [],
      })) {
        // drain
      }
      return 'ok'
    },
  })
  assert.equal(await captured.execute(), 'ok')
  assert.deepEqual(calls.map((call) => `${call.provider}/${call.model}`), ['kimi-coding/k3'])
})

test('delegated replay context cache expires with the Cordis plugin fiber', () => {
  let cleanup
  const llm = { registerAdapter() {}, stream() {} }
  const ctx = {
    llm,
    effect(factory) {
      cleanup = factory()
      return () => {}
    },
  }
  const first = contextWithDelegatedReplay(ctx)
  assert.equal(contextWithDelegatedReplay(ctx), first)
  assert.equal(typeof cleanup, 'function')
  cleanup()
  const second = contextWithDelegatedReplay(ctx)
  assert.notEqual(second, first)
})

test('only the configured main wrapper route gets fixed DeepSeek delegate rewriting', async () => {
  let registeredAdapter
  let seen
  const llm = {
    registerAdapter(_providers, adapter) {
      registeredAdapter = adapter
      return () => {}
    },
    registration() {
      return undefined
    },
    async *stream(options) {
      seen = options
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const ctx = {
    llm,
    get(name) {
      if (name !== 'settings') return undefined
      return {
        get(namespace) {
          return namespace === 'vision-router'
            ? { wrapperRoute: 'custom-wrapper', textProvider: { provider: 'relay-openai' } }
            : undefined
        },
      }
    },
  }
  const wrapped = contextWithDelegatedReplay(ctx, { wrapperRoute: 'custom-wrapper' })
  const ordinaryAdapter = {
    async *stream(options) {
      yield* wrapped.llm.stream({ ...options, provider: 'original-provider' })
    },
  }
  wrapped.llm.registerAdapter(['some-provider-vision'], ordinaryAdapter)

  for await (const _chunk of registeredAdapter.stream({
    model: 'm',
    messages: [{ role: 'user', content: [] }],
  })) {
    // drain
  }
  assert.equal(seen.provider, 'original-provider')
})
