import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  httpProvidersOf,
  providersOf,
  localProvidersOf,
  localOllamaProvidersOf,
  localLmStudioProvidersOf,
  callOpenAICompatible,
  callLocalBackend,
  imageMemorySet,
  localDescribePrompt,
  orderedHttpProviders,
  DEFAULT_HTTP_PROVIDERS,
} from '../index.js'
import { callAnthropicCompatible } from '../lib/catalog-corrections.js'

// ─────────────────────────────────────────────────────────────────────────────
// 零回归门禁：本地视觉（#98）的所有新功能默认关闭时，行为必须与 current
// main 等价。任何一条失败都意味着整合悄悄改变了既有用户的行为。
// ─────────────────────────────────────────────────────────────────────────────

test('gate: httpProvidersOf is byte-identical to main when local backends are disabled', () => {
  const empty = { httpProviders: [] }
  assert.deepEqual(httpProvidersOf(empty), DEFAULT_HTTP_PROVIDERS)
  assert.deepEqual(httpProvidersOf(empty, false), [])
  // A user-configured http provider list is unchanged (no local injection).
  const custom = {
    httpProviders: [
      { name: 'custom', baseURL: 'http://custom.test/v1', model: 'm', apiKeyEnv: '' },
    ],
  }
  assert.deepEqual(httpProvidersOf(custom), [
    ...custom.httpProviders,
    ...DEFAULT_HTTP_PROVIDERS.filter(
      (p) => !new Set(custom.httpProviders.map((x) => `${x.name}/${x.model}`)).has(`${p.name}/${p.model}`),
    ),
  ])
  assert.deepEqual(httpProvidersOf(custom, false), custom.httpProviders)
})

test('gate: localProvidersOf returns [] unless a local backend is explicitly enabled', () => {
  assert.deepEqual(localOllamaProvidersOf({}), [])
  assert.deepEqual(localOllamaProvidersOf({ localOllama: { enabled: false } }), [])
  assert.deepEqual(localLmStudioProvidersOf({}), [])
  assert.deepEqual(localLmStudioProvidersOf({ localLmStudio: { enabled: false } }), [])
  assert.deepEqual(localProvidersOf({}), [])
})

test('gate: providersOf ignores local-only settings entirely (main pair shape preserved)', () => {
  const config = {
    providers: [{ provider: 'deepseek', model: 'deepseek-chat' }],
    localOllama: { enabled: true, baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5vl' },
    localLmStudio: { enabled: true, baseURL: 'http://localhost:1234/v1', model: 'local-model' },
  }
  assert.deepEqual(providersOf(config), [{ provider: 'deepseek', model: 'deepseek-chat' }])
})

test('gate: callOpenAICompatible wire body is the pure OpenAI shape (no anthropic branch)', async () => {
  // The transport was restored to main: no `format` branching, no sampling
  // fields unless the caller explicitly passes them through options.
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) })
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const provider = { name: 'local', baseURL: 'http://local.test/v1', model: 'm', apiKeyEnv: '' }
    const text = await callOpenAICompatible(provider, [{ role: 'user', content: 'hi' }], {})
    assert.equal(text, 'ok')
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /\/chat\/completions$/)
    assert.deepEqual(calls[0].body, {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 4096,
      stream: false,
    })
    // Explicit sampling options are forwarded only when the caller passes them
    // (local dispatcher use); a plain call stays main-identical.
    assert.equal('temperature' in calls[0].body, false)
    assert.equal('top_p' in calls[0].body, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('gate: callLocalBackend dispatches openai to the OpenAI transport with sampling', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) })
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const provider = {
      name: 'local-ollama',
      baseURL: 'http://local.test/v1',
      model: 'm',
      apiKeyEnv: '',
      temperature: 0.5,
      top_p: 0.8,
    }
    const text = await callLocalBackend(provider, [{ role: 'user', content: 'hi' }], {})
    assert.equal(text, 'ok')
    assert.match(calls[0].url, /\/chat\/completions$/)
    assert.equal(calls[0].body.temperature, 0.5)
    assert.equal(calls[0].body.top_p, 0.8)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('gate: callAnthropicCompatible still requires a key by default (allowKeyless opt-in only)', async () => {
  const provider = { name: 'local', baseURL: 'http://local.test', model: 'm', apiKeyEnv: '' }
  await assert.rejects(
    () => callAnthropicCompatible(provider, [], {}),
    /api key is not set/,
  )
})

test('gate: callAnthropicCompatible allowKeyless omits x-api-key for local servers', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(String(init.body)) })
    return new Response(
      JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const provider = { name: 'local', baseURL: 'http://local.test', model: 'm', apiKeyEnv: '' }
    const text = await callAnthropicCompatible(provider, [{ role: 'user', content: 'hi' }], {
      allowKeyless: true,
    })
    assert.equal(text, 'ok')
    assert.match(calls[0].url, /\/v1\/messages$/)
    assert.equal(calls[0].headers['x-api-key'], undefined)
    assert.equal(calls[0].headers['anthropic-version'], '2023-06-01')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('gate: imageMemorySet keeps main unbounded semantics (no FIFO eviction)', () => {
  const memory = new Map()
  for (let i = 0; i < 500; i++) imageMemorySet(memory, `img-${i}`, `desc-${i}`)
  assert.equal(memory.size, 500)
  assert.equal(memory.get('img-0'), 'desc-0')
  assert.equal(memory.get('img-499'), 'desc-499')
})

test('gate: structured prompt reports input-image dimensions, not original, with explicit bbox basis', () => {
  const prompt = localDescribePrompt('structured')
  assert.match(prompt, /【输入图尺寸】/)
  assert.match(prompt, /你实际看到的这张图（可能已被等比缩放）/)
  assert.match(prompt, /不是原图尺寸/)
  // The old wording that would mislead the model into reporting original
  // pixel coordinates must be gone.
  assert.equal(prompt.includes('【原图尺寸】'), false)
})

test('gate: plain prompt is unchanged from the local vision design', () => {
  const prompt = localDescribePrompt('plain')
  assert.match(prompt, /详细描述这张图片/)
  assert.match(prompt, /照抄原文/)
  assert.equal(prompt.includes('【输入图尺寸】'), false)
})

test('gate: orderedHttpProviders is byte-identical to httpProvidersOf while freeCloudFirst is off', () => {
  // The new switch must not alter anything under its default (off) state:
  // every config that httpProvidersOf already serves returns the same list.
  const empty = { httpProviders: [] }
  assert.deepEqual(orderedHttpProviders(empty), DEFAULT_HTTP_PROVIDERS)
  assert.deepEqual(orderedHttpProviders(empty, false), httpProvidersOf(empty))
  const custom = {
    httpProviders: [
      { name: 'custom', baseURL: 'http://custom.test/v1', model: 'm', apiKeyEnv: '' },
    ],
  }
  assert.deepEqual(orderedHttpProviders(custom, false), httpProvidersOf(custom))
  // freeFallback=false still wins: without the built-in tier there is nothing
  // to reorder, so the switch is a no-op (configured list only).
  const noFallback = {
    freeFallback: false,
    httpProviders: [
      { name: 'custom', baseURL: 'http://custom.test/v1', model: 'm', apiKeyEnv: '' },
    ],
  }
  assert.deepEqual(orderedHttpProviders(noFallback, true), noFallback.httpProviders)
  assert.deepEqual(orderedHttpProviders(noFallback, false), noFallback.httpProviders)
})
