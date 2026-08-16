// Regression suite for the vision failure chain: one broken backend (401 /
// 429 / outage) must never turn a text conversation into minutes of repeated
// vision tool calls. Covers the requested Test 1–Test 10 scenarios plus unit
// coverage for the pure resilience primitives.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyVisionFailure,
  createDeadline,
  combineSignals,
  createVisionCircuitBreaker,
  createVisionTurnMemory,
  buildVisionFailure,
  resultCodeForKinds,
  qwenKeyEndpointHint,
  VISION_RESULT_CODES,
  Config,
  apply,
} from '../index.js'

// ── pure primitives ────────────────────────────────────────────────────────

test('classifyVisionFailure maps status, codes and prose into the shared taxonomy', () => {
  const auth = new Error('qwen-token-plan-cn/qwen3.6-flash: 401 Invalid API-key provided')
  auth.status = 401
  assert.equal(classifyVisionFailure(auth).kind, 'AUTH')
  assert.equal(classifyVisionFailure(auth).retryableProvider, false)

  const rate = new Error('429 rate limited')
  rate.providerRetryAfterMs = 3000
  const rateKind = classifyVisionFailure(rate)
  assert.equal(rateKind.kind, 'RATE_LIMIT')
  assert.equal(rateKind.retryAfterMs, 3000)
  assert.equal(rateKind.retryableProvider, false)

  assert.equal(classifyVisionFailure(new Error('The operation timed out')).kind, 'TIMEOUT')
  assert.equal(classifyVisionFailure(new Error('socket hang up')).kind, 'NETWORK')
  assert.equal(classifyVisionFailure(new Error('HTTP 502 Bad Gateway')).kind, 'SERVER')
  assert.equal(classifyVisionFailure(new Error('model does not support image input')).kind, 'INVALID_REQUEST')
  assert.equal(classifyVisionFailure(new Error('insufficient credits')).kind, 'QUOTA')
  assert.equal(classifyVisionFailure(new Error('whatever else')).kind, 'OTHER')

  // AbortError from a deadline signal is a TIMEOUT, not a mystery failure.
  const abort = new Error('aborted')
  abort.name = 'AbortError'
  assert.equal(classifyVisionFailure(abort).kind, 'TIMEOUT')

  // LlmError-style branded codes win over prose.
  const coded = new Error('some prose')
  coded.code = 'AUTH'
  assert.equal(classifyVisionFailure(coded).kind, 'AUTH')
})

test('createDeadline shares one budget across sequential stages', async () => {
  const deadline = createDeadline(300)
  const first = deadline.remaining()
  assert.ok(first > 0 && first <= 300)
  assert.equal(deadline.expired(), false)
  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.equal(deadline.expired(), true)
  assert.equal(deadline.remaining(), 0)
  // An expired deadline yields an immediately-aborting signal. (Race it with a
  // ref'd timer: on Node <=22 the AbortSignal.timeout timer itself is unref'd,
  // so with an otherwise-empty loop the test must keep the loop alive.)
  const signal = deadline.signal()
  await Promise.race([
    new Promise((resolve) => {
      if (signal.aborted) return resolve()
      signal.addEventListener('abort', resolve, { once: true })
    }),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ])
  assert.equal(signal.aborted, true)
})

test('combineSignals returns undefined / single / combined signals', () => {
  assert.equal(combineSignals(undefined, null), undefined)
  const single = AbortSignal.timeout(5000)
  assert.equal(combineSignals(single), single)
  const combined = combineSignals(AbortSignal.timeout(5000), AbortSignal.timeout(5000))
  assert.ok(combined !== undefined)
  assert.equal(combined.aborted, false)
})

