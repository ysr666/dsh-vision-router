import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  OLLAMA_WARMUP_KEEP_ALIVE,
  createOllamaWarmupManager,
  installOllamaColdStartGuard,
  localOllamaIsPrimary,
  ollamaNativeApiUrl,
} from '../lib/ollama-cold-start.js'

async function startOllamaFake({ warmDelayMs = 0 } = {}) {
  const requests = []
  const server = createServer(async (req, res) => {
    if (req.url === '/api/ps' && req.method === 'GET') {
      requests.push({ path: req.url, method: req.method })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: [] }))
      return
    }
    if (req.url === '/api/generate' && req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      requests.push({ path: req.url, method: req.method, body })
      if (warmDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, warmDelayMs))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ done: true, response: '' }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('native Ollama URL keeps a reverse-proxy prefix while replacing /v1', () => {
  assert.equal(
    ollamaNativeApiUrl('http://127.0.0.1:11434/v1', 'generate').href,
    'http://127.0.0.1:11434/api/generate',
  )
  assert.equal(
    ollamaNativeApiUrl('https://example.test/ollama/v1/', 'ps').href,
    'https://example.test/ollama/api/ps',
  )
})

test('warmup coalesces concurrent cold loads and uses Ollama documented preload + keep_alive', async () => {
  const fake = await startOllamaFake({ warmDelayMs: 40 })
  const manager = createOllamaWarmupManager()
  try {
    const provider = { name: 'local-ollama', baseURL: fake.baseURL, model: 'qwen2.5vl' }
    const [a, b] = await Promise.all([
      manager.ensure(provider, { reason: 'one' }),
      manager.ensure(provider, { reason: 'two' }),
    ])
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.equal(fake.requests.filter((request) => request.path === '/api/ps').length, 1)
    const generate = fake.requests.filter((request) => request.path === '/api/generate')
    assert.equal(generate.length, 1)
    assert.deepEqual(generate[0].body, {
      model: 'qwen2.5vl',
      prompt: '',
      stream: false,
      keep_alive: OLLAMA_WARMUP_KEEP_ALIVE,
    })
  } finally {
    manager.dispose()
    await fake.close()
  }
})

test('automatic warmup is loopback-only and never turns a configured remote URL into a new side effect', async () => {
  let calls = 0
  const manager = createOllamaWarmupManager({
    fetchImpl: async () => {
      calls += 1
      throw new Error('must not be called')
    },
  })
  try {
    const result = await manager.ensure({
      name: 'local-ollama',
      baseURL: 'https://ollama.example/v1',
      model: 'vl',
    })
    assert.equal(result.ok, false)
    assert.equal(result.skipped, true)
    assert.equal(result.reason, 'non-loopback')
    assert.equal(calls, 0)
  } finally {
    manager.dispose()
  }
})

test('a dead Ollama is bounded by the short reachability probe, not the long model-load timeout', async () => {
  const manager = createOllamaWarmupManager({
    probeTimeoutMs: 20,
    warmupTimeoutMs: 1000,
    fetchImpl: async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      }),
  })
  const startedAt = Date.now()
  try {
    const result = await manager.ensure({
      name: 'local-ollama',
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'vl',
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'probe-failed')
    assert.ok(Date.now() - startedAt < 300, 'dead service should fail at the probe boundary')
  } finally {
    manager.dispose()
  }
})

test('routing order identifies when local Ollama is the first real backend', () => {
  assert.equal(
    localOllamaIsPrimary({ providers: [{ provider: 'vision-http', model: 'ovh/qwen' }] }),
    true,
  )
  assert.equal(
    localOllamaIsPrimary({
      providers: [
        { provider: 'vision-http', model: 'ovh/qwen' },
        { provider: 'zhipu-glm', model: 'glm-4.6v-flash' },
      ],
    }),
    false,
  )
})

function makeGuardHarness(settings) {
  const handlers = new Map()
  const adapters = new Map()
  const scope = {
    get: () => settings,
    watch() { return () => {} },
  }
  const settingsCtx = { settings: { register: () => scope }, effect() {} }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    llm: {
      registerAdapter(providers, adapter) {
        for (const provider of providers) adapters.set(provider, adapter)
        return () => {}
      },
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    inject(deps, callback) {
      if (deps.includes('settings')) callback(settingsCtx)
    },
    effect() {},
  }
  const core = {
    localOllamaProvidersOf(config) {
      if (config.localOllama?.enabled !== true) return []
      return [{
        name: 'local-ollama',
        baseURL: config.localOllama.baseURL || 'http://127.0.0.1:11434/v1',
        model: config.localOllama.model || 'qwen2.5vl',
      }]
    },
    blocksHaveImage(content) {
      return Array.isArray(content) && content.some((block) => block?.type === 'image')
    },
  }
  return { ctx, core, handlers, adapters, settingsCtx }
}

