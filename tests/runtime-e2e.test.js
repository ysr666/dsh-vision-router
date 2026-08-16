// 运行期端到端测试：dsh-vision 并入特性的真实运行时路径。
// 不 stub fetch——起一个本地 OpenAI 兼容假服务（node:http），驱动真实的
// callOpenAICompatible / buildInstantLocalMap / vision_screenshot 代码路径：
// 键缺失、429 重试、超时中止、ECONNREFUSED 降级、跨轮图片记忆写回、
// 桌面截屏 + identify 全链路。CI 安全：只依赖内置模块与本机端口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  callOpenAICompatible,
  buildInstantLocalMap,
  imageMemorySet,
  localOllamaProvidersOf,
  apply,
  Config,
} from '../index.js'

// 1x1 透明 PNG，真实图片字节。
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
// 2x2 红色 PNG：与 PNG_BYTES 区分，用来按内容标记"坏图"。
const RED_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwH4QZYAwAR8oH+Xm0fdIAAAAASUVORK5CYII=',
  'base64',
)

/** 起一个本地 OpenAI 兼容假服务；responder(req, body, nth) 决定响应。 */
async function startFakeOpenAI(responder) {
  const requests = []
  const sockets = new Set()
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      body = {}
    }
    requests.push({ headers: req.headers, body })
    let out
    try {
      out = await responder(req, body, requests.length)
    } catch {
      // 客户端中止后 responder 可能在已关闭的 socket 上写响应；吞掉即可。
      if (res.writableEnded) return
      out = { status: 500, body: 'responder error' }
    }
    if (res.writableEnded) return
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...(out.headers ?? {}) })
    res.end(out.body ?? '')
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(resolve)
      }),
  }
}

/** 返回一个必然 ECONNREFUSED 的 baseURL（端口先绑后放）。 */
async function closedPortBaseURL() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return `http://127.0.0.1:${port}/v1`
}

const chatOk = (text) => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: text } }] }) })

// ── A. callOpenAICompatible 真实 HTTP 线协议 ──────────────────────────────

test('callOpenAICompatible posts the real wire body and returns trimmed content', async () => {
  const server = await startFakeOpenAI(async () => chatOk('  识别结果  '))
  try {
    const text = await callOpenAICompatible(
      { name: 'local-ollama', baseURL: server.baseURL, model: 'test-vl', apiKeyEnv: '', maxTokens: 2048, temperature: 0.5, top_p: 0.8 },
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    )
    assert.equal(text, '识别结果')
    const sent = server.requests[0]
    // 键缺失：无 Authorization 头。
    assert.equal(sent.headers.authorization, undefined)
    assert.equal(sent.body.model, 'test-vl')
    assert.equal(sent.body.stream, false)
    assert.equal(sent.body.max_tokens, 2048)
    // temperature/top_p 只在 provider 显式携带时上送。
    assert.equal(sent.body.temperature, 0.5)
    assert.equal(sent.body.top_p, 0.8)
  } finally {
    await server.close()
  }
})

test('callOpenAICompatible omits temperature/top_p when the provider carries none', async () => {
  const server = await startFakeOpenAI(async () => chatOk('ok'))
  try {
    await callOpenAICompatible(
      { name: 'local-ollama', baseURL: server.baseURL, model: 'test-vl', apiKeyEnv: '' },
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    )
    assert.equal('temperature' in server.requests[0].body, false)
    assert.equal('top_p' in server.requests[0].body, false)
  } finally {
    await server.close()
  }
})

test('callOpenAICompatible sends Bearer auth only for a keyed provider', async () => {
  const server = await startFakeOpenAI(async () => chatOk('ok'))
  try {
    await callOpenAICompatible(
      { name: 'p', baseURL: server.baseURL, model: 'm', apiKeyEnv: 'MY_KEY' },
      [{ role: 'user', content: [] }],
      { resolveCredential: async () => 'sk-test' },
    )
    assert.equal(server.requests[0].headers.authorization, 'Bearer sk-test')
  } finally {
    await server.close()
  }
})

test('callOpenAICompatible honors Retry-After on 429 and retries once', async () => {
  const server = await startFakeOpenAI(async (_req, _body, nth) =>
    nth === 1
      ? { status: 429, headers: { 'retry-after': '1' }, body: 'slow down' }
      : chatOk('after-retry'),
  )
  try {
    const text = await callOpenAICompatible(
      { name: 'p', baseURL: server.baseURL, model: 'm', apiKeyEnv: '' },
      [{ role: 'user', content: [] }],
    )
    assert.equal(text, 'after-retry')
    assert.equal(server.requests.length, 2)
  } finally {
    await server.close()
  }
})

