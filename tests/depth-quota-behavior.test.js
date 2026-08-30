// 行为级深度配额测试（maintainer review 要求）：
// 驱动真实 wrapper（apply 注册的工具），验证 fast 档深度配额只在工具真正
// 产出证据后消费——失败调用（ok:false）不烧配额、不置 followupCompleted，
// 模型保有提醒并可重试；成功后第三次调用命中 VISION_DEPTH_LIMIT。
// 不 stub fetch：本地 OpenAI 兼容假服务驱动 bootstrap 与失败调用；
// vision_colors（sharp 本地、无网络）作第二次成功调用，避开 turn 级失败
// 记忆与网络依赖。CI 安全：只依赖内置模块与本机端口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply, Config } from '../index.js'

// 1x1 透明 PNG，真实图片字节（sharp 可读）。
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 本地 OpenAI 兼容假服务；responder(req, body, nth) 决定第 nth 次请求的响应。 */
async function startFakeVisionServer(responder) {
  const requests = []
  const sockets = new Set()
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      body = {}
    }
    requests.push({ url: req.url, body })
    let out
    try {
      out = await responder(req, body, requests.length)
    } catch {
      if (res.writableEnded) return
      out = { status: 500, body: 'responder error' }
    }
    if (res.writableEnded) return
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' })
    res.end(out.body ?? '')
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(resolve)
      }),
  }
}

const chatOk = (text) => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: text } }] }) })

