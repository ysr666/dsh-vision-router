export const GROUNDING_FRAME_SIZE = 1000

function finitePositiveInteger(value, name) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive finite number`)
  }
  return Math.max(1, Math.round(number))
}

/**
 * Build the exact geometry used to letterbox a source raster into the
 * grounding protocol's square frame. The rendered dimensions are integers so
 * callers can resize to these exact values before extending the canvas; the
 * inverse therefore never depends on a backend's resize policy.
 */
export function createGroundingFrame(width, height, frameSize = GROUNDING_FRAME_SIZE) {
  const sourceWidth = finitePositiveInteger(width, 'width')
  const sourceHeight = finitePositiveInteger(height, 'height')
  const size = finitePositiveInteger(frameSize, 'frameSize')
  const scale = Math.min(size / sourceWidth, size / sourceHeight)
  const renderedWidth = Math.max(1, Math.min(size, Math.round(sourceWidth * scale)))
  const renderedHeight = Math.max(1, Math.min(size, Math.round(sourceHeight * scale)))
  const left = Math.floor((size - renderedWidth) / 2)
  const top = Math.floor((size - renderedHeight) / 2)
  const right = size - renderedWidth - left
  const bottom = size - renderedHeight - top

  return Object.freeze({
    frameWidth: size,
    frameHeight: size,
    sourceWidth,
    sourceHeight,
    renderedWidth,
    renderedHeight,
    left,
    top,
    right,
    bottom,
    scaleX: renderedWidth / sourceWidth,
    scaleY: renderedHeight / sourceHeight,
  })
}

function finiteCoordinate(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max))
}

/** Map a box reported in the explicit square grounding frame back to source pixels. */
export function groundingFrameBoxToSource(box, frame) {
  if (!box || !frame) return undefined
  const x1 = finiteCoordinate(box.x1)
  const y1 = finiteCoordinate(box.y1)
  const x2 = finiteCoordinate(box.x2)
  const y2 = finiteCoordinate(box.y2)
  if ([x1, y1, x2, y2].some((value) => value === undefined)) return undefined

  const raw = {
    x1: (x1 - frame.left) / frame.scaleX,
    y1: (y1 - frame.top) / frame.scaleY,
    x2: (x2 - frame.left) / frame.scaleX,
    y2: (y2 - frame.top) / frame.scaleY,
  }
  const mapped = {
    x1: Math.floor(clamp(raw.x1, 0, frame.sourceWidth)),
    y1: Math.floor(clamp(raw.y1, 0, frame.sourceHeight)),
    x2: Math.ceil(clamp(raw.x2, 0, frame.sourceWidth)),
    y2: Math.ceil(clamp(raw.y2, 0, frame.sourceHeight)),
  }
  if (mapped.x2 <= mapped.x1 || mapped.y2 <= mapped.y1) return undefined
  return mapped
}

/** Map source-pixel geometry into the square frame, useful for protocol tests. */
export function sourceBoxToGroundingFrame(box, frame) {
  if (!box || !frame) return undefined
  const x1 = finiteCoordinate(box.x1)
  const y1 = finiteCoordinate(box.y1)
  const x2 = finiteCoordinate(box.x2)
  const y2 = finiteCoordinate(box.y2)
  if ([x1, y1, x2, y2].some((value) => value === undefined)) return undefined
  return {
    x1: frame.left + x1 * frame.scaleX,
    y1: frame.top + y1 * frame.scaleY,
    x2: frame.left + x2 * frame.scaleX,
    y2: frame.top + y2 * frame.scaleY,
  }
}
