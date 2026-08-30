// dsh-vision 并入特性的测试：本地 Ollama / LM Studio 视觉后端
// （localOllamaProvidersOf / localLmStudioProvidersOf / localProvidersOf）、
// OpenAI / Anthropic 两种请求格式（callLocalBackend 分发）与即时本地翻译
// （buildInstantLocalMap 的优雅降级路径——不依赖真实本地服务）、提示风格。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  localOllamaProvidersOf,
  localLmStudioProvidersOf,
  localProvidersOf,
  httpProvidersOf,
  DEFAULT_HTTP_PROVIDERS,
  buildInstantLocalMap,
  localDescribePrompt,
  imageMemorySet,
  callLocalBackend,
  toAnthropicContent,
  Config,
} from '../index.js'

test('localOllamaProvidersOf returns [] when unset or disabled', () => {
  assert.deepEqual(localOllamaProvidersOf({}), [])
  assert.deepEqual(localOllamaProvidersOf({ localOllama: {} }), [])
  assert.deepEqual(localOllamaProvidersOf({ localOllama: { enabled: false } }), [])
  assert.deepEqual(localOllamaProvidersOf({ localOllama: { enabled: false, baseURL: 'x', model: 'y' } }), [])
})

test('localOllamaProvidersOf returns a keyless local-ollama provider when enabled', () => {
  const list = localOllamaProvidersOf({ localOllama: { enabled: true } })
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'local-ollama')
  assert.equal(list[0].baseURL, 'http://127.0.0.1:11434/v1')
  assert.equal(list[0].model, 'qwen2.5vl')
  assert.equal(list[0].apiKeyEnv, '')
  const custom = localOllamaProvidersOf({
    localOllama: { enabled: true, baseURL: 'http://localhost:8080/v1', model: 'my-vl' },
  })[0]
  assert.equal(custom.baseURL, 'http://localhost:8080/v1')
  assert.equal(custom.model, 'my-vl')
})

test('localOllamaProvidersOf carries temperature/top_p only when explicitly set', () => {
  // 未显式配置：不携带（尊重服务端默认），也不会把 undefined 塞进 body。
  const bare = localOllamaProvidersOf({ localOllama: { enabled: true } })[0]
  assert.equal('temperature' in bare, false)
  assert.equal('top_p' in bare, false)
  // 显式配置：原样透传给 callOpenAICompatible。
  const tuned = localOllamaProvidersOf({
    localOllama: { enabled: true, temperature: 0.3, top_p: 0.7 },
  })[0]
  assert.equal(tuned.temperature, 0.3)
  assert.equal(tuned.top_p, 0.7)
})

test('localLmStudioProvidersOf mirrors localOllamaProvidersOf semantics', () => {
  assert.deepEqual(localLmStudioProvidersOf({}), [])
  assert.deepEqual(localLmStudioProvidersOf({ localLmStudio: {} }), [])
  assert.deepEqual(localLmStudioProvidersOf({ localLmStudio: { enabled: false } }), [])
  assert.deepEqual(localLmStudioProvidersOf({ localLmStudio: { enabled: true } }), [])
  const list = localLmStudioProvidersOf({
    localLmStudio: { enabled: true, model: 'lm-model' },
  })
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'local-lmstudio')
  assert.equal(list[0].baseURL, 'http://localhost:1234/v1')
  assert.equal(list[0].model, 'lm-model')
  assert.equal(list[0].apiKeyEnv, '')
  const custom = localLmStudioProvidersOf({
    localLmStudio: { enabled: true, baseURL: 'http://localhost:9999/v1', model: 'qwen2.5-vl' },
  })[0]
  assert.equal(custom.baseURL, 'http://localhost:9999/v1')
  assert.equal(custom.model, 'qwen2.5-vl')
  const tuned = localLmStudioProvidersOf({
    localLmStudio: { enabled: true, model: 'lm-model', temperature: 0.2, top_p: 0.9 },
  })[0]
  assert.equal(tuned.temperature, 0.2)
  assert.equal(tuned.top_p, 0.9)
})

test('localProvidersOf orders local-ollama before local-lmstudio', () => {
  assert.deepEqual(localProvidersOf({}), [])
  const both = localProvidersOf({
    localOllama: { enabled: true },
    localLmStudio: { enabled: true, model: 'lm-model' },
  })
  assert.deepEqual(both.map((p) => p.name), ['local-ollama', 'local-lmstudio'])
  const onlyLms = localProvidersOf({ localLmStudio: { enabled: true, model: 'lm-model' } })
  assert.deepEqual(onlyLms.map((p) => p.name), ['local-lmstudio'])
})

