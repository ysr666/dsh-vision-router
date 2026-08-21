import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  contextWithVisionRuntimePerformance,
  createVisionRuntimePerformanceStore,
  withVisionRuntimePerformanceScope,
} from '../lib/vision-runtime-performance.js'

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