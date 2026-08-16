import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CATALOG_ROUTING_CORRECTIONS,
  anthropicMediaType,
  routingCorrectionFor,
  toAnthropicMessages,
  callAnthropicCompatible,
} from '../lib/catalog-corrections.js'
import { VISION_FAILURE_KINDS } from '../lib/vision-resilience.js'

const brokenFacts = { api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/go/v1' }
const fixedFacts = { api: 'anthropic-messages', baseUrl: 'https://opencode.ai/zen/go' }

test('the opencode-go corrections cover the reported pairs', () => {
  const entries = CATALOG_ROUTING_CORRECTIONS.filter((entry) => entry.provider === 'opencode-go')
  assert.deepEqual(
    entries.map((entry) => [entry.model, entry.api, entry.baseURL]),
    [
      ['qwen3.6-plus', 'anthropic-messages', 'https://opencode.ai/zen/go'],
      ['minimax-m2.7', 'anthropic-messages', 'https://opencode.ai/zen/go'],
    ],
  )
})

test('a correction engages only for the exact broken catalog configuration', () => {
  assert.equal(
    routingCorrectionFor(brokenFacts, 'opencode-go', 'qwen3.6-plus').api,
    'anthropic-messages',
  )
  assert.equal(
    routingCorrectionFor(brokenFacts, 'opencode-go', 'minimax-m2.7').api,
    'anthropic-messages',
  )
  // Upstream fixed the catalog: stand down.
  assert.equal(routingCorrectionFor(fixedFacts, 'opencode-go', 'qwen3.6-plus'), undefined)
  // Not a pair this correction documents.
  assert.equal(routingCorrectionFor(brokenFacts, 'opencode-go', 'kimi-k2.6'), undefined)
  assert.equal(routingCorrectionFor(brokenFacts, 'other-provider', 'qwen3.6-plus'), undefined)
  // Broken in a different way (another protocol): not ours to fix.
  assert.equal(
    routingCorrectionFor(
      { api: 'openai-responses', baseUrl: 'https://opencode.ai/zen/go/v1' },
      'opencode-go',
      'qwen3.6-plus',
    ),
    undefined,
  )
  // A user route pointed at their own gateway keeps its own routing.
  assert.equal(
    routingCorrectionFor(
      { api: 'openai-completions', baseUrl: 'https://my-gateway.example/v1' },
      'opencode-go',
      'qwen3.6-plus',
    ),
    undefined,
  )
  // Unknown catalog facts fail closed (no interception).
  assert.equal(routingCorrectionFor(undefined, 'opencode-go', 'qwen3.6-plus'), undefined)
  assert.equal(routingCorrectionFor({ api: '' }, 'opencode-go', 'qwen3.6-plus'), undefined)
  // The settings switch disables every correction.
  assert.equal(routingCorrectionFor(brokenFacts, 'opencode-go', 'qwen3.6-plus', false), undefined)
})

test('anthropicMediaType normalizes jpg to jpeg and passes others through', () => {
  assert.equal(anthropicMediaType('image/jpg'), 'image/jpeg')
  assert.equal(anthropicMediaType('image/png'), 'image/png')
  assert.equal(anthropicMediaType(''), '')
})

test('toAnthropicMessages builds system, merges roles, and maps blocks', async () => {
  const bytesOf = async (attachment) => {
    assert.equal(attachment.attachmentId, 'img-1')
    return Buffer.from([1, 2, 3])
  }
  const result = await toAnthropicMessages(
    [
      {
        role: 'system',
        content: [
          { type: 'text', text: 'You are helpful.' },
          { type: 'text', text: 'Be concise.' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/jpg' } },
          { type: 'text', text: 'What is this?' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Answer briefly.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Sure.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'It is a test.' }] },
    ],
    bytesOf,
  )
  assert.equal(result.system, 'You are helpful.\nBe concise.')
  assert.equal(result.messages.length, 2)
  assert.deepEqual(result.messages[0].role, 'user')
  assert.equal(result.messages[0].content.length, 3)
  assert.deepEqual(result.messages[0].content[0], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from([1, 2, 3]).toString('base64') },
  })
  assert.equal(result.messages[1].role, 'assistant')
  assert.equal(result.messages[1].content.length, 2)
})

