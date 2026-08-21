import test from 'node:test'
import assert from 'node:assert/strict'

import {
  contextWithCoalescedAdapterUpdates,
  ensureAdapterPrepareCall,
} from '../lib/adapter-update-coalescer.js'

test('legacy Vision Router adapter gains DSH 0.1.1 prepareCall semantics', async () => {
  const calls = []
  const legacy = {
    async resolveModel(provider, model, signal) {
      calls.push(['resolve', provider, model, signal])
      return { provider, id: model, name: 'Legacy twin', inputModalities: ['text', 'image'] }
    },
    async *stream(options) {
      calls.push(['stream', options])
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const signal = new AbortController().signal

  const adapted = ensureAdapterPrepareCall(legacy)
  assert.equal(adapted, legacy, 'extensible plugin adapters keep their registration identity')
  assert.equal(typeof adapted.prepareCall, 'function')

  const prepared = await adapted.prepareCall('opencode-go-vision', 'qwen3.6-plus', signal)
  assert.deepEqual(prepared.model, {
    provider: 'opencode-go-vision',
    id: 'qwen3.6-plus',
    name: 'Legacy twin',
    inputModalities: ['text', 'image'],
  })

  const chunks = []
  for await (const chunk of prepared.stream({ provider: 'opencode-go-vision', model: 'qwen3.6-plus' })) {
    chunks.push(chunk)
  }
  assert.deepEqual(chunks, [{ type: 'finish', reason: { kind: 'stop' } }])
  assert.equal(calls[0][0], 'resolve')
  assert.equal(calls[0][3], signal)
  assert.equal(calls[1][0], 'stream')
})

test('native prepareCall implementations remain authoritative', async () => {
  const nativePrepareCall = async () => ({
    model: { provider: 'native', id: 'm', name: 'native' },
    stream: async function* () {},
  })
  const adapter = {
    prepareCall: nativePrepareCall,
    async *stream() {},
  }

  assert.equal(ensureAdapterPrepareCall(adapter), adapter)
  assert.equal(adapter.prepareCall, nativePrepareCall)
})

test('frozen legacy adapters use a compatibility proxy without mutation', async () => {
  const legacy = Object.freeze({
    async *stream() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })

  const adapted = ensureAdapterPrepareCall(legacy)
  assert.notEqual(adapted, legacy)
  assert.equal(Object.hasOwn(legacy, 'prepareCall'), false)
  const prepared = await adapted.prepareCall('vision-http', 'free-model')
  assert.deepEqual(prepared.model, {
    provider: 'vision-http',
    id: 'free-model',
    name: 'free-model',
  })
})

test('coalesced Vision Router context adapts only registrations made through its llm view', async () => {
  const registrations = []
  const llm = {
    registerAdapter(providers, adapter) {
      registrations.push({ providers, adapter })
      return () => {}
    },
  }
  const ctx = {
    llm,
    on() { return () => {} },
  }
  const wrapped = contextWithCoalescedAdapterUpdates(ctx)

  const pluginAdapter = {
    async resolveModel(provider, model) { return { provider, id: model, name: model } },
    async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } },
  }
  wrapped.llm.registerAdapter(['deepseek-vision'], pluginAdapter)
  assert.equal(typeof registrations[0].adapter.prepareCall, 'function')
  await assert.doesNotReject(() => registrations[0].adapter.prepareCall('deepseek-vision', 'deepseek-v4-pro'))

  const foreignAdapter = { async *stream() {} }
  llm.registerAdapter(['foreign'], foreignAdapter)
  assert.equal(typeof registrations[1].adapter.prepareCall, 'undefined')
})