test('callOpenAICompatible surfaces a second 429 as an error', async () => {
  const server = await startFakeOpenAI(async () => ({ status: 429, headers: { 'retry-after': '1' }, body: 'quota' }))
  try {
    await assert.rejects(
      () =>
        callOpenAICompatible(
          { name: 'p', baseURL: server.baseURL, model: 'm', apiKeyEnv: '' },
          [{ role: 'user', content: [] }],
        ),
      /429/,
    )
    assert.equal(server.requests.length, 2)
  } finally {
    await server.close()
  }
})

test('callOpenAICompatible surfaces 500 and malformed shapes as errors', async () => {
  const failing = await startFakeOpenAI(async () => ({ status: 500, body: 'boom detail' }))
  try {
    await assert.rejects(
      () =>
        callOpenAICompatible(
          { name: 'p', baseURL: failing.baseURL, model: 'm', apiKeyEnv: '' },
          [{ role: 'user', content: [] }],
        ),
      /500 boom detail/,
    )
  } finally {
    await failing.close()
  }
  const weird = await startFakeOpenAI(async () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: 42 } }] }) }))
  try {
    await assert.rejects(
      () =>
        callOpenAICompatible(
          { name: 'p', baseURL: weird.baseURL, model: 'm', apiKeyEnv: '' },
          [{ role: 'user', content: [] }],
        ),
      /unexpected response shape/,
    )
  } finally {
    await weird.close()
  }
})

test('callOpenAICompatible surfaces an anonymous OVH 429 immediately without retrying', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response('quota exceeded', { status: 429 })
  }
  try {
    await assert.rejects(
      () =>
        callOpenAICompatible(
          { name: 'ovh', baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', model: 'm', apiKeyEnv: '' },
          [{ role: 'user', content: [] }],
        ),
      /429 quota exceeded/,
    )
    assert.equal(calls, 1, 'anonymous OVH 429 must fail through to the next model, not retry')
  } finally {
    globalThis.fetch = original
  }
})

test('callOpenAICompatible fails before any request when a keyed provider has no key', async () => {
  const server = await startFakeOpenAI(async () => chatOk('unreachable'))
  try {
    await assert.rejects(
      () =>
        callOpenAICompatible(
          { name: 'p', baseURL: server.baseURL, model: 'm', apiKeyEnv: 'VR_E2E_MISSING_KEY' },
          [{ role: 'user', content: [] }],
        ),
      /is not set/,
    )
    assert.equal(server.requests.length, 0, 'no request may leave without a key')
  } finally {
    await server.close()
  }
})

// ── B. buildInstantLocalMap 真实端到端 ─────────────────────────────────────

function messagesWithImages(ids) {
  return [
    {
      role: 'user',
      content: ids.map((id) => ({
        type: 'image',
        attachment: { attachmentId: id, mediaType: 'image/png' },
      })),
    },
  ]
}

function fakeCtx(logs = { warn: [], info: [] }, bytesById) {
  return {
    get: (name) =>
      name === 'attachments'
        ? {
            readImage: async (attachment) => ({
              data:
                bytesById && attachment && bytesById[attachment.attachmentId]
                  ? bytesById[attachment.attachmentId]
                  : PNG_BYTES,
            }),
          }
        : undefined,
    logger: {
      warn: (msg, ...args) => logs.warn.push([msg, ...args]),
      info: (msg, ...args) => logs.info.push([msg, ...args]),
    },
  }
}

test('buildInstantLocalMap drives the real HTTP path: structured prompt, prefix label, memory write-back', async () => {
  const server = await startFakeOpenAI(async (req, body) => {
    // 服务端验证真正收到的线协议内容。
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(body.model, 'test-vl')
    assert.equal(body.stream, false)
    assert.equal(body.temperature, 0.5)
    assert.equal(body.top_p, 0.8)
    const content = body.messages[0].content
    assert.equal(content[0].type, 'image_url')
    assert.ok(content[0].image_url.url.startsWith('data:image/png;base64,'))
    assert.equal(content[1].type, 'text')
    assert.ok(content[1].text.includes('【初步判断】'))
    return chatOk('这是一张测试图片')
  })
  const logs = { warn: [], info: [] }
  const memory = new Map()
  try {
    const map = await buildInstantLocalMap(
      fakeCtx(logs),
      messagesWithImages(['a1']),
      { name: 'local-ollama', baseURL: server.baseURL, model: 'test-vl', apiKeyEnv: '', maxTokens: 2048, temperature: 0.5, top_p: 0.8 },
      { style: 'structured', memory, timeoutMs: 1000 },
    )
    assert.equal(map.size, 1)
    assert.match(map.get('a1'), /^已由本地视觉识别（本地识别 \d+s）\n这是一张测试图片$/)
    // 跨轮图片记忆写回纯文本（不带前缀标签）。
    assert.equal(memory.get('a1'), '这是一张测试图片')
    assert.equal(logs.warn.length, 0)
    assert.equal(logs.info.length, 1)
  } finally {
    await server.close()
  }
})

