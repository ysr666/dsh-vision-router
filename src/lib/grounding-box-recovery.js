import { extractJson, parseBox } from './core-primitives.js'

// Model output is untrusted: never eval, repair arbitrary JSON, or treat bare
// numbers as coordinates. Recover only four uniquely named integer fields.
const MAX_LOOSE_BOX_CHARS = 8192
const KEYED_PIXEL = /(?:^|[^A-Za-z0-9_])["']?(x1|y1|x2|y2)["']?\s*[:=]\s*["'[(\s]{0,4}(\d{1,6})(?![\d.eE])(?=[\s,}\])"'\]]|$)/g

export function looseGroundingBoxFromText(text) {
  if (typeof text !== 'string' || text.length > MAX_LOOSE_BOX_CHARS) return undefined
  const fields = Object.create(null)
  for (const match of text.matchAll(KEYED_PIXEL)) {
    const key = match[1]
    if (Object.hasOwn(fields, key)) return undefined
    fields[key] = Number(match[2])
  }
  if (Object.keys(fields).length !== 4) return undefined
  return parseBox(fields)
}

export function parseGroundingBoxResponse(text) {
  const parsed = extractJson(text)
  const strict = parsed !== undefined ? parseBox(parsed) : undefined
  if (strict) {
    // JSON.parse silently selects the last duplicated object key; a conflicting
    // x1/y1/x2/y2 is not an unambiguous grounding result.
    if (typeof text === 'string' && text.length <= MAX_LOOSE_BOX_CHARS) {
      const seen = new Set()
      for (const match of text.matchAll(KEYED_PIXEL)) {
        if (seen.has(match[1])) return undefined
        seen.add(match[1])
      }
    }
    return strict
  }
  return looseGroundingBoxFromText(text)
}

function usableContentRect(rect, width, height) {
  if (!rect || !['x1', 'y1', 'x2', 'y2'].every((key) => Number.isInteger(rect[key]))) return undefined
  if (rect.x1 < 0 || rect.y1 < 0 || rect.x2 > width || rect.y2 > height) return undefined
  if (rect.x2 <= rect.x1 || rect.y2 <= rect.y1) return undefined
  return rect
}

/**
 * No silent coordinate-frame reinterpretation: a model supplying a source-space
 * box to a 1000px letterbox must retry, never become a plausible clamped box.
 * 2px covers the usual integer rounding error near content boundaries.
 */
export function assessGroundingBox(box, width, height, rect) {
  if (!box) return { ok: false, reason: 'missing or ambiguous coordinate fields' }
  if (![width, height].every((n) => Number.isInteger(n) && n > 0)) {
    return { ok: false, reason: 'invalid raster dimensions' }
  }
  if (box.x1 < 0 || box.y1 < 0 || box.x2 > width || box.y2 > height) {
    return { ok: false, reason: 'coordinates outside the supplied image frame' }
  }
  if (box.x2 - box.x1 < 2 || box.y2 - box.y1 < 2) {
    return { ok: false, reason: 'degenerate target sliver' }
  }
  const content = usableContentRect(rect, width, height)
  if (content && (
    box.x1 < content.x1 - 2 || box.y1 < content.y1 - 2 ||
    box.x2 > content.x2 + 2 || box.y2 > content.y2 + 2
  )) {
    return { ok: false, reason: 'coordinates extend into the letterbox padding' }
  }
  const normalized = content ? {
    x1: Math.max(box.x1, content.x1), y1: Math.max(box.y1, content.y1),
    x2: Math.min(box.x2, content.x2), y2: Math.min(box.y2, content.y2),
  } : box
  if (normalized.x2 - normalized.x1 < 2 || normalized.y2 - normalized.y1 < 2) {
    return { ok: false, reason: 'no usable target after removing letterbox padding' }
  }
  return { ok: true, box: normalized }
}
