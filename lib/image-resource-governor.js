import { currentVisionTurnBudgetSignal } from './turn-budget-context.js'

const MIB = 1024 * 1024
export const DEFAULT_IMAGE_RESOURCE_MAX_BYPASSES = 2

function abortError() {
  const error = new Error('image resource wait aborted')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

function effectiveSignal(explicit) {
  const ambient = currentVisionTurnBudgetSignal()
  if (!explicit) return ambient
  if (!ambient || ambient === explicit) return explicit
  return AbortSignal.any([explicit, ambient])
}

export function estimateDecodedBytes(
  width,
  height,
  { channels = 4, copies = 1, safetyFactor = 1.25 } = {},
) {
  const w = Math.max(0, Math.floor(Number(width) || 0))
  const h = Math.max(0, Math.floor(Number(height) || 0))
  const c = Math.max(1, Number(channels) || 4)
  const n = Math.max(1, Number(copies) || 1)
  const factor = Math.max(1, Number(safetyFactor) || 1)
  return Math.ceil(w * h * c * n * factor)
}

export function estimateImageOperationBytes(operation, width, height) {
  switch (operation) {
    case 'metadata':
      return 1 * MIB
    case 'preview':
    case 'annotation':
      return estimateDecodedBytes(width, height, { copies: 1, safetyFactor: 1.5 })
    case 'tile':
    case 'crop':
      return estimateDecodedBytes(width, height, { copies: 1, safetyFactor: 1.35 })
    case 'raw':
      return estimateDecodedBytes(width, height, { copies: 2, safetyFactor: 1.5 })
    case 'pixel-diff':
      return estimateDecodedBytes(width, height, { copies: 3, safetyFactor: 1.5 })
    default:
      return estimateDecodedBytes(width, height, { copies: 1, safetyFactor: 1.5 })
  }
}

export function scaledDimensions(width, height, maxPixels) {
  const w = Math.max(0, Math.floor(Number(width) || 0))
  const h = Math.max(0, Math.floor(Number(height) || 0))
  const limit = Math.max(1, Math.floor(Number(maxPixels) || 1))
  if (w <= 0 || h <= 0) return { width: w, height: h, scale: 1 }
  const pixels = w * h
  if (pixels <= limit) return { width: w, height: h, scale: 1 }
  const scale = Math.sqrt(limit / pixels)
  return {
    width: Math.max(1, Math.floor(w * scale)),
    height: Math.max(1, Math.floor(h * scale)),
    scale,
  }
}

export function scaleBox(box, fromWidth, fromHeight, toWidth, toHeight) {
  const sx = fromWidth > 0 ? toWidth / fromWidth : 1
  const sy = fromHeight > 0 ? toHeight / fromHeight : 1
  return {
    x1: Math.max(0, Math.round(box.x1 * sx)),
    y1: Math.max(0, Math.round(box.y1 * sy)),
    x2: Math.min(toWidth, Math.max(1, Math.round(box.x2 * sx))),
    y2: Math.min(toHeight, Math.max(1, Math.round(box.y2 * sy))),
  }
}

/**
 * Cover a long/large image with bounded tiles in reading order. Normal narrow
 * screenshots keep one full-width strip. Ultra-wide inputs split horizontally
 * as well so width * height never exceeds maxTilePixels.
 */
export function boundedOcrTiles(
  width,
  height,
  { chunkHeight = 1200, overlap = 120, maxTilePixels = 4_000_000 } = {},
) {
  const w = Math.max(1, Math.floor(Number(width) || 1))
  const h = Math.max(1, Math.floor(Number(height) || 1))
  const requestedHeight = Math.max(1, Math.min(h, Math.floor(Number(chunkHeight) || 1200)))
  const pixelLimit = Math.max(1, Math.floor(Number(maxTilePixels) || 4_000_000))
  const tileWidth = Math.min(w, Math.max(1, Math.floor(pixelLimit / requestedHeight)))
  const tileHeight = Math.min(requestedHeight, Math.max(1, Math.floor(pixelLimit / tileWidth)))
  const verticalOverlap = Math.min(
    Math.max(0, Math.floor(Number(overlap) || 0)),
    Math.max(0, Math.floor(tileHeight / 2)),
  )
  const verticalStep = Math.max(1, tileHeight - verticalOverlap)
  const tiles = []
  for (let top = 0; top < h; top += verticalStep) {
    const bottom = Math.min(h, top + tileHeight)
    for (let left = 0; left < w; left += tileWidth) {
      const right = Math.min(w, left + tileWidth)
      tiles.push({ left, right, top, bottom })
    }
    if (bottom >= h) break
  }
  return tiles
}

export class ImageResourceGovernor {
  constructor({
    maxBytes = 256 * MIB,
    maxConcurrent = 2,
    maxBypasses = DEFAULT_IMAGE_RESOURCE_MAX_BYPASSES,
  } = {}) {
    this.maxBytes = Math.max(1, Math.floor(Number(maxBytes) || 256 * MIB))
    this.maxConcurrent = Math.max(1, Math.floor(Number(maxConcurrent) || 2))
    this.maxBypasses = Math.max(0, Math.floor(Number(maxBypasses) || 0))
    this.activeBytes = 0
    this.activeCount = 0
    this.activeExclusive = false
    this.queue = []
  }

  _normalize(bytes, exclusive) {
    const requested = Math.max(1, Math.ceil(Number(bytes) || 1))
    const wantsExclusive = exclusive === true || requested >= this.maxBytes
    return {
      requested,
      charged: Math.min(requested, this.maxBytes),
      exclusive: wantsExclusive,
    }
  }

  _canRun(request) {
    if (this.activeExclusive) return false
    if (request.exclusive) return this.activeCount === 0
    return (
      this.activeCount < this.maxConcurrent &&
      this.activeBytes + request.charged <= this.maxBytes
    )
  }

  _grant(item) {
    if (item.settled) return
    item.settled = true
    if (item.signal && item.abortHandler) {
      item.signal.removeEventListener('abort', item.abortHandler)
    }
    this.activeCount += 1
    this.activeBytes += item.request.charged
    if (item.request.exclusive) this.activeExclusive = true
    let released = false
    item.resolve(() => {
      if (released) return
      released = true
      this.activeCount = Math.max(0, this.activeCount - 1)
      this.activeBytes = Math.max(0, this.activeBytes - item.request.charged)
      if (item.request.exclusive) this.activeExclusive = false
      this._drain()
    })
  }

  /**
   * Find work that fits the current byte/concurrency window without letting a
   * large request permanently pin every smaller request behind it. Each blocked
   * non-exclusive request may be bypassed only a small, fixed number of times;
   * after that it becomes a fairness barrier until capacity is released.
   * Exclusive work is always a barrier immediately.
   */
  _nextRunnable() {
    const bypassed = []
    for (let index = 0; index < this.queue.length; index++) {
      const item = this.queue[index]
      if (!item || item.settled) continue
      if (this._canRun(item.request)) return { index, item, bypassed }
      if (item.request.exclusive || item.bypassCount >= this.maxBypasses) return undefined
      bypassed.push(item)
    }
    return undefined
  }

  _drain() {
    while (this.queue.length > 0) {
      while (this.queue[0]?.settled) this.queue.shift()
      if (this.queue.length === 0) return
      const selected = this._nextRunnable()
      if (!selected) return
      this.queue.splice(selected.index, 1)
      for (const item of selected.bypassed) item.bypassCount += 1
      this._grant(selected.item)
      if (selected.item.request.exclusive) return
    }
  }

  acquire(bytes, { signal, exclusive = false } = {}) {
    // Structured 1+x installs its remaining turn deadline in AsyncLocalStorage.
    // Even image helpers that historically passed `{}` now inherit that signal
    // while they wait in the resource queue, so an exhausted turn cannot leave
    // dead work queued behind another large image operation.
    const combinedSignal = effectiveSignal(signal)
    if (combinedSignal?.aborted) return Promise.reject(abortError())
    const request = this._normalize(bytes, exclusive)
    return new Promise((resolve, reject) => {
      const item = {
        request,
        signal: combinedSignal,
        resolve,
        reject,
        settled: false,
        abortHandler: undefined,
        bypassCount: 0,
      }
      item.abortHandler = () => {
        if (item.settled) return
        item.settled = true
        const index = this.queue.indexOf(item)
        if (index >= 0) this.queue.splice(index, 1)
        reject(abortError())
        this._drain()
      }
      if (combinedSignal) combinedSignal.addEventListener('abort', item.abortHandler, { once: true })
      if (this.queue.length === 0 && this._canRun(request)) {
        this._grant(item)
      } else {
        this.queue.push(item)
        this._drain()
      }
    })
  }

  async withBudget(bytes, options, fn) {
    const release = await this.acquire(bytes, options)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  stats() {
    return {
      maxBytes: this.maxBytes,
      maxConcurrent: this.maxConcurrent,
      activeBytes: this.activeBytes,
      activeCount: this.activeCount,
      queued: this.queue.filter((item) => !item.settled).length,
      exclusive: this.activeExclusive,
    }
  }
}

export const defaultImageResourceGovernor = new ImageResourceGovernor()
