import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ImageResourceGovernor,
  boundedOcrTiles,
  estimateDecodedBytes,
  estimateImageOperationBytes,
  scaleBox,
  scaledDimensions,
} from '../lib/image-resource-governor.js'
import { runWithVisionTurnBudget } from '../lib/turn-budget-context.js'

test('decoded working-set estimates scale with pixels and operation copies', () => {
  assert.equal(estimateDecodedBytes(100, 50, { channels: 4, copies: 1, safetyFactor: 1 }), 20_000)
  assert.ok(estimateImageOperationBytes('pixel-diff', 1000, 1000) > estimateImageOperationBytes('preview', 1000, 1000))
})

test('scaledDimensions preserves aspect ratio and target pixel bound', () => {
  const scaled = scaledDimensions(10_000, 10_000, 4_000_000)
  assert.ok(scaled.width * scaled.height <= 4_000_000)
  assert.ok(Math.abs(scaled.width / scaled.height - 1) < 0.001)
  assert.equal(scaledDimensions(1000, 1000, 4_000_000).scale, 1)
})

test('bounded OCR tiles cover tall images without exceeding tile pixel budget', () => {
  const tiles = boundedOcrTiles(2400, 20_000, {
    chunkHeight: 1200,
    overlap: 120,
    maxTilePixels: 4_000_000,
  })
  assert.ok(tiles.length > 1)
  assert.equal(tiles[0].left, 0)
  assert.equal(tiles[0].right, 2400)
  assert.equal(tiles[0].top, 0)
  assert.equal(tiles.at(-1).bottom, 20_000)
  for (const tile of tiles) {
    assert.ok((tile.right - tile.left) * (tile.bottom - tile.top) <= 4_000_000)
  }
})

test('bounded OCR tiles split ultra-wide images horizontally and cover every edge', () => {
  const tiles = boundedOcrTiles(20_000, 2400, {
    chunkHeight: 1200,
    overlap: 120,
    maxTilePixels: 4_000_000,
  })
  assert.ok(tiles.some((tile) => tile.left > 0))
  assert.ok(tiles.some((tile) => tile.right === 20_000))
  assert.ok(tiles.some((tile) => tile.bottom === 2400))
  for (const tile of tiles) {
    assert.ok((tile.right - tile.left) * (tile.bottom - tile.top) <= 4_000_000)
  }
})

test('scaleBox maps original coordinates to bounded preview coordinates', () => {
  assert.deepEqual(
    scaleBox({ x1: 100, y1: 50, x2: 900, y2: 450 }, 1000, 500, 500, 250),
    { x1: 50, y1: 25, x2: 450, y2: 225 },
  )
})

test('governor enforces both byte budget and concurrency', async () => {
  const governor = new ImageResourceGovernor({ maxBytes: 100, maxConcurrent: 2 })
  const releaseA = await governor.acquire(60)
  assert.deepEqual(governor.stats(), {
    maxBytes: 100,
    maxConcurrent: 2,
    activeBytes: 60,
    activeCount: 1,
    queued: 0,
    exclusive: false,
  })

  let grantedB = false
  const b = governor.acquire(60).then((release) => {
    grantedB = true
    return release
  })
  await Promise.resolve()
  assert.equal(grantedB, false)
  assert.equal(governor.stats().queued, 1)
  releaseA()
  const releaseB = await b
  assert.equal(grantedB, true)
  releaseB()
  assert.equal(governor.stats().activeCount, 0)
})

test('oversized estimates run exclusively rather than deadlocking forever', async () => {
  const governor = new ImageResourceGovernor({ maxBytes: 100, maxConcurrent: 3 })
  const releaseA = await governor.acquire(10)
  let grantedHuge = false
  const huge = governor.acquire(1000).then((release) => {
    grantedHuge = true
    return release
  })
  await Promise.resolve()
  assert.equal(grantedHuge, false)
  releaseA()
  const releaseHuge = await huge
  assert.equal(governor.stats().exclusive, true)
  assert.equal(governor.stats().activeBytes, 100)
  releaseHuge()
  assert.equal(governor.stats().activeBytes, 0)
})

test('aborting a queued request removes it without leaking a permit', async () => {
  const governor = new ImageResourceGovernor({ maxBytes: 100, maxConcurrent: 1 })
  const release = await governor.acquire(40)
  const controller = new AbortController()
  const queued = governor.acquire(40, { signal: controller.signal })
  assert.equal(governor.stats().queued, 1)
  controller.abort()
  await assert.rejects(queued, (error) => error && error.name === 'AbortError')
  assert.equal(governor.stats().queued, 0)
  release()
  assert.equal(governor.stats().activeCount, 0)
})

test('ambient structured-turn budget aborts queued image work even without an explicit call-site signal', async () => {
  const governor = new ImageResourceGovernor({ maxBytes: 100, maxConcurrent: 1 })
  const release = await governor.acquire(40)
  const controller = new AbortController()
  let queued
  await runWithVisionTurnBudget(
    { deadlineAt: Date.now() + 10_000, signal: controller.signal },
    async () => {
      queued = governor.acquire(40)
      assert.equal(governor.stats().queued, 1)
    },
  )
  controller.abort()
  await assert.rejects(queued, (error) => error && error.name === 'AbortError')
  assert.equal(governor.stats().queued, 0)
  release()
  assert.equal(governor.stats().activeCount, 0)
})

test('withBudget releases on thrown errors', async () => {
  const governor = new ImageResourceGovernor({ maxBytes: 100, maxConcurrent: 1 })
  await assert.rejects(
    governor.withBudget(80, {}, async () => {
      throw new Error('boom')
    }),
    /boom/,
  )
  assert.equal(governor.stats().activeBytes, 0)
  assert.equal(governor.stats().activeCount, 0)
})