test('httpProvidersOf is main-identical: local backends are NOT injected (they ride routingPairs instead)', () => {
  const both = httpProvidersOf({
    localOllama: { enabled: true },
    localLmStudio: { enabled: true, model: 'lm-model' },
  })
  // Local backends live in their own settings group and join the vision chain
  // through routingPairs(); httpProvidersOf keeps main's shape so existing
  // HTTP fallback behavior is byte-identical.
  assert.deepEqual(both, DEFAULT_HTTP_PROVIDERS)
  const onlyLms = httpProvidersOf({ localLmStudio: { enabled: true, model: 'lm-model' } })
  assert.deepEqual(onlyLms, DEFAULT_HTTP_PROVIDERS)
  const custom = [{ name: 'custom', baseURL: 'http://example.test/v1', model: 'm' }]
  const mixed = httpProvidersOf({
    localLmStudio: { enabled: true, model: 'lm-model' },
    httpProviders: custom,
  })
  assert.deepEqual(mixed.slice(0, 1), custom)
  assert.deepEqual(mixed.slice(1), DEFAULT_HTTP_PROVIDERS)
})

test('httpProvidersOf allowDefault=false excludes OVH but keeps user http providers only', () => {
  const custom = [{ name: 'custom', baseURL: 'http://example.test/v1', model: 'm' }]
  assert.deepEqual(
    httpProvidersOf({ localOllama: { enabled: true }, httpProviders: custom }, false).map((p) => p.name),
    ['custom'],
  )
})

test('httpProvidersOf unchanged when local disabled (upstream behavior preserved)', () => {
  assert.deepEqual(httpProvidersOf({}), DEFAULT_HTTP_PROVIDERS)
  assert.deepEqual(httpProvidersOf({}, false), [])
  const custom = [{ name: 'custom', baseURL: 'http://example.test/v1', model: 'm' }]
  const withFallback = httpProvidersOf({ httpProviders: custom })
  assert.deepEqual(withFallback.slice(0, 1), custom)
  assert.deepEqual(withFallback.slice(1), DEFAULT_HTTP_PROVIDERS)
})

test('buildInstantLocalMap degrades to an empty map instead of rejecting', async () => {
  const ctxNoAttachments = { get: () => undefined }
  assert.deepEqual(
    await buildInstantLocalMap(ctxNoAttachments, [], { name: 'local-ollama', model: 'q' }),
    new Map(),
  )
  assert.deepEqual(
    await buildInstantLocalMap(ctxNoAttachments, [{ role: 'user', content: [] }], undefined),
    new Map(),
  )
  // attachments.readImage throwing must be swallowed (Ollama down / bad bytes).
  const ctxBroken = {
    get: () => ({
      async readImage() {
        throw new Error('boom')
      },
    }),
  }
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } },
      ],
    },
  ]
  const provider = { name: 'local-ollama', baseURL: 'http://127.0.0.1:9/v1', model: 'q', maxTokens: 128 }
  const map = await buildInstantLocalMap(ctxBroken, messages, provider)
  assert.equal(map.size, 0)
})

test('buildInstantLocalMap isolates per-image failures across a multi-image batch', async () => {
  // 三张图：a1 读取抛错、a2/a3 正常读取但本地端点不可达 → 整批不 reject，
  // 失败按图隔离记录（map 仍为空），不会因一张坏图中断后续识别。
  const ctx = {
    get: () => ({
      async readImage(attachment) {
        if (attachment.attachmentId === 'a1') throw new Error('corrupt image')
        return { data: Buffer.from('fake-png') }
      },
    }),
  }
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } },
        { type: 'image', attachment: { attachmentId: 'a2', mediaType: 'image/png' } },
        { type: 'image', attachment: { attachmentId: 'a3', mediaType: 'image/png' } },
      ],
    },
  ]
  const provider = { name: 'local-ollama', baseURL: 'http://127.0.0.1:9/v1', model: 'q', maxTokens: 128 }
  const map = await buildInstantLocalMap(ctx, messages, provider)
  assert.equal(map.size, 0)
})

