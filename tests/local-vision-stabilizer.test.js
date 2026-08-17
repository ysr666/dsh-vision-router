import test from 'node:test'
import assert from 'node:assert/strict'
import { installLocalVisionStabilizer } from '../lib/local-vision-stabilizer.js'

function makeCore() {
  const calls = []
  const localProvidersOf = (config = {}) => {
    const out = []
    if (config.localOllama?.enabled === true) out.push({
      name: 'local-ollama', baseURL: config.localOllama.baseURL || 'http://ollama/v1',
      model: config.localOllama.model || 'qwen2.5vl', maxTokens: 2048,
      ...(typeof config.localOllama.temperature === 'number' ? { temperature: config.localOllama.temperature } : {}),
      ...(typeof config.localOllama.top_p === 'number' ? { top_p: config.localOllama.top_p } : {}),
      ...(config.localOllama.format === 'anthropic' ? { format: 'anthropic' } : {}),
    })
    if (config.localLmStudio?.enabled === true && config.localLmStudio.model) out.push({
      name: 'local-lmstudio', baseURL: config.localLmStudio.baseURL || 'http://lm/v1',
      model: config.localLmStudio.model, maxTokens: 2048,
      ...(typeof config.localLmStudio.temperature === 'number' ? { temperature: config.localLmStudio.temperature } : {}),
      ...(typeof config.localLmStudio.top_p === 'number' ? { top_p: config.localLmStudio.top_p } : {}),
      ...(config.localLmStudio.format === 'anthropic' ? { format: 'anthropic' } : {}),
    })
    return out
  }
  return {
    calls,
    localProvidersOf,
    toOpenAIContent(blocks, bytesOf) {
      return blocks.map((block) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(bytesOf(block.attachment)).toString('base64')}` } }))
    },
    downscaleImage: async (bytes) => bytes,
    localDescribePrompt: () => 'describe',
    async callLocalBackend(provider, messages, options) {
      calls.push({ provider, messages, options })
      return 'local answer'
    },
    classifyVisionFailure: () => ({ kind: 'other' }),
    VISION_FAILURE_KINDS: { AUTH: 'auth', RATE_LIMIT: 'rate-limit', TIMEOUT: 'timeout' },
  }
}

function makeHarness(initial = {}) {
  let settings = { ...initial }
  let watcher
  const handlers = new Map()
  const toolDefs = new Map()
  const adapters = new Map()
  const webRoutes = new Map()
  const scope = {
    get: () => settings,
    watch(fn) { watcher = fn; return () => { if (watcher === fn) watcher = undefined } },
  }
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    tools: {
      register(def) {
        toolDefs.set(def.name, def)
        return () => { if (toolDefs.get(def.name) === def) toolDefs.delete(def.name) }
      },
    },
    llm: {
      registerAdapter(providers, adapter) {
        for (const provider of providers) adapters.set(provider, adapter)
        return () => { for (const provider of providers) if (adapters.get(provider) === adapter) adapters.delete(provider) }
      },
    },
    get(name) {
      if (name === 'attachments') return { readImage: async () => ({ data: Buffer.from('png') }) }
      if (name === 'credentials') return { resolve: async () => ({ value: '' }) }
      return undefined
    },
    on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event) },
    inject(deps, callback) {
      if (deps.includes('settings')) callback({ settings: { register: () => scope }, effect() {} })
      if (deps.includes('webServer')) callback({ webServer: { register(spec) { webRoutes.set(spec.path, spec); return () => webRoutes.delete(spec.path) } }, effect(fn) { return fn() } })
    },
    effect(fn) { return fn() },
  }
  return {
    ctx, scope, handlers, toolDefs, adapters, webRoutes,
    setSettings(next) { settings = { ...next }; if (watcher) watcher(settings) },
  }
}

function installSettingsLikeCore(stabilized) {
  let seenScope
  stabilized.inject(['settings'], (sctx) => {
    seenScope = sctx.settings.register('vision-router', {}, { base: {} })
    seenScope.watch(() => {})
  })
  return () => seenScope
}

test('pre-step caps instantDescribe to the vision task budget without changing normal timeout', async () => {
  const harness = makeHarness({ instantDescribe: true, timeoutMs: 120000, visionTaskTimeoutMs: 45000 })
  const core = makeCore()
  const { ctx: stabilized } = installLocalVisionStabilizer(harness.ctx, {}, core)
  const scopeOf = installSettingsLikeCore(stabilized)
  let seen
  stabilized.on('agent/pre-step', async () => { seen = scopeOf().get().timeoutMs })
  assert.equal(scopeOf().get().timeoutMs, 120000)
  await harness.handlers.get('agent/pre-step')()
  assert.equal(seen, 45000)
  assert.equal(scopeOf().get().timeoutMs, 120000)
})

test('wrapper stream suppresses the second automatic instantDescribe pass only while streaming', async () => {
  const harness = makeHarness({ instantDescribe: true })
  const core = makeCore()
  const { ctx: stabilized } = installLocalVisionStabilizer(harness.ctx, {}, core)
  const scopeOf = installSettingsLikeCore(stabilized)
  let inside
  stabilized.llm.registerAdapter(['deepseek-vision'], {
    async *stream() { inside = scopeOf().get().instantDescribe; yield { type: 'finish', reason: { kind: 'stop' } } },
  })
  assert.equal(scopeOf().get().instantDescribe, true)
  for await (const _ of harness.adapters.get('deepseek-vision').stream({})) {}
  assert.equal(inside, false)
  assert.equal(scopeOf().get().instantDescribe, true)
})

test('vision-http dispatches OpenAI local providers through callLocalBackend so sampling is preserved', async () => {
  const harness = makeHarness({
    localOllama: { enabled: true, baseURL: 'http://ollama/v1', model: 'vl', temperature: 0.3, top_p: 0.7 },
  })
  const core = makeCore()
  const { ctx: stabilized } = installLocalVisionStabilizer(harness.ctx, {}, core)
  installSettingsLikeCore(stabilized)
  let delegated = 0
  stabilized.llm.registerAdapter(['vision-http'], {
    async *stream() { delegated += 1; yield { type: 'finish', reason: { kind: 'stop' } } },
  })
  const chunks = []
  for await (const chunk of harness.adapters.get('vision-http').stream({
    model: 'local-ollama/vl',
    messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'x' } }, { type: 'text', text: 'what' }] }],
  })) chunks.push(chunk)
  assert.equal(delegated, 0)
  assert.equal(core.calls.length, 1)
  assert.equal(core.calls[0].provider.temperature, 0.3)
  assert.equal(core.calls[0].provider.top_p, 0.7)
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'local answer'))
})

test('vision-http leaves non-local models on the original adapter unchanged', async () => {
  const harness = makeHarness({ localOllama: { enabled: true, model: 'vl' } })
  const core = makeCore()
  const { ctx: stabilized } = installLocalVisionStabilizer(harness.ctx, {}, core)
  installSettingsLikeCore(stabilized)
  let delegated = 0
  stabilized.llm.registerAdapter(['vision-http'], {
    async *stream() { delegated += 1; yield { type: 'finish', reason: { kind: 'stop' } } },
  })
  for await (const _ of harness.adapters.get('vision-http').stream({ model: 'ovh/Qwen3.5', messages: [] })) {}
  assert.equal(delegated, 1)
  assert.equal(core.calls.length, 0)
})

test('desktop screenshot tool follows the persisted setting and remains absent when disabled', () => {
  const harness = makeHarness({ desktopScreenshot: false })
  const core = makeCore()
  const { ctx: stabilized } = installLocalVisionStabilizer(harness.ctx, {}, core)
  installSettingsLikeCore(stabilized)
  stabilized.tools.register({ name: 'vision_describe', execute() {} })
  stabilized.tools.register({ name: 'vision_screenshot', execute() {} })
  assert.equal(harness.toolDefs.has('vision_screenshot'), false)
  harness.setSettings({ desktopScreenshot: true })
  assert.equal(harness.toolDefs.has('vision_screenshot'), true)
  harness.setSettings({ desktopScreenshot: false })
  assert.equal(harness.toolDefs.has('vision_screenshot'), false)
})

test('connection probe falls through Ollama failure to LM Studio success', async () => {
  const harness = makeHarness({
    localOllama: { enabled: true, baseURL: 'http://ollama/v1', model: 'o' },
    localLmStudio: { enabled: true, baseURL: 'http://lm/v1', model: 'l' },
  })
  const core = makeCore()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('http://ollama')) throw new Error('offline')
    return new Response(JSON.stringify({ data: [{ id: 'l' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const { ctx: stabilized } = installLocalVisionStabilizer(harness.ctx, {}, core)
    installSettingsLikeCore(stabilized)
    stabilized.inject(['webServer'], (webCtx) => {
      webCtx.webServer.register({ path: '/_dsh/vision-router/test-connection', handler: async (_req, res) => { res.writeHead(599); res.end('{}') } })
    })
    const route = harness.webRoutes.get('/_dsh/vision-router/test-connection')
    let status
    let body = ''
    await route.handler({ method: 'GET' }, {
      writeHead(code) { status = code },
      end(value) { body = String(value ?? '') },
    })
    const parsed = JSON.parse(body)
    assert.equal(status, 200)
    assert.equal(parsed.backend, 'local-lmstudio')
    assert.equal(parsed.fallbackUsed, true)
    assert.equal(parsed.attempts.length, 2)
    assert.equal(parsed.attempts[0].ok, false)
    assert.equal(parsed.attempts[1].ok, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})
