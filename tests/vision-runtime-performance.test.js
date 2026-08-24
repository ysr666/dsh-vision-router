import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installCapabilityShadowRuntime } from '../lib/vision-capability-shadow.js'
import {
  contextWithVisionRuntimePerformance as contextWithVisionRuntimePerformanceRaw,
  createVisionRuntimePerformanceStore,
  withVisionRuntimePerformanceScope,
} from '../lib/vision-runtime-performance.js'

function contextWithVisionRuntimePerformance(ctx, store, options = {}) {
  return contextWithVisionRuntimePerformanceRaw(ctx, store, {
    observationAllowed: () => true,
    ...options,
  })
}

function finishStream({ delay, now, kind = 'stop' } = {}) {
  return async function* () {
    if (delay) now.advance(delay)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'finish', reason: { kind } }
  }
}

function clock(start = 1_000) {
  let value = start
  const now = () => value
  now.advance = (ms) => { value += ms }
  return now
}

async function drain(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('runtime observer fails closed when no observation authority callback is supplied', async () => {
  const now = clock()
  const store = createVisionRuntimePerformanceStore({ now, minSamples: 1 })
  const ctx = contextWithVisionRuntimePerformanceRaw({
    llm: { stream: finishStream({ delay: 250, now }) },
  }, store, { now })
  await withVisionRuntimePerformanceScope('vision_ocr', {}, () =>
    drain(ctx.llm.stream({ provider: 'p', model: 'm' })))
  assert.equal(store.size(), 0)
})

test('one successful runtime sample is visible as warming evidence but not yet routing-eligible', async () => {
  const now = clock()
  const store = createVisionRuntimePerformanceStore({ now, minSamples: 2, maxAgeMs: 60_000 })
  const ctx = contextWithVisionRuntimePerformance({
    llm: { stream: finishStream({ delay: 400, now }) },
  }, store, { now })

  await withVisionRuntimePerformanceScope('vision_ocr', {}, () =>
    drain(ctx.llm.stream({ provider: 'p', model: 'm' })))

  const record = store.get('p/m')
  assert.equal(record.observedLatencyMsByAxis.ocr, 400)
  assert.equal(record.sampleCountByAxis.ocr, 1)
  assert.equal(record.runtimeLatencyMsByAxis.ocr, undefined)
})

test('two recent successful samples expose the median as routing runtime performance', async () => {
  const now = clock()
  const store = createVisionRuntimePerformanceStore({ now, minSamples: 2, maxSamples: 8, maxAgeMs: 60_000 })
  const delays = [800, 200]
  const ctx = contextWithVisionRuntimePerformance({
    llm: {
      stream() {
        return finishStream({ delay: delays.shift(), now })()
      },
    },
  }, store, { now })

  for (let i = 0; i < 2; i += 1) {
    await withVisionRuntimePerformanceScope('vision_ocr', {}, () =>
      drain(ctx.llm.stream({ provider: 'p', model: 'm' })))
  }

  const record = store.get('p/m')
  assert.equal(record.sampleCountByAxis.ocr, 2)
  assert.equal(record.observedLatencyMsByAxis.ocr, 500)
  assert.equal(record.runtimeLatencyMsByAxis.ocr, 500)
})

test('runtime performance expires dynamically while capability age remains a separate concern', () => {
  const now = clock()
  const store = createVisionRuntimePerformanceStore({ now, minSamples: 2, maxAgeMs: 3_600_000 })
  store.record('p/m', 'ocr', 500)
  now.advance(1_000)
  store.record('p/m', 'ocr', 700)
  assert.equal(store.get('p/m').runtimeLatencyMsByAxis.ocr, 600)
  now.advance(3_600_001)
  assert.equal(store.get('p/m'), undefined)
})

test('failed and aborted streams never become performance samples', async () => {
  for (const kind of ['error', 'aborted']) {
    const now = clock()
    const store = createVisionRuntimePerformanceStore({ now, minSamples: 1 })
    const ctx = contextWithVisionRuntimePerformance({
      llm: { stream: finishStream({ delay: 250, now, kind }) },
    }, store, { now })
    await withVisionRuntimePerformanceScope('vision_ocr', {}, () =>
      drain(ctx.llm.stream({ provider: 'p', model: kind })))
    assert.equal(store.get(`p/${kind}`), undefined)
  }
})

test('calls outside a direct visual-axis tool scope do not contaminate runtime performance', async () => {
  const now = clock()
  const store = createVisionRuntimePerformanceStore({ now, minSamples: 1 })
  const ctx = contextWithVisionRuntimePerformance({
    llm: { stream: finishStream({ delay: 300, now }) },
  }, store, { now })

  await drain(ctx.llm.stream({ provider: 'p', model: 'benchmark-like-call' }))
  await withVisionRuntimePerformanceScope('vision_detect', {}, () =>
    drain(ctx.llm.stream({ provider: 'p', model: 'unsupported-axis' })))

  assert.equal(store.size(), 0)
})

test('runtime samples are isolated by backend and direct axis', async () => {
  const now = clock()
  const store = createVisionRuntimePerformanceStore({ now, minSamples: 1 })
  const ctx = contextWithVisionRuntimePerformance({
    llm: {
      stream(options) {
        const delay = options.model === 'fast' ? 100 : 900
        return finishStream({ delay, now })()
      },
    },
  }, store, { now })

  await withVisionRuntimePerformanceScope('vision_ocr', {}, () =>
    drain(ctx.llm.stream({ provider: 'p', model: 'fast' })))
  await withVisionRuntimePerformanceScope('vision_long_screenshot_ocr', {}, () =>
    drain(ctx.llm.stream({ provider: 'p', model: 'slow' })))

  assert.equal(store.get('p/fast').runtimeLatencyMsByAxis.ocr, 100)
  assert.equal(store.get('p/fast').runtimeLatencyMsByAxis.document, undefined)
  assert.equal(store.get('p/slow').runtimeLatencyMsByAxis.document, 900)
})

test('changing deployment identity immediately discards same-name runtime speed evidence', () => {
  const identityContext = { identity: 'endpoint-A' }
  const store = createVisionRuntimePerformanceStore({
    minSamples: 2,
    context: identityContext,
    identityResolver: (_backendKey, ctx) => ctx.identity,
  })
  store.record('p/m', 'ocr', 100)
  store.record('p/m', 'ocr', 200)
  assert.equal(store.get('p/m').runtimeLatencyMsByAxis.ocr, 150)

  identityContext.identity = 'endpoint-B'
  assert.equal(store.get('p/m'), undefined)
  store.record('p/m', 'ocr', 900)
  const warming = store.get('p/m')
  assert.equal(warming.sampleCountByAxis.ocr, 1)
  assert.equal(warming.runtimeLatencyMsByAxis.ocr, undefined)
})

test('runtime observation follows live Auto authority', async () => {
  const now = clock()
  const runtimeStore = createVisionRuntimePerformanceStore({ now, minSamples: 1 })
  const registered = new Map()
  let routingMode = 'ordered'
  const base = {
    logger: { debug() {}, info() {}, warn() {} },
    get(name) {
      if (name === 'settings') {
        return {
          get() {
            return {
              routingMode,
              providers: [{ provider: 'p', model: 'm', fallbacks: [] }],
            }
          },
        }
      }
      return undefined
    },
    llm: {
      stream: finishStream({ delay: 350, now }),
      registration() { return { adapter: { constructor: { name: 'FakeAdapter' } } } },
      async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
    },
    tools: {
      register(def) {
        registered.set(def.name, def)
        return () => registered.delete(def.name)
      },
    },
  }
  const capabilityStore = { async get() { return undefined } }
  const core = {
    DEFAULT_HTTP_PROVIDERS: [],
    adapterAvailable: () => true,
    decideVisionBackendCapability: () => ({ image: true, attemptable: true }),
    localProvidersOf: () => [],
    httpProvidersOf: () => [],
  }
  const shadow = installCapabilityShadowRuntime(base, {}, core, {
    store: capabilityStore,
    runtimePerformanceStore: runtimeStore,
  })
  const observed = contextWithVisionRuntimePerformanceRaw(shadow, runtimeStore, {
    now,
    observationAllowed: () => routingMode === 'auto',
  })

  observed.tools.register({
    name: 'vision_ocr',
    async execute() {
      await drain(observed.llm.stream({ provider: 'p', model: 'm' }))
      return 'ok'
    },
  })

  assert.equal(await registered.get('vision_ocr').execute({}, { agent: { session: {} } }), 'ok')
  assert.equal(runtimeStore.get('p/m'), undefined)

  routingMode = 'auto'
  assert.equal(await registered.get('vision_ocr').execute({}, { agent: { session: {} } }), 'ok')
  assert.equal(runtimeStore.get('p/m').runtimeLatencyMsByAxis.ocr, 350)
  assert.equal(runtimeStore.get('p/m').sampleCountByAxis.ocr, 1)

  routingMode = 'ordered'
  assert.equal(await registered.get('vision_ocr').execute({}, { agent: { session: {} } }), 'ok')
  assert.equal(runtimeStore.get('p/m').sampleCountByAxis.ocr, 1)
})
