import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideVisionBackendCapability,
  isOpenAIHttpBridgeTransport,
} from '../index.js'

test('undeclared and text-only metadata are advisory for generative backends', () => {
  const unknown = decideVisionBackendCapability(undefined, 'custom-ws', 'mystery-chat', [])
  assert.equal(unknown.image, false)
  assert.equal(unknown.attemptable, true)
  assert.match(unknown.reason, /does not declare image input/)

  const textOnly = decideVisionBackendCapability(
    { inputModalities: ['text'] },
    'custom-provider',
    'mystery-chat',
    [],
  )
  assert.equal(textOnly.image, false)
  assert.equal(textOnly.attemptable, true)
  assert.match(textOnly.reason, /declares no image input/)
})

test('non-generative endpoints remain a hard structural exclusion', () => {
  const embedding = decideVisionBackendCapability(
    { inputModalities: ['text', 'image'] },
    'custom',
    'qwen-vl-embedding',
    [],
  )
  assert.equal(embedding.image, false)
  assert.equal(embedding.attemptable, false)
})

test('direct compatibility bridge accepts only http(s) OpenAI Chat Completions', () => {
  assert.equal(
    isOpenAIHttpBridgeTransport({ api: 'openai-completions', baseURL: 'https://example.test/v1' }),
    true,
  )
  assert.equal(
    isOpenAIHttpBridgeTransport({ api: 'openai-completions', baseURL: 'http://127.0.0.1:9000/v1' }),
    true,
  )
  assert.equal(
    isOpenAIHttpBridgeTransport({ api: 'openai-completions', baseURL: 'wss://example.test/v1' }),
    false,
  )
  assert.equal(
    isOpenAIHttpBridgeTransport({ api: 'anthropic-messages', baseURL: 'https://example.test/v1' }),
    false,
  )
})
