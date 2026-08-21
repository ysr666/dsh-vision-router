import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VISION_BACKEND_SMOKE_TEST_CODE,
  classifyVisionSmokeFailure,
  normalizeVisionSmokeSelection,
  runExactVisionBackendSmokeTest,
} from '../lib/vision-backend-smoke-test.js'
import {
  EXACT_VISION_TEST_CLIENT,
  injectExactVisionTestClient,
} from '../lib/vision-backend-smoke-test-client.js'

test('normalizes exact smoke-test selection without accepting empty rows', () => {
  assert.deepEqual(normalizeVisionSmokeSelection({ provider: ' kimi ', model: ' moonshot-v1-vision ' }), {
    provider: 'kimi',
    model: 'moonshot-v1-vision',
  })
  assert.equal(normalizeVisionSmokeSelection({ provider: 'kimi', model: '' }), undefined)
  assert.equal(normalizeVisionSmokeSelection(undefined), undefined)
})

test('classifies common user-facing failures', () => {
  assert.equal(classifyVisionSmokeFailure(Object.assign(new Error('Unauthorized'), { status: 401 })), 'auth')
  assert.equal(classifyVisionSmokeFailure(new Error('model does not support image input')), 'unsupported-image')
  assert.equal(classifyVisionSmokeFailure(Object.assign(new Error('Too many requests'), { status: 429 })), 'rate-limit')
})

test('exact adapter smoke test sends one attachment and never invokes a fallback', async () => {
  let saved
  const seen = []
  const ctx = {
    get(name) {
      if (name === 'attachments') {
        return {
          async saveImage(value) {
            saved = value
            return { id: 'probe-image' }
          },
        }
      }
      return undefined
    },
    llm: {
      registration(provider) {
        return provider === 'kimi' ? { adapter: {} } : undefined
      },
      stream(options) {
        seen.push(options)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text-delta', text: VISION_BACKEND_SMOKE_TEST_CODE }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  }
  const result = await runExactVisionBackendSmokeTest({
    ctx,
    core: {},
    config: {},
    provider: 'kimi',
    model: 'kimi-vision',
    signal: new AbortController().signal,
    now: (() => { let n = 100; return () => (n += 25) })(),
  })
  assert.equal(result.ok, true)
  assert.equal(result.verified, true)
  assert.equal(result.fallbackUsed, false)
  assert.equal(result.transport, 'adapter')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].provider, 'kimi')
  assert.equal(seen[0].model, 'kimi-vision')
  assert.equal(seen[0].messages[0].content[0].type, 'image')
  assert.equal(saved.mediaType, 'image/png')
  assert.ok(Buffer.isBuffer(saved.data))
})

test('exact vision-http smoke test uses only the requested configured backend', async () => {
  const calls = []
  const core = {
    localProvidersOf() { return [] },
    httpProvidersOf() {
      return [
        { name: 'custom', baseURL: 'https://example.invalid/v1', model: 'vision-a', maxTokens: 99 },
        { name: 'fallback', baseURL: 'https://fallback.invalid/v1', model: 'vision-b' },
      ]
    },
    async callOpenAICompatible(provider, messages, options) {
      calls.push({ provider, messages, options })
      return 'The code is 731.'
    },
  }
  const result = await runExactVisionBackendSmokeTest({
    ctx: { get() { return undefined } },
    core,
    config: {},
    provider: 'vision-http',
    model: 'custom/vision-a',
    signal: new AbortController().signal,
  })
  assert.equal(result.ok, true)
  assert.equal(result.verified, true)
  assert.equal(result.fallbackUsed, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider.name, 'custom')
  assert.match(calls[0].messages[0].content[0].image_url.url, /^data:image\/png;base64,/)
  assert.equal(calls[0].options.maxTokens, 64)
})

test('client prelude is idempotent and yields to the v2 capability benchmark', () => {
  const original = '<html><head></head><body></body></html>'
  const once = injectExactVisionTestClient(original)
  const twice = injectExactVisionTestClient(once)
  assert.equal(once, twice)
  assert.match(once, /data-vision-router-exact-vision-test/)
  assert.match(EXACT_VISION_TEST_CLIENT, /data-vision-router-capability-benchmark/)
  assert.match(EXACT_VISION_TEST_CLIENT, /fallback is disabled/)
  assert.match(EXACT_VISION_TEST_CLIENT, /method:'POST'/)
})