test('buildInstantLocalMap dedupes by attachment id and recognizes each unique image once', async () => {
  const server = await startFakeOpenAI(async () => chatOk('ok'))
  try {
    const messages = [
      { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'dup', mediaType: 'image/png' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
      { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'dup', mediaType: 'image/png' } }] },
    ]
    const map = await buildInstantLocalMap(
      fakeCtx(),
      messages,
      { name: 'local-ollama', baseURL: server.baseURL, model: 'm', apiKeyEnv: '' },
      { timeoutMs: 1000 },
    )
    assert.equal(server.requests.length, 1)
    assert.equal(map.size, 1)

    const two = await buildInstantLocalMap(
      fakeCtx(),
      messagesWithImages(['b1', 'b2']),
      { name: 'local-ollama', baseURL: server.baseURL, model: 'm', apiKeyEnv: '' },
      { timeoutMs: 1000 },
    )
    assert.equal(server.requests.length, 3) // 1 (dedupe) + 2
    assert.equal(two.size, 2)
  } finally {
    await server.close()
  }
})

test('buildInstantLocalMap skips memory-cached images instead of re-recognizing every turn', async () => {
  const server = await startFakeOpenAI(async () => chatOk('新图识别'))
  const memory = new Map([['cached', '旧图识别文本']])
  try {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'image', attachment: { attachmentId: 'cached', mediaType: 'image/png' } },
          { type: 'image', attachment: { attachmentId: 'new', mediaType: 'image/png' } },
        ],
      },
    ]
    const map = await buildInstantLocalMap(
      fakeCtx(),
      messages,
      { name: 'local-ollama', baseURL: server.baseURL, model: 'm', apiKeyEnv: '' },
      { memory, timeoutMs: 1000 },
    )
    assert.equal(server.requests.length, 1, 'cached image must not hit the server again')
    assert.equal(map.size, 1)
    assert.equal(map.has('cached'), false)
    assert.match(map.get('new'), /新图识别$/)
    assert.equal(memory.get('cached'), '旧图识别文本', 'cached entry must be untouched')
    assert.equal(memory.get('new'), '新图识别')

    // 全部命中缓存：一次请求都不发。
    const allCached = await buildInstantLocalMap(
      fakeCtx(),
      [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'cached', mediaType: 'image/png' } }] }],
      { name: 'local-ollama', baseURL: server.baseURL, model: 'm', apiKeyEnv: '' },
      { memory, timeoutMs: 1000 },
    )
    assert.equal(server.requests.length, 1)
    assert.equal(allCached.size, 0)
  } finally {
    await server.close()
  }
})

test('buildInstantLocalMap isolates per-image failures and keeps recognizing the rest', async () => {
  // 并行批次下请求顺序不保证——按"内容"标记坏图而不是按第几个请求。
  const badB64 = RED_PNG_BYTES.toString('base64')
  const server = await startFakeOpenAI(async (_req, body) => {
    const url =
      body && body.messages && body.messages[0] && body.messages[0].content
        ? body.messages[0].content[0].image_url.url
        : ''
    return url.includes(badB64) ? { status: 500, body: 'boom' } : chatOk('好图识别成功')
  })
  const logs = { warn: [], info: [] }
  try {
    const map = await buildInstantLocalMap(
      fakeCtx(logs, { bad: RED_PNG_BYTES, good: PNG_BYTES }),
      messagesWithImages(['bad', 'good']),
      { name: 'local-ollama', baseURL: server.baseURL, model: 'm', apiKeyEnv: '' },
      { timeoutMs: 1000 },
    )
    assert.equal(server.requests.length, 2, 'both images must still be attempted')
    assert.equal(map.size, 1)
    assert.equal(map.has('bad'), false)
    assert.match(map.get('good'), /好图识别成功$/)
    assert.ok(logs.warn.length >= 1, 'the failed image must be logged')
  } finally {
    await server.close()
  }
})