test('buildInstantLocalMap accepts a provider list and falls through each level', async () => {
  // 逐级降级：第一级（ollama）不可达 → 未识别的图交给第二级（lmstudio）。
  // 两级都失败时整体放弃（map 空、不 reject）——但两轮都尝试了。
  const ctx = {
    get: () => ({
      async readImage() {
        return { data: Buffer.from('fake-png') }
      },
    }),
  }
  const messages = [
    {
      role: 'user',
      content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } }],
    },
  ]
  const ollama = { name: 'local-ollama', baseURL: 'http://127.0.0.1:9/v1', model: 'q', maxTokens: 128 }
  const lmstudio = { name: 'local-lmstudio', baseURL: 'http://127.0.0.1:8/v1', model: 'm', maxTokens: 128 }
  // 单 provider 兼容：数组只有一个成员。
  const single = await buildInstantLocalMap(ctx, messages, ollama)
  assert.equal(single.size, 0)
  // 数组逐级：两级都失败 → 空 map，不 reject。
  const both = await buildInstantLocalMap(ctx, messages, [ollama, lmstudio])
  assert.equal(both.size, 0)
  // 空数组 / 全 undefined → 空 map（调用方视为回退静态标记）。
  assert.deepEqual(await buildInstantLocalMap(ctx, messages, []), new Map())
  assert.deepEqual(await buildInstantLocalMap(ctx, messages, [undefined, null]), new Map())
})

test('buildInstantLocalMap skips images already cached in memory', async () => {
  // pre-step 识别 / 上次 vision_describe 已写入缓存的图不再重复识别：
  // memory 里已有该 id → 不调用 readImage/后端，map 为空、memory 保持不变。
  let readCalls = 0
  const ctx = {
    get: () => ({
      async readImage() {
        readCalls++
        return { data: Buffer.from('fake-png') }
      },
    }),
  }
  const messages = [
    {
      role: 'user',
      content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } }],
    },
  ]
  const ollama = { name: 'local-ollama', baseURL: 'http://127.0.0.1:9/v1', model: 'q', maxTokens: 128 }
  const memory = new Map([['a1', 'cached description']])
  const map = await buildInstantLocalMap(ctx, messages, ollama, { memory })
  assert.equal(map.size, 0)
  assert.equal(readCalls, 0, 'cached images must not trigger attachment reads')
  assert.equal(memory.get('a1'), 'cached description')
})

test('localDescribePrompt switches between plain and structured styles', () => {
  const plain = localDescribePrompt('plain')
  assert.ok(plain.includes('详细描述'))
  assert.ok(!plain.includes('【初步判断】'))
  const structured = localDescribePrompt('structured')
  assert.ok(structured.includes('【初步判断】'))
  assert.ok(structured.includes('【细节】'))
  assert.ok(structured.includes('【空间结构】'))
  assert.ok(structured.includes('【输入图尺寸】'))
  assert.ok(structured.includes('不是原图尺寸'))
  assert.ok(localDescribePrompt(undefined).includes('详细描述'))
})

test('Config leaves local sampling parameters absent when the user leaves them blank', () => {
  const parsed = Config({
    localOllama: { enabled: true },
    localLmStudio: { enabled: true },
  })
  assert.equal('temperature' in parsed.localOllama, false)
  assert.equal('top_p' in parsed.localOllama, false)
  assert.equal('temperature' in parsed.localLmStudio, false)
  assert.equal('top_p' in parsed.localLmStudio, false)
})

test('buildInstantLocalMap failure leaves memory untouched and never rejects', async () => {
  const memory = new Map()
  const ctxBroken = {
    get: () => ({
      async readImage() {
        throw new Error('boom')
      },
    }),
  }
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } },
      ],
    },
  ]
  const provider = { name: 'local-ollama', baseURL: 'http://127.0.0.1:9/v1', model: 'q', maxTokens: 128 }
  const map = await buildInstantLocalMap(ctxBroken, messages, provider, {
    style: 'structured',
    memory,
  })
  assert.equal(map.size, 0)
  assert.equal(memory.size, 0)
})

test('imageMemorySet keeps main unbounded semantics (no eviction)', () => {
  const map = new Map()
  for (let i = 0; i < 200; i++) imageMemorySet(map, `id-${i}`, `desc-${i}`)
  assert.equal(map.size, 200)
  // Beyond the old FIFO limit the map still grows — long sessions of users
  // who never enabled local vision must not start forgetting images.
  imageMemorySet(map, 'id-200', 'desc-200')
  assert.equal(map.size, 201)
  assert.equal(map.has('id-0'), true)
  assert.equal(map.get('id-200'), 'desc-200')
  imageMemorySet(map, 'id-199', 'updated')
  assert.equal(map.size, 201)
  assert.equal(map.get('id-199'), 'updated')
})