test('toAnthropicMessages maps tool calls and tool results, skips reasoning', async () => {
  const result = await toAnthropicMessages(
    [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'private chain of thought' },
          { type: 'tool-call', id: 'call-1', name: 'vision_describe', arguments: '{"question":"hi"}' },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            content: [{ type: 'text', text: 'result text' }],
          },
        ],
      },
    ],
    async () => Buffer.alloc(0),
  )
  assert.equal(result.system, '')
  // The wire must open with a user message, so the guard prepends a marker.
  assert.equal(result.messages.length, 3)
  assert.deepEqual(result.messages[0], {
    role: 'user',
    content: [{ type: 'text', text: '(conversation history)' }],
  })
  assert.deepEqual(result.messages[1].content, [
    { type: 'tool_use', id: 'call-1', name: 'vision_describe', input: { question: 'hi' } },
  ])
  assert.deepEqual(result.messages[2].content, [
    { type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: 'result text' }] },
  ])
})

test('toAnthropicMessages drops unreadable images instead of failing', async () => {
  const result = await toAnthropicMessages(
    [
      {
        role: 'user',
        content: [
          { type: 'image', attachment: { attachmentId: 'boom' } },
          { type: 'text', text: 'kept' },
        ],
      },
    ],
    async () => {
      throw new Error('unreadable')
    },
  )
  assert.deepEqual(result.messages, [{ role: 'user', content: [{ type: 'text', text: 'kept' }] }])
})

test('toAnthropicMessages opens with a user message even when history starts with the assistant', async () => {
  const result = await toAnthropicMessages(
    [
      { role: 'assistant', content: [{ type: 'text', text: 'already done.' }] },
      { role: 'user', content: [{ type: 'text', text: 'what next?' }] },
    ],
    async () => Buffer.alloc(0),
  )
  assert.equal(result.messages[0].role, 'user')
  assert.deepEqual(result.messages[0].content, [{ type: 'text', text: '(conversation history)' }])
  assert.equal(result.messages[1].role, 'assistant')
})

test('callAnthropicCompatible posts /v1/messages with anthropic auth and parses text', async () => {
  const original = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) }
    return new Response(
      JSON.stringify({
        content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: ' world' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const text = await callAnthropicCompatible(
      { name: 'opencode-go', baseURL: 'https://opencode.ai/zen/go/', model: 'qwen3.6-plus' },
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      { maxTokens: 1024, apiKey: 'secret', system: 'be terse' },
    )
    assert.equal(text, 'Hello world')
    assert.equal(captured.url, 'https://opencode.ai/zen/go/v1/messages')
    assert.equal(captured.headers['x-api-key'], 'secret')
    assert.equal(captured.headers['anthropic-version'], '2023-06-01')
    assert.equal(captured.body.model, 'qwen3.6-plus')
    assert.equal(captured.body.max_tokens, 1024)
    assert.equal(captured.body.system, 'be terse')
    assert.deepEqual(captured.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  } finally {
    globalThis.fetch = original
  }
})

test('callAnthropicCompatible types 429 with retry-after like the OpenAI client', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'slow down' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '3' },
    })
  try {
    await assert.rejects(
      callAnthropicCompatible(
        { name: 'opencode-go', baseURL: 'https://opencode.ai/zen/go', model: 'qwen3.6-plus' },
        [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        { maxTokens: 1024, apiKey: 'secret' },
      ),
      (error) => {
        assert.equal(error.status, 429)
        assert.equal(error.code, VISION_FAILURE_KINDS.RATE_LIMIT)
        assert.equal(error.providerRetryAfterMs, 3000)
        return true
      },
    )
  } finally {
    globalThis.fetch = original
  }
})

test('callAnthropicCompatible refuses a missing key and empty content', async () => {
  await assert.rejects(
    callAnthropicCompatible(
      { name: 'opencode-go', baseURL: 'https://opencode.ai/zen/go', model: 'qwen3.6-plus' },
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      { maxTokens: 1024 },
    ),
    /api key is not set/,
  )
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ content: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  try {
    await assert.rejects(
      callAnthropicCompatible(
        { name: 'opencode-go', baseURL: 'https://opencode.ai/zen/go', model: 'qwen3.6-plus' },
        [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        { maxTokens: 1024, apiKey: 'secret' },
      ),
      /no text content/,
    )
  } finally {
    globalThis.fetch = original
  }
})
