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
