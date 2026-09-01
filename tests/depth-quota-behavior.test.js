// 行为级独立次数上限测试：
// 驱动真实 structured runtime wrapper（包入口同款 hardening + core 注册工具），验证用户显式开启的
// 深挖次数上限只在工具真正产出证据后消费——ok:false 的“无可用证据”结果不烧配额、不置
// followupCompleted，模型保有提醒并可继续；成功后下一次调用命中
// VISION_DEPTH_LIMIT。深度策略本身不提供次数上限。
// 不 stub fetch：本地 OpenAI 兼容假服务驱动 bootstrap 与“无可用证据”调用；
// vision_colors（sharp 本地、无网络）作成功调用。这里刻意不制造 provider outage，
// 避免把熔断/失败记忆混进本测试要验证的 quota accounting。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { Config } from '../entry.js'
import { installStructuredFlowHardening } from '../lib/structured-flow-hardening.js'

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

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

function bootHarness(config0 = {}) {
  const toolDefs = new Map()
  const registrations = new Map()
  const handlers = new Map()
  const resolvedSettings = Config({ ...config0 })
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
        watch: () => () => {},
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

test('explicit call cap: failed evidence does not consume it, successful evidence does', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vr-depth-behavior-'))
  const pngPath = path.join(dir, 'img.png')
  writeFileSync(pngPath, PNG_BYTES)

  const BOOTSTRAP_JSON = JSON.stringify({
    visual_kind: 'mixed',
    mixed_of: ['document', 'ui'],
    overview: 'a mixed page',
    content_kind: 'unknown',
    regions: [],
    visible_text: [],
    entities: [],
  })
  const NO_EVIDENCE_JSON = JSON.stringify({
    ok: false,
    code: 'NO_USABLE_EVIDENCE',
    retryable: false,
    reason: 'simulated successful request with no usable visual evidence',
  })
  const server = await startFakeVisionServer(async (_req, _body, nth) =>
    chatOk(nth === 1 ? BOOTSTRAP_JSON : NO_EVIDENCE_JSON),
  )
  try {
    const config = {
      structuredVisionBootstrap: true,
      visionDepth: 'fast',
      visionDepthMaxCalls: 1,
      freeFallback: false,
      localOllama: { enabled: true, baseURL: server.baseURL, model: 'm' },
    }
    const harness = bootHarness(config)
    const hardenedCtx = installStructuredFlowHardening(harness.ctx, Config(config))
    apply(hardenedCtx, Config(config))

    const session = { id: 'depth-behavior-session', events: [] }
    const exec = { agent: { session } }
    const imageMessages = [
      { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png' } }] },
    ]
    const imagePayload = { turn: 1, agent: { session }, messages: imageMessages }
    const preStep = harness.handlers.get('agent/pre-step')
    assert.ok(preStep)
    const next = async () => ({ kind: 'ok', messages: imageMessages })
    const hasEvidenceReminder = (decision) =>
      Array.isArray(decision && decision.messages) &&
      decision.messages.some((m) => {
        if (!m || typeof m.id !== 'string') return false
        return m.id.includes('vision-router-structured-followup-') ||
          m.id.includes('vision-router-structured-mixed-guard-') ||
          m.id.includes('vision-router-structured-evidence-guard-')
      })

    const d1 = await preStep(imagePayload, next)
    assert.equal(hasEvidenceReminder(d1), false)

    const bootstrap = harness.toolDefs.get('vision_bootstrap')
    assert.ok(bootstrap)
    const bootRaw = await bootstrap.execute({ paths: [pngPath] }, exec)
    const boot = JSON.parse(bootRaw)
    assert.equal(boot.ok, true)
    assert.equal(boot.phase, 'structured-bootstrap')

    const d2 = await preStep(imagePayload, next)
    assert.equal(hasEvidenceReminder(d2), true)

    const describe = harness.toolDefs.get('vision_describe')
    assert.ok(describe)
    const r1 = await describe.execute({ paths: [pngPath], question: 'what is here?' }, exec)
    const j1 = JSON.parse(r1)
    assert.equal(j1.ok, false)
    assert.equal(j1.code, 'NO_USABLE_EVIDENCE')

    const d3 = await preStep(imagePayload, next)
    assert.equal(hasEvidenceReminder(d3), true)

    const colors = harness.toolDefs.get('vision_colors')
    assert.ok(colors)
    const requestsBefore = server.requests.length
    const r2 = await colors.execute({ image: pngPath }, exec)
    assert.equal(JSON.parse(r2).ok, undefined)
    assert.equal(server.requests.length, requestsBefore)

    const d4 = await preStep(imagePayload, next)
    assert.equal(hasEvidenceReminder(d4), false)

    const requestsBeforeBlock = server.requests.length
    const r3 = await describe.execute({ paths: [pngPath], question: 'again' }, exec)
    const j3 = JSON.parse(r3)
    assert.equal(j3.ok, false)
    assert.equal(j3.code, 'VISION_DEPTH_LIMIT')
    assert.equal(server.requests.length, requestsBeforeBlock)
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