test('circuit breaker: AUTH trips until the credential fingerprint changes', () => {
  const breaker = createVisionCircuitBreaker()
  const key = 'qwen-a/qwen3.6-flash'
  const scope = 's1:1'
  breaker.record(key, 'fp-old-key', { kind: 'AUTH' }, scope)
  // Same credential: blocked.
  assert.equal(breaker.inspect(key, 'fp-old-key', scope).blocked, true)
  // Credential changed: released (regardless of the turn scope).
  assert.equal(breaker.inspect(key, 'fp-new-key', scope).blocked, false)
  assert.equal(breaker.inspect(key, 'fp-new-key', 's1:2').blocked, false)
  // Tripped again under the new credential: blocked again everywhere.
  breaker.record(key, 'fp-new-key', { kind: 'AUTH' }, scope)
  assert.equal(breaker.inspect(key, 'fp-new-key', scope).blocked, true)
  assert.equal(breaker.inspect(key, 'fp-new-key', 's1:2').blocked, true)
})

test('circuit breaker: AUTH trip expires after the TTL for unobservable credentials', () => {
  let now = 0
  const breaker = createVisionCircuitBreaker({ now: () => now, authTripTtlMs: 600000 })
  breaker.record('p/m', 'unresolved', { kind: 'AUTH' }, 's1:1')
  assert.equal(breaker.inspect('p/m', 'unresolved', 's1:1').blocked, true)
  now = 600001
  assert.equal(breaker.inspect('p/m', 'unresolved', 's1:1').blocked, false)
})

test('circuit breaker: 429 applies a Retry-After cooldown, then releases', () => {
  let now = 0
  const breaker = createVisionCircuitBreaker({ now: () => now })
  breaker.record('p/m', 'fp', { kind: 'RATE_LIMIT', retryAfterMs: 5000 }, 's1:1')
  assert.equal(breaker.inspect('p/m', 'fp', 's1:1').blocked, true)
  assert.equal(breaker.inspect('p/m', 'fp', 's1:1').reason, 'rate-limit')
  now = 4999
  assert.equal(breaker.inspect('p/m', 'fp', 's1:1').blocked, true)
  now = 5001
  assert.equal(breaker.inspect('p/m', 'fp', 's1:1').blocked, false)
})

test('circuit breaker: turn-scoped trips only block inside their own turn', () => {
  const breaker = createVisionCircuitBreaker()
  breaker.record('p/m', 'fp', { kind: 'INVALID_REQUEST' }, 's1:1')
  assert.equal(breaker.inspect('p/m', 'fp', 's1:1').blocked, true)
  assert.equal(breaker.inspect('p/m', 'fp', 's1:2').blocked, false)
})

test('turn memory marks allFailed and answers later calls instantly', () => {
  const memory = createVisionTurnMemory()
  assert.equal(memory.allFailed('s1:1'), false)
  memory.record('s1:1', 'p/m', 'AUTH')
  memory.markAllFailed('s1:1')
  assert.equal(memory.allFailed('s1:1'), true)
  // A new turn is a fresh scope.
  assert.equal(memory.allFailed('s1:2'), false)
  assert.deepEqual(memory.attempted('s1:1'), [{ backend: 'p/m', kind: 'AUTH' }])
})

test('resultCodeForKinds picks the dominant failure code', () => {
  assert.equal(resultCodeForKinds(['AUTH']), VISION_RESULT_CODES.AUTH_FAILED)
  assert.equal(resultCodeForKinds(['RATE_LIMIT']), VISION_RESULT_CODES.RATE_LIMITED)
  assert.equal(resultCodeForKinds(['TIMEOUT']), VISION_RESULT_CODES.TIMEOUT)
  assert.equal(resultCodeForKinds(['AUTH', 'RATE_LIMIT']), VISION_RESULT_CODES.BACKEND_UNAVAILABLE)
})

test('buildVisionFailure carries retryable:false and explicit code', () => {
  const failure = buildVisionFailure({
    code: VISION_RESULT_CODES.BACKEND_UNAVAILABLE_THIS_TURN,
    reason: 'x',
    attempted: [{ backend: 'p/m', kind: 'AUTH' }],
  })
  assert.equal(failure.ok, false)
  assert.equal(failure.retryable, false)
  assert.equal(failure.code, VISION_RESULT_CODES.BACKEND_UNAVAILABLE_THIS_TURN)
  assert.ok(failure.advice.includes('Do NOT call vision_describe'))
})

