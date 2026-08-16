// dsh-vision 并入特性的测试：本地 Ollama / LM Studio 视觉后端
// （localOllamaProvidersOf / localLmStudioProvidersOf / localProvidersOf /
// httpProvidersOf 本地优先插入）与即时本地翻译（buildInstantLocalMap 的
// 优雅降级路径——不依赖真实本地服务）、提示风格（localDescribePrompt）。
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
  const list = localLmStudioProvidersOf({ localLmStudio: { enabled: true } })
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'local-lmstudio')
  assert.equal(list[0].baseURL, 'http://localhost:1234/v1')
  assert.equal(list[0].model, 'local-model')
  assert.equal(list[0].apiKeyEnv, '')
  const custom = localLmStudioProvidersOf({
    localLmStudio: { enabled: true, baseURL: 'http://localhost:9999/v1', model: 'qwen2.5-vl' },
  })[0]
  assert.equal(custom.baseURL, 'http://localhost:9999/v1')
  assert.equal(custom.model, 'qwen2.5-vl')
  const tuned = localLmStudioProvidersOf({
    localLmStudio: { enabled: true, temperature: 0.2, top_p: 0.9 },
  })[0]
  assert.equal(tuned.temperature, 0.2)
  assert.equal(tuned.top_p, 0.9)
})

test('localProvidersOf orders local-ollama before local-lmstudio', () => {
  assert.deepEqual(localProvidersOf({}), [])
  const both = localProvidersOf({ localOllama: { enabled: true }, localLmStudio: { enabled: true } })
  assert.deepEqual(both.map((p) => p.name), ['local-ollama', 'local-lmstudio'])
  const onlyLms = localProvidersOf({ localLmStudio: { enabled: true } })
  assert.deepEqual(onlyLms.map((p) => p.name), ['local-lmstudio'])
})

test('httpProvidersOf puts enabled local backends first in order', () => {
  const both = httpProvidersOf({ localOllama: { enabled: true }, localLmStudio: { enabled: true } })
  assert.deepEqual(both.slice(0, 2).map((p) => p.name), ['local-ollama', 'local-lmstudio'])
  assert.deepEqual(both.slice(2), DEFAULT_HTTP_PROVIDERS)
  const onlyLms = httpProvidersOf({ localLmStudio: { enabled: true } })
  assert.equal(onlyLms[0].name, 'local-lmstudio')
  assert.deepEqual(onlyLms.slice(1), DEFAULT_HTTP_PROVIDERS)
  const custom = [{ name: 'custom', baseURL: 'http://example.test/v1', model: 'm' }]
  const mixed = httpProvidersOf({ localLmStudio: { enabled: true }, httpProviders: custom })
  assert.deepEqual(mixed.slice(0, 2).map((p) => p.name), ['local-lmstudio', 'custom'])
})

test('httpProvidersOf puts local-ollama first when enabled', () => {
  const withLocal = httpProvidersOf({ localOllama: { enabled: true } })
  assert.equal(withLocal[0].name, 'local-ollama')
  assert.deepEqual(withLocal.slice(1), DEFAULT_HTTP_PROVIDERS)
  const custom = [{ name: 'custom', baseURL: 'http://example.test/v1', model: 'm' }]
  const mixed = httpProvidersOf({ localOllama: { enabled: true }, httpProviders: custom })
  assert.equal(mixed[0].name, 'local-ollama')
  assert.equal(mixed[1].name, 'custom')
  assert.equal(mixed.length, 1 + 1 + DEFAULT_HTTP_PROVIDERS.length)
  // allowDefault=false still excludes built-ins (and local is a built-in).
  assert.equal(httpProvidersOf({ localOllama: { enabled: true }, httpProviders: custom }, false).length, 1)
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

test('localDescribePrompt switches between plain and structured styles', () => {
  const plain = localDescribePrompt('plain')
  assert.ok(plain.includes('详细描述'))
  assert.ok(!plain.includes('【初步判断】'))
  const structured = localDescribePrompt('structured')
  assert.ok(structured.includes('【初步判断】'))
  assert.ok(structured.includes('【细节】'))
  assert.ok(structured.includes('【空间结构】'))
  assert.ok(structured.includes('【原图尺寸】'))
  assert.ok(localDescribePrompt(undefined).includes('详细描述'))
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

test('imageMemorySet evicts oldest entries beyond the FIFO limit', () => {
  const map = new Map()
  for (let i = 0; i < 200; i++) imageMemorySet(map, `id-${i}`, `desc-${i}`)
  assert.equal(map.size, 200)
  // 第 201 条新 key 挤掉最旧条目。
  imageMemorySet(map, 'id-200', 'desc-200')
  assert.equal(map.size, 200)
  assert.equal(map.has('id-0'), false)
  assert.equal(map.get('id-200'), 'desc-200')
  // 更新已存在的 key 不触发淘汰。
  imageMemorySet(map, 'id-199', 'updated')
  assert.equal(map.size, 200)
  assert.equal(map.has('id-1'), true)
  assert.equal(map.get('id-199'), 'updated')
})
