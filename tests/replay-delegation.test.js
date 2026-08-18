import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
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

  // Emulate the core wrapper's legacy stale provider/reasoning caches. The
  // entry-layer boundary must correct both at the one nested llm.stream call.
  let staleReasoningEffort
  const coreWrapper = {
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
        provider: 'deepseek-official',
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
    setProvider(value) { textProvider = value },
  }
}

test('main auto-vision wrapper follows live textProvider changes and keeps reasoning memory per delegate', async () => {
  const harness = liveWrapperHarness()
  await harness.drain({ reasoningEffort: 'high' })
  harness.setProvider('relay-openai')
  await harness.drain({})
  await harness.drain({ reasoningEffort: 'low' })
  harness.setProvider('deepseek-official')
  await harness.drain({})

  assert.deepEqual(harness.calls.map((call) => call.provider), [
    'deepseek-official',
    'relay-openai',
    'relay-openai',
    'deepseek-official',
  ])
  assert.deepEqual(harness.calls.map((call) => call.reasoningEffort), [
    'high',
    undefined,
    'low',
    'high',
  ])
})

test('hidden native DeepSeek route only substitutes the official selection, never a relay', async () => {
  const harness = liveWrapperHarness({ initialProvider: 'relay-openai', native: true })
  await harness.drain({ reasoningEffort: 'high' })
  harness.setProvider('deepseek-official')
  await harness.drain({})
  assert.deepEqual(harness.calls.map((call) => call.provider), [
    'relay-openai',
    'deepseek-official-native',
  ])
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
  // The first sessions fell out of the cap; their memory is gone, so a
  // follow-up without an explicit pick must not re-inject anything.
  await harness.drain({ sessionId: 'session-0' })
  const evicted = harness.calls[harness.calls.length - 1]
  assert.equal(evicted.reasoningEffort, undefined)
  // A session still inside the cap keeps remembering its pick.
  await harness.drain({ sessionId: `session-${total - 1}` })
  const hot = harness.calls[harness.calls.length - 1]
  assert.equal(hot.reasoningEffort, 'high')
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

test('only the configured main wrapper route gets live text-provider rewriting', async () => {
  let registeredAdapter
  let seen
  const llm = {
    registerAdapter(_providers, adapter) {
      registeredAdapter = adapter
      return () => {}
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