test('qwenKeyEndpointHint flags Token Plan key/endpoint mismatches without hardcoding providers', () => {
  const tokenPlanKey = qwenKeyEndpointHint('https://dashscope.aliyuncs.com/compatible-mode/v1', 'sk-sp-abc')
  assert.ok(tokenPlanKey.includes('Token Plan'), tokenPlanKey)
  const standardKey = qwenKeyEndpointHint('https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', 'sk-abc')
  assert.ok(standardKey.includes('Token Plan'), standardKey)
  // Matching pairs and irrelevant providers produce no hint.
  assert.equal(qwenKeyEndpointHint('https://token-plan.example.com/v1', 'sk-sp-abc'), '')
  assert.equal(qwenKeyEndpointHint('https://api.openai.com/v1', 'sk-abc'), '')
  assert.equal(qwenKeyEndpointHint('https://dashscope.aliyuncs.com/compatible-mode/v1', ''), '')
})

// ── harness-shaped integration mock ─────────────────────────────────────────

const PNG = Buffer.from('89504e470d0a1a0a0000000000000000', 'hex')
const IMG_ID = `sha256:${'a'.repeat(64)}`

const DEFAULT_CHANNEL_PROFILES = {
  'qwen-a': {
    api: 'openai-completions',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'QWEN_A_KEY',
  },
  'qwen-b': {
    api: 'openai-completions',
    baseURL: 'https://token-plan.example.cn/compatible-mode/v1',
    apiKeyEnv: 'QWEN_B_KEY',
  },
  'qwen-c': {
    api: 'openai-completions',
    baseURL: 'https://c.example/v1',
    apiKeyEnv: 'QWEN_C_KEY',
  },
}

/**
 * A harness-shaped ctx where the vision chain pairs are first-class mock
 * adapters whose stream behavior is scripted per `${provider}/${model}`:
 *   'text:<value>'        -> succeed with that text
 *   'fail:401 <message>'  -> error finish with an auth failure
 *   'fail:429 <message>'  -> error finish with a rate-limit failure
 *   'fail:503 <message>'  -> error finish with a server failure
 *   'hang'                -> wait until the signal aborts, then reject
 */