test('buildInstantLocalMap degrades to an empty map on ECONNREFUSED (real closed port) and logs a warning', async () => {
  const baseURL = await closedPortBaseURL()
  const logs = { warn: [], info: [] }
  const map = await buildInstantLocalMap(
    fakeCtx(logs),
    messagesWithImages(['a1']),
    { name: 'local-ollama', baseURL, model: 'm', apiKeyEnv: '' },
    { timeoutMs: 1000 },
  )
  assert.equal(map.size, 0)
  assert.equal(logs.warn.length, 1)
  assert.match(String(logs.warn[0].slice(1).join(' ')), /failed/)
})

test('buildInstantLocalMap aborts a hung server within the configured timeout', async () => {
  const server = await startFakeOpenAI(async () => {
    // 挂起 5 秒——客户端应在 300ms 预算内中止。
    await new Promise((resolve) => setTimeout(resolve, 5000))
    return chatOk('too late')
  })
  try {
    const startedAt = Date.now()
    const map = await buildInstantLocalMap(
      fakeCtx(),
      messagesWithImages(['a1']),
      { name: 'local-ollama', baseURL: server.baseURL, model: 'm', apiKeyEnv: '' },
      { timeoutMs: 300 },
    )
    const elapsed = Date.now() - startedAt
    assert.equal(map.size, 0)
    assert.ok(elapsed < 2000, `expected quick abort, took ${elapsed}ms`)
  } finally {
    await server.close()
  }
})

