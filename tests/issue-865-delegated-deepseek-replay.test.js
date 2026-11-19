import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWrapperStreamBody } from '../lib/core-primitives.js'
import { rebindDelegatedReplaySources } from '../lib/replay-delegation.js'
import {
  stampDelegatedDeepSeekReplayChunk,
  hasDelegatedDeepSeekReplayProvenance,
} from '../lib/delegated-deepseek-replay-provenance.js'

const nativeReplay = () => ({
  response: { kind: 'deepseek-messages', version: 1, model: 'deepseek-flash' },
  blocks: [{ type: 'reasoning', signature: 'NATIVE_SYNTHETIC_SIGNATURE' }],
})
const success = () => ({
  type: 'finish',
  reason: { kind: 'stop' },
  replayState: nativeReplay(),
})
const assistant = replayState => ({
  id: 'synthetic-assistant',
  role: 'assistant',
  content: [{ type: 'reasoning', text: 'synthetic test thinking' }],
  source: { kind: 'model', provider: 'account-vision', model: 'deepseek-flash', replayState },
})

test('issue #865: stamp delegated DeepSeek native finish only, with no synthetic signature', () => {
  const original = success()
  const stamped = stampDelegatedDeepSeekReplayChunk(original, 'account', 'deepseek-flash')
  assert.equal(stamped.replayState.response.provider, 'account')
  assert.equal(original.replayState.response.provider, undefined, 'native chunks must not be mutated')
  assert.deepEqual(stamped.replayState.blocks, original.replayState.blocks, 'native reasoning signature is untouched')
  assert.equal(hasDelegatedDeepSeekReplayProvenance(stamped.replayState, 'account', 'deepseek-flash'), true)
  assert.equal(hasDelegatedDeepSeekReplayProvenance(stamped.replayState, 'foreign', 'deepseek-flash'), false)
  assert.equal(stampDelegatedDeepSeekReplayChunk(stamped, 'account', 'deepseek-flash'), stamped)

  const errored = { ...original, reason: { kind: 'error', failure: { code: 'AUTH' } } }
  assert.equal(stampDelegatedDeepSeekReplayChunk(errored, 'account', 'deepseek-flash'), errored)
  assert.equal(stampDelegatedDeepSeekReplayChunk(original, 'account', 'wrong-model'), original)
  assert.equal(stampDelegatedDeepSeekReplayChunk(original, 'account', ''), original)
  assert.equal(stampDelegatedDeepSeekReplayChunk({ ...original, replayState: {
    ...original.replayState, response: { ...original.replayState.response, provider: 'foreign' },
  } }, 'account', 'deepseek-flash').replayState.response.provider, 'foreign')
})

test('issue #865: only a provider-stamped native twin replay may rebind its source', () => {
  const native = nativeReplay()
  const stamped = stampDelegatedDeepSeekReplayChunk(success(), 'account', 'deepseek-flash').replayState
  const old = assistant(native)
  const proven = assistant(stamped)
  assert.equal(rebindDelegatedReplaySources([old], 'account')[0], old,
    'unknown older replay cannot be inferred from the alias name')
  const rebound = rebindDelegatedReplaySources([proven], 'account')[0]
  assert.equal(rebound.source.provider, 'account')
  assert.equal(proven.source.provider, 'account-vision', 'durable history remains immutable')
  assert.deepEqual(rebound.source.replayState, proven.source.replayState)
  assert.equal(rebindDelegatedReplaySources([proven], 'other')[0], proven,
    'never project a signature to a different real provider')
})

test('issue #865: wrapper stamps real delegated native replay without changing stream order', async () => {
  const dispatched = []
  const adapter = createWrapperStreamBody({
    llm: {
      async *stream(options) {
        dispatched.push(options)
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'synthetic' } }
        yield success()
      },
    },
  }, {
    imageMemory: new Map(),
    delegateProvider: 'account',
    preserveImageInput: true,
  })
  const chunks = []
  for await (const chunk of adapter.stream({
    model: 'deepseek-flash', messages: [], sessionId: 'session-A',
  })) chunks.push(chunk)
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'block-end', 'finish'])
  assert.equal(chunks[2].replayState.response.provider, 'account')
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].provider, 'account')
})