function mockVisionCtx({ key = 'sk-first', behaviors = {}, channelProfiles = DEFAULT_CHANNEL_PROFILES } = {}) {
  const adapters = new Map()
  const registrations = new Map()
  const tools = []
  const skills = []
  const on = new Map()
  const calls = new Map() // backendKey -> number of stream attempts
  let currentKey = key
  let attachmentSeq = 0
  let seamConfig = {}

  const passThrough = (provider) => ({
    providerInfo: (p) => ({ id: p, name: p }),
    providerRetryPolicy: () => undefined,
    listModels: async () => [],
    resolveModel: async (p, m) => ({
      provider: p,
      id: m,
      name: m,
      inputModalities: ['text', 'image'],
      context: { contextWindow: 128000 },
    }),
  })

  const llm = {
    registerAdapter(providers, adapter) {
      for (const provider of providers) {
        if (adapters.has(provider)) {
          const error = new Error(`an adapter for provider "${provider}" is already registered`)
          error.code = 'DUPLICATE_ADAPTER'
          throw error
        }
      }
      for (const provider of providers) {
        adapters.set(provider, adapter)
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
    listProviders() {
      return [...registrations.entries()].map(([provider, registration]) => {
        let info
        try {
          info = registration.adapter.providerInfo ? registration.adapter.providerInfo(provider) : undefined
        } catch {
          info = undefined
        }
        return { id: provider, name: info && info.name ? info.name : provider }
      })
    },
    async listModels(provider) {
      const hit = registrations.get(provider)
      if (hit === undefined || typeof hit.adapter.listModels !== 'function') return []
      return hit.adapter.listModels(provider)
    },
    async resolveModelInfo(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        inputModalities: ['text', 'image'],
        context: { contextWindow: 128000 },
      }
    },
    async *stream(options) {
      // Mirror the real llm service: a registered adapter with its own stream
      // serves the route (used by the wrapper-parity test); otherwise the
      // behavior router decides the outcome.
      const registration = registrations.get(options.provider)
      if (registration && typeof registration.adapter.stream === 'function') {
        yield* registration.adapter.stream(options)
        return
      }
      const backendKey = `${options.provider}/${options.model}`
      calls.set(backendKey, (calls.get(backendKey) ?? 0) + 1)
      const behavior = behaviors[backendKey] ?? 'text:ok'
      if (behavior === 'hang') {
        await new Promise((_resolve, reject) => {
          const signal = options.signal
          // Keepalive: on Node <=22 the AbortSignal.timeout timers are unref'd,
          // so an otherwise-empty event loop would let the test runner cancel
          // the pending test before the deadline fires. One ref'd timer keeps
          // the loop alive until either the abort lands or the safety fires.
          const keepalive = setTimeout(
            () => reject(new Error('test hang safety timeout (no abort signal fired)')),
            30000,
          )
          const onAbort = () => {
            clearTimeout(keepalive)
            reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
          }
          if (signal === undefined) return
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        })
        return
      }
      if (behavior.startsWith('fail:')) {
        const message = behavior.slice('fail:'.length)
        const code = /\b401\b/.test(message) ? 'AUTH' : /\b429\b/.test(message) ? 'RATE_LIMIT' : 'SERVER'
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message, code } },
        }
        return
      }
      const text = behavior.startsWith('text:') ? behavior.slice('text:'.length) : behavior
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  // The configured chain providers exist as registered (text-capable)
  // channels before apply() runs — like real pi-ai routes.
  for (const provider of Object.keys(channelProfiles)) {
    llm.registerAdapter([provider], passThrough(provider))
  }

  const ctx = {
    get(name) {
      if (name === 'settings') {
        return {
          get: (ns) => (ns === 'llm-pi-ai' ? { providers: channelProfiles } : undefined),
        }
      }
      if (name === 'credentials') {
        return { resolve: async () => ({ value: currentKey }) }
      }
      if (name === 'attachments') {
        return {
          async readImage() {
            return { data: PNG, ref: { attachmentId: `att-${attachmentSeq}`, mediaType: 'image/png' } }
          },
          async saveImage() {
            attachmentSeq += 1
            return { attachmentId: `att-${attachmentSeq}`, mediaType: 'image/png' }
          },
        }
      }
      if (name === 'skills') {
        return {
          register: (skill) => {
            skills.push(skill)
            return () => {}
          },
        }
      }
      if (name === 'webServer') return { effect: () => () => {} }
      return undefined
    },
    logger: { warn() {}, info() {}, error() {} },
    effect(fn) {
      if (typeof fn === 'function') fn()
      return () => {}
    },
    on(event, handler) {
      on.set(event, handler)
    },
    inject(_deps, callback) {
      // settings seam: after apply() the resolved settings document wins —
      // mirror that by feeding the test's apply config back.
      const scope = {
        get: () => ({ ...Config({}), ...seamConfig }),
        watch: () => {},
      }
      callback({
        settings: { register: () => scope },
        effect: () => () => {},
      })
    },
    tools: {
      register(def) {
        tools.push(def)
        return () => {}
      },
    },
    llm,
  }

  return {
    ctx,
    adapters,
    registrations,
    tools,
    skills,
    on,
    calls,
    behaviors,
    setKey: (value) => {
      currentKey = value
    },
    setSeamConfig: (config) => {
      seamConfig = config
    },
  }
}

const fakeSession = (turn = 1) => ({
  id: 's1',
  events: [{ type: 'turn/start', data: { turn } }],
})

const firePreStep = async (mock, turn = 1) => {
  const handler = mock.on.get('agent/pre-step')
  assert.ok(handler, 'agent/pre-step handler must be registered')
  return handler(
    {
      agent: { session: fakeSession(turn) },
      turn,
    },
    async () => ({
      kind: 'ok',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', attachment: { attachmentId: IMG_ID, mediaType: 'image/png' } },
            { type: 'text', text: '这是谁' },
          ],
        },
      ],
    }),
  )
}