// 进程级退出金丝雀：若 buildInstantLocalMap 内部回退为不清理的
// AbortSignal.timeout(120s)，子进程会被悬挂计时器拖住 120s 无法退出，
// 本用例会在 15s 判定线内把子进程判死并失败。
test('successful instant describe strands no lingering timer (child-process exit canary)', async () => {
  const indexUrl = pathToFileURL(path.resolve(import.meta.dirname, '..', 'index.js')).href
  const script = `
    import { createServer } from 'node:http'
    import { buildInstantLocalMap } from ${JSON.stringify(indexUrl)}
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    const sockets = new Set()
    const server = createServer(async (req, res) => {
      for await (const chunk of req) {}
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    })
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const ctx = {
      get: (name) => name === 'attachments' ? { readImage: async () => ({ data: PNG }) } : undefined,
      logger: { warn() {}, info() {} },
    }
    await buildInstantLocalMap(
      ctx,
      [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'x', mediaType: 'image/png' } }] }],
      { name: 'local-ollama', baseURL: 'http://127.0.0.1:' + port + '/v1', model: 'm', apiKeyEnv: '' },
    )
    for (const s of sockets) s.destroy()
    await new Promise((resolve) => server.close(resolve))
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(import.meta.dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const deadline = setTimeout(() => {
    child.kill('SIGKILL')
  }, 15000)
  const code = await new Promise((resolve) => child.on('exit', resolve))
  clearTimeout(deadline)
  assert.equal(
    code,
    0,
    `child should exit promptly after a successful call (got ${code}); a stranded 120s timer keeps it alive. stderr: ${stderr.slice(0, 500)}`,
  )
})

// ── C. imageMemorySet 有界记忆边界 ─────────────────────────────────────────
test('imageMemorySet keeps exactly the FIFO limit and updates do not evict or refresh recency', () => {
  const map = new Map()
  for (let i = 0; i < 200; i++) imageMemorySet(map, `id-${i}`, `d-${i}`)
  assert.equal(map.size, 200)
  imageMemorySet(map, 'id-200', 'd-200')
  assert.equal(map.size, 200)
  assert.equal(map.has('id-0'), false)
  assert.equal(map.has('id-1'), true)
  // 更新现有 key：不触发淘汰，也不刷新 FIFO 位置。
  imageMemorySet(map, 'id-1', 'updated')
  assert.equal(map.size, 200)
  imageMemorySet(map, 'id-201', 'd-201')
  assert.equal(map.has('id-1'), false, 'updated oldest entry should still be the next evicted')
  assert.equal(map.has('id-2'), true)
})

// ── D. vision_screenshot 真实截屏 + identify 全链路 ────────────────────────

function bootHarness(config0 = {}) {
  const registrations = new Map()
  const toolDefs = new Map()
  let attachmentCounter = 0
  const attachments = {
    saveImage: async (input) => ({
      attachmentId: `mock-att-${++attachmentCounter}`,
      mediaType: input && input.mediaType ? input.mediaType : 'image/png',
      bytes: input && input.data ? input.data.length : 0,
      name: input && input.name ? input.name : undefined,
    }),
    readImage: async () => ({ data: PNG_BYTES, ref: { mediaType: 'image/png' } }),
  }
  const fsService = {
    resolve: async (input) => input,
    readBytes: async (target) => readFileSync(target),
  }
  const ctx = {
    get(name) {
      if (name === 'settings') return { get: () => undefined }
      if (name === 'credentials') return { resolve: async () => ({ value: 'sk-test' }) }
      if (name === 'attachments') return attachments
      if (name === 'fs') return fsService
      return undefined
    },
    logger: { warn() {}, info() {}, error() {} },
    effect(fn) {
      if (typeof fn === 'function') fn()
      return () => {}
    },
    on() {},
    inject(_deps, callback) {
      const scope = { get: () => ({ ...Config({}), ...config0 }), watch: () => {} }
      callback({ settings: { register: () => scope }, effect: () => () => {} })
    },
    tools: {
      register(def) {
        toolDefs.set(def.name, def)
        return () => {}
      },
    },
    llm: {
      registerAdapter(providers, adapter) {
        for (const provider of providers) {
          registrations.set(provider, { adapter, retryPolicy: adapter.providerRetryPolicy(provider) })
        }
        const handle = () => {}
        handle.replace = () => {}
        return handle
      },
      registration(provider) {
        const hit = registrations.get(provider)
        if (hit === undefined) throw new Error(`no adapter registered for provider "${provider}"`)
        return hit
      },
      registerConfigurableProviders: () => ({ replace: () => {} }),
      listProviders: () => [...registrations.keys()].map((id) => ({ id, name: id })),
      listModels: async () => [],
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  return { ctx, toolDefs }
}

async function mountDeepTool(config0, name) {
  const { ctx, toolDefs } = bootHarness(config0)
  apply(ctx, Config({ ...config0 }))
  const activate = toolDefs.get('vision_activate')
  assert.ok(activate, 'progressive mode should register vision_activate')
  await activate.execute({}, {})
  const def = toolDefs.get(name)
  assert.ok(def, `${name} should mount after activation`)
  return def
}

async function mountVisionScreenshot(config0) {
  return mountDeepTool(config0, 'vision_screenshot')
}

test('vision_screenshot really captures the desktop and writes a PNG artifact (darwin)', async (t) => {
  if (process.platform !== 'darwin') return t.skip('desktop capture test is macOS-only')
  const def = await mountVisionScreenshot({})
  const workdir = mkdtempSync(path.join(tmpdir(), 'vr-shot-'))
  try {
    let raw
    try {
      raw = await def.execute({}, { agent: { session: { header: { cwd: workdir } } } })
    } catch (error) {
      // 无屏幕 / 无录屏权限的环境（CI 等）：截图本身不可用，跳过而不是误报。
      return t.skip(`screencapture unavailable: ${error && error.message ? error.message : error}`)
    }
    const result = JSON.parse(raw)
    assert.ok(typeof result.path === 'string' && result.path.endsWith('.png'))
    assert.ok(result.bytes > 0)
    const file = readFileSync(result.path)
    assert.equal(file.subarray(0, 4).toString('hex'), '89504e47', 'artifact must be a real PNG')
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
})

test('vision_screenshot identify=true drives the real local-ollama call end to end', async (t) => {
  if (process.platform !== 'darwin') return t.skip('desktop capture test is macOS-only')
  const server = await startFakeOpenAI(async () => chatOk('屏幕上有一个终端窗口'))
  const config0 = {
    localOllama: {
      enabled: true,
      baseURL: server.baseURL,
      model: 'test-vl',
      temperature: 0.5,
      top_p: 0.8,
    },
    instantDescribe: true,
    localDescribeStyle: 'structured',
    timeoutMs: 1000,
  }
  const def = await mountVisionScreenshot(config0)
  const workdir = mkdtempSync(path.join(tmpdir(), 'vr-shot-'))
  try {
    let raw
    try {
      raw = await def.execute({ identify: true }, { agent: { session: { header: { cwd: workdir } } } })
    } catch (error) {
      return t.skip(`screencapture unavailable: ${error && error.message ? error.message : error}`)
    }
    const result = JSON.parse(raw)
    assert.equal(result.identified, '屏幕上有一个终端窗口')
    assert.ok(result.elapsedSec >= 1)
    assert.equal(result.identifyError, undefined)
    assert.equal(server.requests.length, 1)
    const sent = server.requests[0].body
    // 真实截屏字节进 base64 data URI + 结构化提示（instantLocalStyle）。
    const content = sent.messages[0].content
    assert.ok(content[0].image_url.url.startsWith('data:image/png;base64,'))
    assert.ok(content[1].text.includes('【初步判断】'))
    assert.equal(sent.temperature, 0.5)
    assert.equal(sent.top_p, 0.8)
  } finally {
    await server.close()
    rmSync(workdir, { recursive: true, force: true })
  }
})

test('vision_screenshot identify degrades gracefully when Ollama is down', async (t) => {
  if (process.platform !== 'darwin') return t.skip('desktop capture test is macOS-only')
  const baseURL = await closedPortBaseURL()
  const config0 = {
    localOllama: { enabled: true, baseURL, model: 'test-vl' },
    instantDescribe: true,
    localDescribeStyle: 'plain',
    timeoutMs: 1000,
  }
  const def = await mountVisionScreenshot(config0)
  const workdir = mkdtempSync(path.join(tmpdir(), 'vr-shot-'))
  try {
    let raw
    try {
      raw = await def.execute({ identify: true }, { agent: { session: { header: { cwd: workdir } } } })
    } catch (error) {
      return t.skip(`screencapture unavailable: ${error && error.message ? error.message : error}`)
    }
    const result = JSON.parse(raw)
    // 截图本身照常产出，identify 失败只写进 identifyError，不阻断。
    assert.ok(typeof result.path === 'string' && existsSync(result.path))
    assert.equal(result.identified, undefined)
    assert.ok(typeof result.identifyError === 'string' && result.identifyError.length > 0)
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
})

test('vision_screenshot identify reports disabled localOllama without calling out', async (t) => {
  if (process.platform !== 'darwin') return t.skip('desktop capture test is macOS-only')
  const def = await mountVisionScreenshot({})
  const workdir = mkdtempSync(path.join(tmpdir(), 'vr-shot-'))
  try {
    let raw
    try {
      raw = await def.execute({ identify: true }, { agent: { session: { header: { cwd: workdir } } } })
    } catch (error) {
      return t.skip(`screencapture unavailable: ${error && error.message ? error.message : error}`)
    }
    const result = JSON.parse(raw)
    assert.equal(
      result.identifyError,
      'no local vision backend enabled (localOllama / localLmStudio); enable one to use identify',
    )
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
})

// ── E. 视觉链降级：挂起的 provider 不得堵死后续兜底 ────────────────────────
// localOllama 开启时排在视觉链最前；它只挂连接不响应时，ECONNREFUSED 的
// 自动跳过帮不上忙——若整条链共享一个超时信号，第一个 provider 的挂起会
// 吃掉全部预算，云端兜底根本轮不到。期望：每个 provider 独立预算，挂起
// 的跳过、后面的继续答。
test('vision chain falls through to the next provider when the first hangs', async () => {
  const hang = await startFakeOpenAI(async (req) => {
    // 挂起 15s；客户端中止时（req close）立刻结束 handler。
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 15000)
      req.on('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    return chatOk('never')
  })
  const fast = await startFakeOpenAI(async () => chatOk('fast provider answered'))
  const config0 = {
    httpProviders: [
      { name: 'hang', baseURL: hang.baseURL, model: 'hang-vl' },
      { name: 'fast', baseURL: fast.baseURL, model: 'fast-vl' },
    ],
    timeoutMs: 1500,
  }
  const def = await mountDeepTool(config0, 'vision_describe')
  const workdir = mkdtempSync(path.join(tmpdir(), 'vr-chain-'))
  try {
    const pngPath = path.join(workdir, 'tiny.png')
    writeFileSync(pngPath, PNG_BYTES)
    const startedAt = Date.now()
    const text = await def.execute(
      { paths: [pngPath], question: 'what do you see' },
      { agent: { session: { header: { cwd: workdir } } } },
    )
    const elapsed = Date.now() - startedAt
    assert.equal(text, 'fast provider answered')
    assert.ok(hang.requests.length >= 1, 'the hanging provider must have been tried')
    assert.ok(fast.requests.length >= 1, 'the next provider must still get a real attempt')
    assert.ok(elapsed < 8000, `fallthrough should be bounded (took ${elapsed}ms)`)
  } finally {
    await hang.close()
    await fast.close()
    rmSync(workdir, { recursive: true, force: true })
  }
})
