import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  contextWithDelegatedReplay,
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

test('main auto-vision wrapper follows live textProvider changes and isolates reasoning effort per delegate', async () => {
  let textProvider = 'deepseek-official'
  let registeredAdapter
  const calls = []
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

  // Emulate the current core wrapper's two stale captures: its delegate
  // provider is fixed at apply time, and its own reasoning memory is keyed by
  // that stale provider. The entry-layer boundary must correct both at the
  // one nested llm.stream dispatch.
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

  const drain = async (options) => {
    for await (const _chunk of registeredAdapter.stream({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      ...options,
    })) {
      // drain
    }
  }

  await drain({ reasoningEffort: 'high' })
  textProvider = 'relay-openai'
  await drain({})
  await drain({ reasoningEffort: 'low' })
  textProvider = 'deepseek-official'
  await drain({})

  assert.deepEqual(calls.map((call) => call.provider), [
    'deepseek-official',
    'relay-openai',
    'relay-openai',
    'deepseek-official',
  ])
  assert.deepEqual(calls.map((call) => call.reasoningEffort), [
    'high',
    undefined,
    'low',
    'high',
  ])
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