const visionConfig = (overrides = {}) =>
  Config({
    freeFallback: false,
    routing: false,
    visionTaskTimeoutMs: 20000,
    providers: [
      { provider: 'qwen-a', model: 'qwen3.6-flash' },
      { provider: 'qwen-b', model: 'qwen3.6-plus' },
    ],
    ...overrides,
  })

const applyAndMount = async (config, mockOptions = {}) => {
  const mock = mockVisionCtx(mockOptions)
  mock.setSeamConfig(config)
  apply(mock.ctx, config)
  await firePreStep(mock)
  return mock
}

const findTool = (mock, name) => mock.tools.find((def) => def.name === name)

const runDescribe = async (mock, extra = {}, turn = 1) => {
  const tool = findTool(mock, 'vision_describe')
  assert.ok(tool, 'vision_describe must be mounted')
  return tool.execute(
    { attachmentIds: [IMG_ID], question: '这是谁', ...extra },
    { agent: { session: fakeSession(turn) } },
  )
}

// ── Test 1: 401 provider trip ──────────────────────────────────────────────

test('Test 1: a 401 provider is tried exactly once and the next backend takes over', async () => {
  const mock = await applyAndMount(visionConfig(), {
    behaviors: {
      'qwen-a/qwen3.6-flash': 'fail:401 Invalid API-key provided',
      'qwen-b/qwen3.6-plus': 'text:一个年轻男性在舞台上',
    },
  })
  const result = await runDescribe(mock)
  assert.match(result, /年轻男性/)
  assert.equal(mock.calls.get('qwen-a/qwen3.6-flash'), 1)
  assert.equal(mock.calls.get('qwen-b/qwen3.6-plus'), 1)
})

// ── Test 2: repeated vision_describe must not re-hit the tripped 401 ───────

test('Test 2: a second vision_describe in the same turn skips the tripped provider and fails fast', async () => {
  const mock = await applyAndMount(visionConfig(), {
    behaviors: {
      'qwen-a/qwen3.6-flash': 'fail:401 Invalid API-key provided',
      'qwen-b/qwen3.6-plus': 'fail:503 Service Unavailable',
    },
  })
  const first = JSON.parse(await runDescribe(mock))
  assert.equal(first.ok, false)
  assert.equal(first.retryable, false)
  assert.equal(first.code, VISION_RESULT_CODES.BACKEND_UNAVAILABLE)
  assert.equal(mock.calls.get('qwen-a/qwen3.6-flash'), 1)

  const started = Date.now()
  const second = JSON.parse(await runDescribe(mock))
  assert.equal(second.ok, false)
  assert.equal(second.retryable, false)
  assert.equal(second.code, VISION_RESULT_CODES.BACKEND_UNAVAILABLE_THIS_TURN)
  // No network attempt at all for the second call.
  assert.equal(mock.calls.get('qwen-a/qwen3.6-flash'), 1)
  assert.equal(mock.calls.get('qwen-b/qwen3.6-plus'), 1)
  assert.ok(Date.now() - started < 2000, 'the turn-memory fast path must not wait')
})

// ── Test 3: 429 trip ───────────────────────────────────────────────────────

test('Test 3: a 429 provider is not retried and the next backend takes over', async () => {
  const mock = await applyAndMount(
    visionConfig({ cache: false }),
    {
      behaviors: {
        'qwen-a/qwen3.6-flash': 'fail:429 rate limited',
        'qwen-b/qwen3.6-plus': 'text:另一个后端成功了',
      },
    },
  )
  const result = await runDescribe(mock)
  assert.match(result, /另一个后端/)
  assert.equal(mock.calls.get('qwen-a/qwen3.6-flash'), 1)
  assert.equal(mock.calls.get('qwen-b/qwen3.6-plus'), 1)
  // The 429 cooldown keeps A blocked: a second describe in the same turn must
  // not call A again even though B gets another shot (cache is off).
  const again = await runDescribe(mock)
  assert.match(again, /另一个后端/)
  assert.equal(mock.calls.get('qwen-a/qwen3.6-flash'), 1)
  assert.equal(mock.calls.get('qwen-b/qwen3.6-plus'), 2)
})

