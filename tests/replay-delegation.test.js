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
          { provider, id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', inputModalities: ['text', 'image'] },
          { provider, id: 'deepseek-v4.1-flash-expires-on-0910', name: 'DeepSeek V4.1 Flash', inputModalities: ['text'] },
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

  // Emulate a stale/regressed core wrapper with provider/reasoning caches and
  // old metadata dependence on textProvider. The entry-layer boundary remains
  // defense in depth and must keep the public DeepSeek identity true at both
  // metadata and network time even after the core itself is fixed.
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

test('issues #469/#479: main wrapper mirrors the live official DeepSeek catalog even when textProvider is a relay', async () => {
  const harness = liveWrapperHarness({ initialProvider: 'relay-openai' })
  const adapter = harness.adapter()
  const listed = await adapter.listModels('deepseek-vision')
  assert.deepEqual(listed.map((model) => model.id), [
    'deepseek-flash',
    'deepseek-v4.1-flash-expires-on-0910',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
  ])
  assert.ok(listed.every((model) => model.provider === 'deepseek-vision'))
  assert.ok(listed.every((model) => model.inputModalities.includes('image')))

  const resolved = await adapter.resolveModel('deepseek-vision', 'deepseek-v4-pro')
  assert.equal(resolved.provider, 'deepseek-vision')
  assert.equal(resolved.id, 'deepseek-v4-pro')
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
  const stableDefault = await adapter.resolveModel('deepseek-vision', 'deepseek-flash')
  assert.equal(stableDefault.provider, 'deepseek-vision')
  assert.equal(stableDefault.id, 'deepseek-flash')
  assert.deepEqual(stableDefault.inputModalities, ['text', 'image'])
  const newOfficial = await adapter.resolveModel(
    'deepseek-vision',
    'deepseek-v4.1-flash-expires-on-0910',
  )
  assert.equal(newOfficial.provider, 'deepseek-vision')
  assert.equal(newOfficial.id, 'deepseek-v4.1-flash-expires-on-0910')
  assert.deepEqual(newOfficial.inputModalities, ['text', 'image'])
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
          { provider, id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', inputModalities: ['text', 'image'] },
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

  // Core-like wrapper. It deliberately leaks the config-derived composite row
  // even while routing is off, then leaks additional relay noise when routing
  // is on. The outer boundary must enforce both routing visibility and exact
  // composite authority instead of trusting stale Core output.
  const coreWrapper = {
    async listModels() {
      const rows = [
        { provider: 'deepseek-vision', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', inputModalities: ['text', 'image'] },
        { provider: 'deepseek-vision', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', inputModalities: ['text', 'image'] },
      ]
      rows.push({
        provider: 'deepseek-vision',
        id: 'zhipu/glm-4.6v-flash',
        name: 'zhipu/glm-4.6v-flash（视觉）',
        inputModalities: ['text', 'image'],
      })
      if (routingEnabled) {
        rows.push(
          { provider: 'deepseek-vision', id: 'k3', name: 'Kimi K3', inputModalities: ['text', 'image'] },
          {
            provider: 'deepseek-vision',
            id: 'relay/vendor-model',
            name: 'Relay Vendor Model',
            inputModalities: ['text', 'image'],
          },
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
  assert.deepEqual(listedOff.map((model) => model.id), ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash'])
  assert.ok(listedOff.every((model) => model.provider === 'deepseek-vision'))
  assert.ok(listedOff.every((model) => model.inputModalities.includes('image')))

  // routing=true: the authorized composite row joins the pinned mirrors; the
  // stray non-composite Kimi row and any DSH-only provider never appear.
  routingEnabled = true
  const listedOn = await registeredAdapter.listModels('deepseek-vision')
  const idsOn = listedOn.map((model) => model.id)
  assert.ok(idsOn.includes('deepseek-flash') && idsOn.includes('deepseek-v4-pro') && idsOn.includes('deepseek-v4-flash'))
  assert.ok(idsOn.includes('zhipu/glm-4.6v-flash'), 'authorized composite row kept')
  assert.ok(!idsOn.includes('k3'), 'stray non-composite row dropped')
  assert.ok(!idsOn.includes('relay/vendor-model'), 'slash-shaped relay row dropped')
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


test('issue #504: official catalog outage stays fail-closed before any trusted snapshot exists', async () => {
  let registeredAdapter
  let coreResolveCalls = 0
  const official = {
    async listModels() {
      throw new Error('503 catalog unavailable')
    },
    async resolveModel(_provider, model) {
      coreResolveCalls += 1
      return { provider: 'deepseek-official', id: model, name: model, inputModalities: ['text'] }
    },
  }
  const ctx = {
    llm: {
      registration(provider) {
        return provider === 'deepseek-official'
          ? { retryPolicy: 'deepseek-retry', adapter: official }
          : undefined
      },
      registerAdapter(_providers, adapter) {
        registeredAdapter = adapter
        return () => {}
      },
      async *stream() {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    get() {
      return undefined
    },
  }
  const wrapped = contextWithDelegatedReplay(ctx)
  wrapped.llm.registerAdapter(['deepseek-vision'], {
    async listModels() { return [] },
    async resolveModel(_provider, model) {
      coreResolveCalls += 1
      return { provider: 'deepseek-vision', id: model, name: model, inputModalities: ['text', 'image'] }
    },
    async *stream(options) {
      yield* wrapped.llm.stream(options)
    },
  })

  await assert.rejects(
    registeredAdapter.resolveModel('deepseek-vision', 'arbitrary-id'),
    (error) => error?.code === 'OFFICIAL_CATALOG_UNAVAILABLE',
  )
  assert.equal(coreResolveCalls, 0)
})

test('issue #504: wrapper list/resolve share one fresh official catalog read', async () => {
  let registeredAdapter
  let listCalls = 0
  const official = {
    async listModels(provider) {
      listCalls += 1
      return [{ provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', inputModalities: ['text'] }]
    },
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text'] }
    },
  }
  const ctx = {
    llm: {
      registration(provider) {
        return provider === 'deepseek-official'
          ? { retryPolicy: 'deepseek-retry', adapter: official }
          : undefined
      },
      registerAdapter(_providers, adapter) {
        registeredAdapter = adapter
        return () => {}
      },
      async *stream() {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    get() {
      return undefined
    },
  }
  const wrapped = contextWithDelegatedReplay(ctx)
  wrapped.llm.registerAdapter(['deepseek-vision'], {
    async listModels() {
      return [{ provider: 'deepseek-vision', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', inputModalities: ['text', 'image'] }]
    },
    async resolveModel(_provider, model) {
      return { provider: 'deepseek-vision', id: model, name: model, inputModalities: ['text', 'image'] }
    },
    async *stream(options) {
      yield* wrapped.llm.stream(options)
    },
  })

  const listed = await registeredAdapter.listModels('deepseek-vision')
  assert.deepEqual(listed.map((entry) => entry.id), ['deepseek-v4-pro'])
  const resolved = await registeredAdapter.resolveModel('deepseek-vision', 'deepseek-v4-pro')
  assert.equal(resolved.id, 'deepseek-v4-pro')
  assert.equal(listCalls, 1)
})


test('issue #504 follow-up: official catalog outage does not block Core-owned composite wrapper models', async () => {
  let registeredAdapter
  let officialListCalls = 0
  let coreResolveCalls = 0
  const official = {
    async listModels() {
      officialListCalls += 1
      throw new Error('503 catalog unavailable')
    },
    async resolveModel(_provider, model) {
      return { provider: 'deepseek-official', id: model, name: model, inputModalities: ['text'] }
    },
  }
  const fallbackVisionConfig = {
    wrapperRoute: 'deepseek-vision',
    routing: true,
    providers: [
      { provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: [] },
    ],
    localOllama: {
      enabled: true,
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5-vl',
    },
  }
  const settings = {
    get() {
      // Simulate cold/plugin-start ordering before the live Settings namespace
      // is readable. Wrapper authority must fall back to the composition config.
      return undefined
    },
  }
  const ctx = {
    llm: {
      registration(provider) {
        return provider === 'deepseek-official'
          ? { retryPolicy: 'deepseek-retry', adapter: official }
          : undefined
      },
      registerAdapter(_providers, adapter) {
        registeredAdapter = adapter
        return () => {}
      },
      async *stream() {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    get(name) {
      return name === 'settings' ? settings : undefined
    },
  }
  const wrapped = contextWithDelegatedReplay(ctx, {
    wrapperRoute: 'deepseek-vision',
    visionConfig: fallbackVisionConfig,
  })
  wrapped.llm.registerAdapter(['deepseek-vision'], {
    async listModels() { return [] },
    async resolveModel(_provider, model) {
      coreResolveCalls += 1
      if (
        model !== 'zhipu/glm-4.6v-flash'
        && model !== 'vision-http/local-ollama/qwen2.5-vl'
      ) {
        return undefined
      }
      return {
        provider: 'deepseek-vision',
        id: model,
        name: model,
        inputModalities: ['text', 'image'],
      }
    },
    async *stream(options) {
      yield* wrapped.llm.stream(options)
    },
  })

  const resolved = await registeredAdapter.resolveModel(
    'deepseek-vision',
    'zhipu/glm-4.6v-flash',
  )
  assert.equal(resolved.id, 'zhipu/glm-4.6v-flash')
  assert.equal(coreResolveCalls, 1)

  const localResolved = await registeredAdapter.resolveModel(
    'deepseek-vision',
    'vision-http/local-ollama/qwen2.5-vl',
  )
  assert.equal(localResolved.id, 'vision-http/local-ollama/qwen2.5-vl')
  assert.equal(coreResolveCalls, 2)
  assert.equal(
    officialListCalls,
    0,
    'Core-owned composite routing must not depend on the official DeepSeek directory',
  )

  fallbackVisionConfig.routing = false
  await assert.rejects(
    registeredAdapter.resolveModel('deepseek-vision', 'zhipu/glm-4.6v-flash'),
    (error) => error?.code === 'OFFICIAL_CATALOG_UNAVAILABLE',
  )
  assert.equal(
    coreResolveCalls,
    2,
    'routing-off must not use the composite bypass',
  )
  assert.equal(officialListCalls, 1)

  await assert.rejects(
    registeredAdapter.resolveModel('deepseek-vision', 'relay/vendor-model'),
    (error) => error?.code === 'OFFICIAL_CATALOG_UNAVAILABLE',
  )
  assert.equal(
    coreResolveCalls,
    2,
    'a slash-containing relay id that is not a config-derived Core pair must not bypass identity checks',
  )
  assert.equal(
    officialListCalls,
    1,
    'the short outage backoff should coalesce rejected identity lookups',
  )

  await assert.rejects(
    registeredAdapter.resolveModel('deepseek-vision', 'arbitrary-id'),
    (error) => error?.code === 'OFFICIAL_CATALOG_UNAVAILABLE',
  )
  assert.equal(
    officialListCalls,
    1,
    'the short outage backoff should also coalesce the second rejected identity lookup',
  )
})