test('toAnthropicContent converts text and data-URI image blocks', () => {
  const converted = toAnthropicContent([
    { type: 'text', text: '看这张图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    { type: 'image_url', image_url: { url: 'data:image/jpg;base64,REVG' } },
    { type: 'image_url', image_url: { url: 'https://example.com/x.png' } }, // 非 data URI 丢弃
    { type: 'tool_use', id: 'x' }, // 未知块类型丢弃
  ])
  assert.deepEqual(converted, [
    { type: 'text', text: '看这张图' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'REVG' } },
  ])
})

test('local providers carry format=anthropic only when explicitly chosen', () => {
  const ollamaDefault = localOllamaProvidersOf({ localOllama: { enabled: true } })[0]
  assert.equal('format' in ollamaDefault, false)
  const ollamaAnthropic = localOllamaProvidersOf({
    localOllama: { enabled: true, format: 'anthropic' },
  })[0]
  assert.equal(ollamaAnthropic.format, 'anthropic')
  const lmsAnthropic = localLmStudioProvidersOf({
    localLmStudio: { enabled: true, model: 'lm-model', format: 'anthropic' },
  })[0]
  assert.equal(lmsAnthropic.format, 'anthropic')
  const lmsDefault = localLmStudioProvidersOf({
    localLmStudio: { enabled: true, model: 'lm-model' },
  })[0]
  assert.equal('format' in lmsDefault, false)
})

test('callLocalBackend speaks Anthropic Messages when format=anthropic (dispatch to callAnthropicCompatible)', async () => {
  const original = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '识别结果' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const text = await callLocalBackend(
      {
        name: 'local-lmstudio',
        baseURL: 'http://localhost:1234/v1',
        model: 'local-model',
        format: 'anthropic',
        temperature: 0.2,
      },
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看这张图' },
            { type: 'image', attachment: { mediaType: 'image/png' } },
          ],
        },
      ],
      { maxTokens: 64, resolveCredential: async () => '' },
    )
    assert.equal(text, '识别结果')
    // callAnthropicCompatible appends /v1/messages to a baseURL without /v1.
    assert.equal(captured.url, 'http://localhost:1234/v1/messages')
    assert.equal(captured.headers['x-api-key'], undefined)
    assert.equal(captured.headers.authorization, undefined)
    assert.equal(captured.headers['anthropic-version'], '2023-06-01')
    assert.equal(captured.body.model, 'local-model')
    assert.equal(captured.body.max_tokens, 64)
    assert.equal(captured.body.temperature, 0.2)
  } finally {
    globalThis.fetch = original
  }
})

test('callLocalBackend normalizes Anthropic baseURL suffixes in linear time', async () => {
  const original = globalThis.fetch
  const captured = []
  globalThis.fetch = async (url) => {
    captured.push(String(url))
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const baseURLs = [
      'http://localhost:11434/v1',
      'http://localhost:11434/v1/',
      'http://localhost:11434/v1////',
      'http://localhost:11434////',
      '',
      `http://localhost:11434/v1${'/'.repeat(100_000)}`,
    ]
    for (const baseURL of baseURLs) {
      await callLocalBackend(
        { name: 'local', baseURL, model: 'm', format: 'anthropic' },
        [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        {},
      )
    }
    assert.deepEqual(captured, [
      'http://localhost:11434/v1/messages',
      'http://localhost:11434/v1/messages',
      'http://localhost:11434/v1/messages',
      'http://localhost:11434/v1/messages',
      '/v1/messages',
      'http://localhost:11434/v1/messages',
    ])
  } finally {
    globalThis.fetch = original
  }
})

test('callLocalBackend openai format stays on the pure OpenAI transport', async () => {
  const original = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  try {
    const text = await callLocalBackend(
      { name: 'local-ollama', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5vl' },
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      {},
    )
    assert.equal(text, 'ok')
    assert.equal(captured.url, 'http://127.0.0.1:11434/v1/chat/completions')
    assert.equal(captured.headers.authorization, undefined)
  } finally {
    globalThis.fetch = original
  }
})

test('callLocalBackend anthropic with a key sends x-api-key without duplicate Bearer', async () => {
  const original = globalThis.fetch
  let captured
  globalThis.fetch = async (_url, init) => {
    captured = init.headers
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    await callLocalBackend(
      {
        name: 'anthropic-compatible',
        baseURL: 'http://localhost:1234/v1',
        model: 'm',
        format: 'anthropic',
        apiKeyEnv: 'LOCAL_KEY',
      },
      [{ role: 'user', content: [] }],
      { resolveCredential: async () => 'secret' },
    )
    assert.equal(captured['x-api-key'], 'secret')
    assert.equal(captured.authorization, undefined)
  } finally {
    globalThis.fetch = original
  }
})
