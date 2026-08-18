function asBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  return Buffer.from(chunk ?? [])
}

class AsyncByteReader {
  constructor(iterable) {
    if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') {
      throw new TypeError('pixel diff stream must be async iterable')
    }
    this.iterator = iterable[Symbol.asyncIterator]()
    this.buffer = Buffer.alloc(0)
    this.done = false
  }

  async fill(minBytes) {
    while (!this.done && this.buffer.length < minBytes) {
      const next = await this.iterator.next()
      if (next.done) {
        this.done = true
        break
      }
      const chunk = asBuffer(next.value)
      if (chunk.length === 0) continue
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    }
  }

  consume(bytes) {
    const out = this.buffer.subarray(0, bytes)
    this.buffer = this.buffer.subarray(bytes)
    return out
  }
}

function cellBounds(index, width, height, cols, rows) {
  const cx = index % cols
  const cy = Math.floor(index / cols)
  const cw = Math.ceil(width / cols)
  const ch = Math.ceil(height / rows)
  const x1 = cx * cw
  const y1 = cy * ch
  const x2 = Math.min((cx + 1) * cw, width)
  const y2 = Math.min((cy + 1) * ch, height)
  return { x1, y1, x2, y2, total: Math.max(0, x2 - x1) * Math.max(0, y2 - y1) }
}

/**
 * Exact RGB pixel comparison over two RGBA async streams. The function never
 * materializes either full frame; it holds only the current upstream chunks
 * plus a bounded region counter grid.
 */
export async function compareRgbaStreams(
  streamA,
  streamB,
  { width, height, threshold = 16, cols = 8, rows = 8 } = {},
) {
  const w = Math.max(1, Math.floor(Number(width) || 1))
  const h = Math.max(1, Math.floor(Number(height) || 1))
  const limit = w * h
  const gate = Number.isFinite(Number(threshold)) && Number(threshold) >= 0
    ? Number(threshold)
    : 16
  // Never create more logical cells than there are source pixels on an axis.
  // Otherwise a 4x2 image mapped into an 8x8 grid can place valid pixels into
  // cells whose computed bounds sit outside the image and silently drop them
  // from the worst-region summary.
  const gridCols = Math.min(w, Math.max(1, Math.floor(Number(cols) || 8)))
  const gridRows = Math.min(h, Math.max(1, Math.floor(Number(rows) || 8)))
  const cellDiff = new Uint32Array(gridCols * gridRows)
  const readerA = new AsyncByteReader(streamA)
  const readerB = new AsyncByteReader(streamB)
  let pixels = 0
  let differing = 0

  while (pixels < limit) {
    await Promise.all([readerA.fill(4), readerB.fill(4)])
    if (readerA.buffer.length < 4 || readerB.buffer.length < 4) break
    const remainingBytes = (limit - pixels) * 4
    const usable = Math.min(
      remainingBytes,
      Math.floor(Math.min(readerA.buffer.length, readerB.buffer.length) / 4) * 4,
    )
    if (usable <= 0) break
    const a = readerA.consume(usable)
    const b = readerB.consume(usable)
    const chunkPixels = usable / 4
    for (let i = 0; i < chunkPixels; i++) {
      const o = i * 4
      const different =
        Math.max(
          Math.abs(a[o] - b[o]),
          Math.abs(a[o + 1] - b[o + 1]),
          Math.abs(a[o + 2] - b[o + 2]),
        ) > gate
      if (!different) continue
      differing += 1
      const absolute = pixels + i
      const x = absolute % w
      const y = Math.floor(absolute / w)
      const cx = Math.min(gridCols - 1, Math.floor((x * gridCols) / w))
      const cy = Math.min(gridRows - 1, Math.floor((y * gridRows) / h))
      cellDiff[cy * gridCols + cx] += 1
    }
    pixels += chunkPixels
  }

  if (pixels !== limit) {
    throw new Error(`pixel diff stream ended early (${pixels}/${limit} pixels)`)
  }
  // Probe at most one additional chunk per stream. This validates that the
  // declared dimensions exactly match the stream without ever accumulating a
  // malicious amount of trailing data.
  await Promise.all([readerA.fill(1), readerB.fill(1)])
  if (readerA.buffer.length > 0 || readerB.buffer.length > 0) {
    throw new Error('pixel diff stream produced more RGBA bytes than the declared dimensions')
  }

  const cells = []
  for (let index = 0; index < cellDiff.length; index++) {
    const hit = cellDiff[index]
    if (hit === 0) continue
    const bounds = cellBounds(index, w, h, gridCols, gridRows)
    if (bounds.total <= 0) continue
    cells.push({
      x1: bounds.x1,
      y1: bounds.y1,
      x2: bounds.x2,
      y2: bounds.y2,
      ratio: hit / bounds.total,
      differing: hit,
      total: bounds.total,
    })
  }
  cells.sort((a, b) => b.ratio - a.ratio)
  return {
    differing,
    total: pixels,
    ratio: pixels === 0 ? 0 : differing / pixels,
    cells,
  }
}