/** 最小 ctx harness（参照 runtime-e2e.test.js 的 bootHarness）。 */
function bootHarness(config0 = {}) {
  const toolDefs = new Map()
  const registrations = new Map()
  const handlers = new Map()
  let resolvedSettings = Config({ ...config0 })
  let settingsWatcher
  const attachments = {
    saveImage: async (input) => ({
      attachmentId: `mock-att-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
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
    on(event, handler) {
      handlers.set(event, handler)
      return () => {}
    },
    inject(_deps, callback) {
      const scope = {
        get: () => resolvedSettings,
        watch: (watcher) => {
          settingsWatcher = watcher
          return () => {
            if (settingsWatcher === watcher) settingsWatcher = undefined
          }
        },
      }
      callback({ settings: { register: () => scope }, effect: () => () => {} })
      return () => {}
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
          registrations.set(provider, { adapter, retryPolicy: adapter.providerRetryPolicy ? adapter.providerRetryPolicy(provider) : undefined })
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
      resolveModelInfo: async () => ({ id: 'm', inputModalities: ['text', 'image'], image: true }),
      // The real llm service routes stream() to the registered provider
      // adapter; vision_describe goes through llm.stream(), so forward to the
      // adapter (vision-http) instead of finishing empty.
      async *stream(options) {
        const registration = registrations.get(options && options.provider)
        if (registration && registration.adapter && typeof registration.adapter.stream === 'function') {
          yield* registration.adapter.stream(options)
          return
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  return { ctx, toolDefs, handlers }
}

test('fast tier: failed evidence call does not burn the quota; success consumes it; third call hits VISION_DEPTH_LIMIT', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vr-depth-behavior-'))
  const pngPath = path.join(dir, 'img.png')
  writeFileSync(pngPath, PNG_BYTES)

  // Request 1 = bootstrap (structured schema); requests 2+ = the failed
  // evidence call (ok:false business failure from the "backend").
  const BOOTSTRAP_JSON = JSON.stringify({
    visual_kind: 'mixed',
    mixed_of: ['document', 'ui'],
    overview: 'a mixed page',
    content_kind: 'unknown',
    regions: [],
    visible_text: [],
    entities: [],
  })
  const FAIL_JSON = JSON.stringify({
    ok: false,
    code: 'VISION_BACKEND_UNAVAILABLE',
    retryable: false,
    reason: 'simulated backend outage',
  })
  const server = await startFakeVisionServer(async (_req, _body, nth) =>
    chatOk(nth === 1 ? BOOTSTRAP_JSON : FAIL_JSON),
  )
  try {
    const config = {
      structuredVisionBootstrap: true,
      visionDepth: 'fast',
      freeFallback: false, // single backend only: no OVH fallback noise
      localOllama: { enabled: true, baseURL: server.baseURL, model: 'm' },
    }
    const harness = bootHarness(config)
    apply(harness.ctx, Config(config))

    const session = { id: 'depth-behavior-session', events: [] }
    const exec = { agent: { session } }
    // pre-step reads `decision.messages ?? payload.messages` — next() must
    // carry the image turn, not an empty array.
    const imageMessages = [
      { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png' } }] },
    ]
    const imagePayload = { turn: 1, agent: { session }, messages: imageMessages }
    const preStep = harness.handlers.get('agent/pre-step')
    assert.ok(preStep, 'pre-step hook must be registered')
    const next = async () => ({ kind: 'ok', messages: imageMessages })
    const hasFollowupReminder = (decision) =>
      Array.isArray(decision && decision.messages) &&
      decision.messages.some(
        (m) => m && typeof m.id === 'string' && m.id.includes('vision-router-structured-followup-'),
      )

    // 1. Image turn: bootstrap state created (required) + deep tools auto-mounted.
    const d1 = await preStep(imagePayload, next)
    assert.equal(hasFollowupReminder(d1), false, 'no followup reminder before bootstrap completes')

    const bootstrap = harness.toolDefs.get('vision_bootstrap')
    assert.ok(bootstrap, 'vision_bootstrap must be mounted after the image turn')
    const bootRaw = await bootstrap.execute({ paths: [pngPath] }, exec)
    const boot = JSON.parse(bootRaw)
    assert.equal(boot.ok, true, 'bootstrap must succeed')
    assert.equal(boot.phase, 'structured-bootstrap')

    // 2. Bootstrap done, followup not: the followup reminder is injected.
    const d2 = await preStep(imagePayload, next)
    assert.equal(hasFollowupReminder(d2), true, 'followup reminder injected after bootstrap')

    // 3. First evidence call FAILS with ok:false — must NOT burn the fast quota.
    const describe = harness.toolDefs.get('vision_describe')
    assert.ok(describe, 'vision_describe must be mounted')
    const r1 = await describe.execute({ paths: [pngPath], question: 'what is here?' }, exec)
    const j1 = JSON.parse(r1)
    assert.equal(j1.ok, false, 'first evidence call reports failure')
    assert.notEqual(j1.code, 'VISION_DEPTH_LIMIT', 'a failed call must not be blocked as over-limit')

    // 4. Still no evidence produced: the followup reminder is STILL injected
    //    (followupCompleted stays false after a failure).
    const d3 = await preStep(imagePayload, next)
    assert.equal(hasFollowupReminder(d3), true, 'followup reminder persists after a failed evidence call')

    // 5. Second evidence call SUCCEEDS (vision_colors: sharp-local, no network,
    //    immune to the turn-level failure memory) — consumes the quota.
    const colors = harness.toolDefs.get('vision_colors')
    assert.ok(colors, 'vision_colors must be mounted')
    const requestsBefore = server.requests.length
    const r2 = await colors.execute({ image: pngPath }, exec)
    assert.equal(JSON.parse(r2).ok, undefined, 'colors returns a plain inventory (no ok field)')
    // If the old pre-decrement bug were present, this successful call would
    // already be blocked (deepCalls would be 1 after the failed call).
    assert.equal(server.requests.length, requestsBefore, 'vision_colors is sharp-local: no extra network')

    // 6. Evidence produced: the followup reminder is NO LONGER injected.
    const d4 = await preStep(imagePayload, next)
    assert.equal(hasFollowupReminder(d4), false, 'followup reminder stops once evidence was produced')

    // 7. Third evidence call (same turn, fast tier): VISION_DEPTH_LIMIT,
    //    intercepted before any network request.
    const requestsBeforeBlock = server.requests.length
    const r3 = await describe.execute({ paths: [pngPath], question: 'again' }, exec)
    const j3 = JSON.parse(r3)
    assert.equal(j3.ok, false)
    assert.equal(j3.code, 'VISION_DEPTH_LIMIT', 'third evidence call is hard-capped')
    assert.equal(server.requests.length, requestsBeforeBlock, 'the capped call must not reach the network')
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