// ── Test 4: all backends failed → classified result, no infinite retry ─────

test('Test 4: 401 + 429 + timeout produce one classified result instead of a retry storm', async () => {
  const mock = await applyAndMount(
    visionConfig({
      visionTaskTimeoutMs: 1000,
      providers: [
        { provider: 'qwen-a', model: 'qwen3.6-flash' },
        { provider: 'qwen-b', model: 'qwen3.6-plus' },
        { provider: 'qwen-c', model: 'qwen3.6-max' },
      ],
    }),
    {
      behaviors: {
        'qwen-a/qwen3.6-flash': 'fail:401 Invalid API-key provided',
        'qwen-b/qwen3.6-plus': 'fail:429 rate limited',
        'qwen-c/qwen3.6-max': 'hang',
      },
    },
  )
  const started = Date.now()
  const parsed = JSON.parse(await runDescribe(mock))
  assert.equal(parsed.ok, false)
  assert.equal(parsed.retryable, false)
  // Mixed kinds collapse to the generic unavailable code; each provider was
  // attempted exactly once.
  assert.equal(parsed.code, VISION_RESULT_CODES.BACKEND_UNAVAILABLE)
  assert.deepEqual(
    parsed.attemptedProviders.map((entry) => entry.kind),
    ['AUTH', 'RATE_LIMIT', 'TIMEOUT'],
  )
  assert.equal(mock.calls.get('qwen-a/qwen3.6-flash'), 1)
  assert.equal(mock.calls.get('qwen-b/qwen3.6-plus'), 1)
  assert.equal(mock.calls.get('qwen-c/qwen3.6-max'), 1)
  // The hanging provider was cut by the deadline, not left to run forever.
  assert.ok(Date.now() - started < 10000, `tool took ${Date.now() - started}ms`)
})

// ── Test 5: total task deadline ────────────────────────────────────────────

test('Test 5: hanging backends cannot multiply the task wall-clock', async () => {
  const mock = await applyAndMount(
    visionConfig({
      visionTaskTimeoutMs: 1000,
      providers: [
        { provider: 'qwen-a', model: 'qwen3.6-flash' },
        { provider: 'qwen-b', model: 'qwen3.6-plus' },
        { provider: 'qwen-c', model: 'qwen3.6-max' },
      ],
    }),
    {
      behaviors: {
        'qwen-a/qwen3.6-flash': 'hang',
        'qwen-b/qwen3.6-plus': 'hang',
        'qwen-c/qwen3.6-max': 'hang',
      },
    },
  )
  const started = Date.now()
  const parsed = JSON.parse(await runDescribe(mock))
  const elapsed = Date.now() - started
  // Three serial 120s timeouts would be 360s; the shared 1s budget must win.
  assert.equal(parsed.ok, false)
  assert.equal(parsed.code, VISION_RESULT_CODES.TIMEOUT)
  assert.ok(elapsed < 3000, `whole task took ${elapsed}ms, expected < 3000ms`)
})

// ── Test 6: OCR total budget ───────────────────────────────────────────────

test('Test 6: OCR shares one budget between tesseract and the vision fallback', async () => {
  const mock = await applyAndMount(
    visionConfig({
      ocrTimeoutMs: 1500,
      providers: [{ provider: 'qwen-a', model: 'qwen3.6-flash' }],
    }),
    { behaviors: { 'qwen-a/qwen3.6-flash': 'hang' } },
  )
  const ocr = findTool(mock, 'vision_ocr')
  assert.ok(ocr)
  // Force the vision path (no tesseract): the hanging backend must be cut by
  // the shared OCR deadline, not by a fresh 120s request timeout.
  const started = Date.now()
  const out = JSON.parse(
    await ocr.execute({ image: IMG_ID, engine: 'vision' }, { agent: { session: fakeSession() } }),
  )
  const elapsed = Date.now() - started
  assert.equal(out.ok, false)
  assert.equal(out.text, '')
  assert.equal(out.code, VISION_RESULT_CODES.TIMEOUT)
  assert.ok(elapsed < 4000, `OCR tool took ${elapsed}ms, expected < 4000ms`)
})