test('primary local Ollama cold load finishes in pre-step before the vision task starts', async () => {
  const settings = {
    localOllama: { enabled: true, model: 'qwen2.5vl' },
    providers: [{ provider: 'vision-http', model: 'ovh/qwen' }],
  }
  const harness = makeGuardHarness(settings)
  let releaseWarmup
  let handlerCalled = false
  const calls = []
  const manager = {
    ensure(provider, options) {
      calls.push(['ensure', provider.model, options.reason])
      return new Promise((resolve) => { releaseWarmup = () => resolve({ ok: true }) })
    },
    background(provider, options) { calls.push(['background', provider.model, options.reason]) },
    dispose() {},
  }
  const guarded = installOllamaColdStartGuard(harness.ctx, settings, harness.core, { manager })
  guarded.on('agent/pre-step', async () => { handlerCalled = true; return { kind: 'pass' } })

  const pending = harness.handlers.get('agent/pre-step')({
    messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'x' } }] }],
  })
  await Promise.resolve()
  assert.equal(handlerCalled, false, 'core pre-step must not start while the primary local model is cold')
  assert.ok(calls.some((call) => call[0] === 'ensure' && call[2] === 'image-pre-step-primary'))
  releaseWarmup()
  await pending
  assert.equal(handlerCalled, true)
})

test('a native visual provider stays latency-primary while Ollama warms only in background', async () => {
  const settings = {
    localOllama: { enabled: true, model: 'qwen2.5vl' },
    providers: [{ provider: 'zhipu-glm', model: 'glm-4.6v-flash' }],
  }
  const harness = makeGuardHarness(settings)
  let handlerCalled = false
  const calls = []
  const manager = {
    ensure() { throw new Error('must not block on fallback Ollama') },
    background(provider, options) { calls.push([provider.model, options.reason]) },
    dispose() {},
  }
  const guarded = installOllamaColdStartGuard(harness.ctx, settings, harness.core, { manager })
  guarded.on('agent/pre-step', async () => { handlerCalled = true; return { kind: 'pass' } })
  await harness.handlers.get('agent/pre-step')({
    messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'x' } }] }],
  })
  assert.equal(handlerCalled, true)
  assert.ok(calls.some((call) => call[1] === 'image-pre-step-fallback'))
})

test('text-only turns never trigger Ollama warmup', async () => {
  const settings = {
    localOllama: { enabled: true, model: 'qwen2.5vl' },
    providers: [{ provider: 'vision-http', model: 'ovh/qwen' }],
  }
  const harness = makeGuardHarness(settings)
  const calls = []
  const manager = {
    ensure() { calls.push('ensure'); return Promise.resolve({ ok: true }) },
    background(_provider, options) { calls.push(options.reason) },
    dispose() {},
  }
  const guarded = installOllamaColdStartGuard(harness.ctx, settings, harness.core, { manager })
  guarded.on('agent/pre-step', async () => ({ kind: 'pass' }))
  calls.length = 0 // ignore plugin-start background preload
  await harness.handlers.get('agent/pre-step')({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  })
  assert.deepEqual(calls, [])
})

test('successful local Ollama adapter calls renew residency without delaying the response', async () => {
  const settings = { localOllama: { enabled: true, model: 'qwen2.5vl' } }
  const harness = makeGuardHarness(settings)
  const calls = []
  const manager = {
    ensure() { return Promise.resolve({ ok: true }) },
    background(_provider, options) { calls.push(options.reason) },
    dispose() {},
  }
  const guarded = installOllamaColdStartGuard(harness.ctx, settings, harness.core, { manager })
  guarded.llm.registerAdapter(['vision-http'], {
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  calls.length = 0
  const chunks = []
  for await (const chunk of harness.adapters.get('vision-http').stream({ model: 'local-ollama/qwen2.5vl' })) {
    chunks.push(chunk)
  }
  assert.equal(chunks.at(-1)?.reason?.kind, 'stop')
  assert.deepEqual(calls, ['post-success-renewal'])
})
