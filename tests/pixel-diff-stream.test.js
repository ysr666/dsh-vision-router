import assert from 'node:assert/strict'
import test from 'node:test'
import { compareRgbaStreams } from '../lib/pixel-diff-stream.js'

async function* chunks(buffer, sizes) {
  let offset = 0
  let index = 0
  while (offset < buffer.length) {
    const size = sizes[index % sizes.length]
    yield buffer.subarray(offset, Math.min(buffer.length, offset + size))
    offset += size
    index += 1
  }
}

test('streaming diff is exact across arbitrary unaligned chunk boundaries', async () => {
  const width = 4
  const height = 2
  const a = Buffer.from([
    0, 0, 0, 255,
    10, 10, 10, 255,
    20, 20, 20, 255,
    30, 30, 30, 255,
    40, 40, 40, 255,
    50, 50, 50, 255,
    60, 60, 60, 255,
    70, 70, 70, 255,
  ])
  const b = Buffer.from(a)
  b[4] = 100
  b[6 * 4 + 2] = 100

  const result = await compareRgbaStreams(chunks(a, [3, 5, 2]), chunks(b, [7, 1, 9]), {
    width,
    height,
    threshold: 16,
  })
  assert.equal(result.total, 8)
  assert.equal(result.differing, 2)
  assert.equal(result.ratio, 0.25)
  assert.equal(result.cells.reduce((sum, cell) => sum + cell.differing, 0), 2)
})

test('alpha-only changes match the legacy RGB-only diff semantics', async () => {
  const a = Buffer.from([1, 2, 3, 0])
  const b = Buffer.from([1, 2, 3, 255])
  const result = await compareRgbaStreams(chunks(a, [1]), chunks(b, [2]), {
    width: 1,
    height: 1,
    threshold: 0,
  })
  assert.equal(result.differing, 0)
})

test('streaming diff rejects early and trailing byte counts', async () => {
  const onePixel = Buffer.from([0, 0, 0, 255])
  await assert.rejects(
    compareRgbaStreams(chunks(onePixel, [4]), chunks(onePixel, [4]), { width: 2, height: 1 }),
    /ended early/,
  )
  await assert.rejects(
    compareRgbaStreams(
      chunks(Buffer.concat([onePixel, onePixel]), [8]),
      chunks(Buffer.concat([onePixel, onePixel]), [8]),
      { width: 1, height: 1 },
    ),
    /more RGBA bytes/,
  )
})