test('Test 6b: tesseract gets a capped slice and the vision fallback the remainder', () => {
  // Direct view of the budget slicing contract used by the OCR tools:
  // tesseract never exceeds 12s and both stages share ONE deadline, so the
  // two timeouts can never stack into a 60s + 120s wait.
  const roomy = createDeadline(30000)
  assert.equal(Math.min(12000, roomy.remaining()), 12000)
  const tight = createDeadline(8000)
  assert.ok(Math.min(12000, tight.remaining()) <= 8000)
  const shared = createDeadline(30000)
  const tesseractSlice = Math.min(12000, shared.remaining())
  assert.ok(tesseractSlice <= shared.remaining())
})

// ── Test 7: OCR tool description + injected prompts ────────────────────────

test('Test 7: injected descriptions forbid OCR-as-retry and demand stop-on-backend-failure', async () => {
  const config = visionConfig()
  const mock = mockVisionCtx()
  mock.setSeamConfig(config)
  apply(mock.ctx, config)

  // Capture the FIRST image-turn pre-step decision: it carries the auto-mount
  // reminder that tells the model how to behave on backend failures.
  const preStepHandler = mock.on.get('agent/pre-step')
  assert.ok(preStepHandler)
  const decision = await preStepHandler(
    { agent: { session: fakeSession(7) }, turn: 7 },
    async () => ({
      kind: 'ok',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', attachment: { attachmentId: IMG_ID, mediaType: 'image/png' } }],
        },
      ],
    }),
  )
  const reminder = decision.messages.at(-1).content[0].text
  assert.ok(reminder.includes('不要再改问法重复调用视觉工具'), reminder)
  assert.ok(reminder.includes('vision_ocr 只用于读取图片文字'), reminder)

  const ocr = findTool(mock, 'vision_ocr')
  assert.ok(ocr, 'vision_ocr must be mounted after the image pre-step')
  assert.ok(ocr.description.includes('does NOT recognize people'), ocr.description)
  assert.ok(ocr.description.includes('vision_ocr reads letters'), ocr.description)
  assert.ok(ocr.description.includes('do not chain these tools as retries'), ocr.description)

  const describe = findTool(mock, 'vision_describe')
  assert.ok(describe.description.includes('FAILURE SEMANTICS'), describe.description)
  assert.ok(describe.description.includes('Do NOT call vision_describe again'), describe.description)

  // The vision-tools skill (progressive mode) states the failure semantics too.
  const skill = mock.skills.find((entry) => entry.name === 'vision-tools')
  assert.ok(skill, 'vision-tools skill must be registered')
  assert.ok(skill.content.includes('失败语义'), skill.content)
  assert.ok(skill.content.includes('VISION_AUTH_FAILED'), skill.content)
})

// ── Test 8: backend unavailable carries retryable:false + explicit code ────

test('Test 8: the tool result exposes ok:false, retryable:false and a machine code', async () => {
  const mock = await applyAndMount(visionConfig(), {
    behaviors: {
      'qwen-a/qwen3.6-flash': 'fail:401 Invalid API-key provided',
      'qwen-b/qwen3.6-plus': 'fail:401 Invalid API-key provided',
    },
  })
  const parsed = JSON.parse(await runDescribe(mock))
  assert.equal(parsed.ok, false)
  assert.equal(parsed.retryable, false)
  assert.equal(parsed.code, VISION_RESULT_CODES.AUTH_FAILED)
  assert.ok(parsed.advice.includes('Do NOT call vision_describe'))
})

// ── Test 9: credential update releases the breaker ─────────────────────────

