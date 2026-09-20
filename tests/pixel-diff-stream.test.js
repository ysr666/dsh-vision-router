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

test('worst-region boxes follow the uniform pixel-to-cell map on non-multiple extents', async () => {
  // 9x1: every pixel belongs to a cell of the uniform partition
  // floor(x * 8 / 9); the last pixel x=8 must land inside its cell's box
  // instead of being dropped from the region summary entirely.
  const width = 9
  const height = 1
  const a = Buffer.alloc(width * height * 4)
  for (let i = 0; i < a.length; i += 4) a[i + 3] = 255
  const b = Buffer.from(a)
  b[8 * 4] = 200
  const result = await compareRgbaStreams(chunks(a, [4]), chunks(b, [6]), {
    width,
    height,
    threshold: 16,
  })
  assert.equal(result.differing, 1)
  assert.equal(result.cells.length, 1)
  const [cell] = result.cells
  assert.equal(cell.differing, 1)
  assert.ok(cell.x1 <= 8 && 8 < cell.x2, 'the differing pixel must sit inside its region box')
})

test('worst-region boxes do not drift a counted row below its box top', async () => {
  // 4096x2731 mirrors the >4MP screenshot path: the uniform map puts y=2393
  // in the last row band, so the box top must not start below that pixel.
  const width = 4096
  const height = 2731
  const a = Buffer.alloc(0)
  const row = Buffer.alloc(width * 4)
  for (let i = 0; i < row.length; i += 4) row[i + 3] = 255
  const changed = Buffer.from(row)
  for (let i = 0; i < changed.length; i += 4) changed[i] = 200
  async function* streamA() {
    for (let y = 0; y < height; y += 1) {
      yield y === 2393 ? changed : row
    }
    void a
  }
  async function* streamB() {
    for (let y = 0; y < height; y += 1) yield row
  }
  const result = await compareRgbaStreams(streamA(), streamB(), {
    width,
    height,
    threshold: 16,
  })
  assert.equal(result.differing, width)
  assert.equal(result.cells.length, 8)
  for (const cell of result.cells) {
    assert.ok(cell.y1 <= 2393 && 2393 < cell.y2, 'y=2393 must be inside its region box')
    assert.equal(cell.differing, width / 8)
  }
})