test('Test 9: a tripped 401 provider recovers once the credential changes', async () => {
  const mock = await applyAndMount(visionConfig(), {
    key: 'sk-bad',
    behaviors: {
      'qwen-a/qwen3.6-flash': 'fail:401 Invalid API-key provided',
      'qwen-b/qwen3.6-plus': 'fail:401 Invalid API-key provided',
    },
  })
  const first = JSON.parse(await runDescribe(mock))
  assert.equal(first.code, VISION_RESULT_CODES.AUTH_FAILED)

  // The user fixes the key and the backend recovers. New turn (fresh turn
  // memory) + new credential fingerprint must release the auth trip — the
  // breaker must not lock the provider out forever.
  mock.setKey('sk-good')
  mock.behaviors['qwen-a/qwen3.6-flash'] = 'text:修好后的回答'
  await firePreStep(mock, 2)
  const tool = findTool(mock, 'vision_describe')
  const second = await tool.execute(
    { attachmentIds: [IMG_ID], question: '这是谁' },
    { agent: { session: fakeSession(2) } },
  )
  assert.match(second, /修好后的回答/)
})

// ── Test 10: wrapper/twin parity ───────────────────────────────────────────

test('Test 10: a wrapped provider twin delegates with the same request config as the source', async () => {
  const delegations = []
  const mock = mockVisionCtx({
    channelProfiles: {
      'qwen-token-plan-cn': {
        api: 'openai-completions',
        baseURL: 'https://token-plan.example.cn/compatible-mode/v1',
        apiKeyEnv: 'QWEN_TOKEN_KEY',
      },
    },
  })
  // Replace the pass-through with a recording source adapter (the user's
  // configured pi-ai channel) BEFORE apply: the twin must delegate to it.
  const source = {
    providerInfo: (p) => ({ id: p, name: 'Qwen Token Plan CN' }),
    providerRetryPolicy: () => undefined,
    listModels: async () => [
      { id: 'qwen3.6-flash', name: 'Qwen3.6 Flash', inputModalities: ['text'] },
      { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', inputModalities: ['text'] },
    ],
    resolveModel: async (p, m) => ({ provider: p, id: m, name: m, inputModalities: ['text'] }),
    async *stream(options) {
      delegations.push({ ...options })
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  mock.registrations.delete('qwen-token-plan-cn')
  mock.adapters.delete('qwen-token-plan-cn')
  mock.ctx.llm.registerAdapter(['qwen-token-plan-cn'], source)

  const config = Config({
    freeFallback: false,
    routing: false,
    autoWrapProviders: true,
    wrappedProviders: [],
  })
  mock.setSeamConfig(config)
  apply(mock.ctx, config)

  // The twin must exist and mirror the source catalog with image input.
  const twin = mock.adapters.get('qwen-token-plan-cn-vision')
  assert.ok(twin, 'expected the qwen-token-plan-cn-vision twin route')
  const listed = await twin.listModels('qwen-token-plan-cn-vision')
  assert.deepEqual(listed.map((m) => m.id), ['qwen3.6-flash', 'qwen3.6-plus'])
  for (const model of listed) assert.deepEqual(model.inputModalities, ['text', 'image'])

  // A text turn through the twin delegates to the SOURCE provider byte-for-byte.
  for await (const _chunk of twin.stream({
    provider: 'qwen-token-plan-cn-vision',
    model: 'qwen3.6-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    /* drain */
  }
  assert.equal(delegations.length, 1)
  assert.equal(delegations[0].provider, 'qwen-token-plan-cn')
  assert.equal(delegations[0].model, 'qwen3.6-flash')

  // An image turn is rewritten for the text-only source instead of leaking
  // the image block, and still goes to the source provider.
  for await (const _chunk of twin.stream({
    provider: 'qwen-token-plan-cn-vision',
    model: 'qwen3.6-flash',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', attachment: { attachmentId: IMG_ID, name: 'p.png' } },
          { type: 'text', text: '这是谁' },
        ],
      },
    ],
  })) {
    /* drain */
  }
  assert.equal(delegations.length, 2)
  assert.equal(delegations[1].provider, 'qwen-token-plan-cn')
  assert.equal(delegations[1].messages[0].content.filter((b) => b.type === 'image').length, 0)
  // The rewritten marker still carries the no-retry guidance for the agent.
  const marker = delegations[1].messages[0].content[0].text
  assert.ok(marker.includes('vision_ocr 只用于读取图中文字'), marker)
  assert.ok(marker.includes('不要改问法重复调用'), marker)
})
