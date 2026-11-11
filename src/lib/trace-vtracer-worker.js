import { parentPort, workerData } from 'node:worker_threads'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const vtracer = require('@visioncortex/vtracer')
const MAX_TRACE_PIXELS = 1_000_000

function assertDimensions(width, height, byteLength) {
  if (
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < 1 || height < 1 || width * height > MAX_TRACE_PIXELS ||
    byteLength !== width * height * 4
  ) throw new RangeError('invalid trace RGBA dimensions')
}

function grayPalette(gray, channels, width, height, steps) {
  const histogram = new Float64Array(256)
  const pixels = width * height
  for (let i = 0; i < pixels; i++) histogram[gray[i * channels]]++
  const count = Math.min(17, Math.max(2, steps + 1))
  const quantile = (fraction) => {
    let seen = 0
    for (let i = 0; i < 256; i++) {
      seen += histogram[i]
      if (seen >= fraction * pixels) return i
    }
    return 255
  }
  let centers = Array.from({ length: count }, (_, i) => quantile((i + 0.5) / count))
  for (let pass = 0; pass < 15; pass++) {
    const sums = new Float64Array(count)
    const sizes = new Float64Array(count)
    for (let value = 0; value < 256; value++) {
      const frequency = histogram[value]
      if (!frequency) continue
      let closest = 0
      let distance = Infinity
      for (let j = 0; j < count; j++) {
        const delta = Math.abs(value - centers[j])
        if (delta < distance) { closest = j; distance = delta }
      }
      sums[closest] += value * frequency
      sizes[closest] += frequency
    }
    centers = centers.map((v, j) => sizes[j] ? sums[j] / sizes[j] : v)
  }
  const values = [...new Set(centers.map((v) => Math.max(0, Math.min(255, Math.round(v)))))]
  if (values.length === 1) values.push(values[0] < 128 ? 255 : 0)
  return values.sort((a, b) => a - b).map((v) => '#' + v.toString(16).padStart(2, '0').repeat(3))
}

function colorPalette(palette, hasTransparency) {
  if (!Array.isArray(palette) || palette.length > 16 ||
    palette.some((p) => !p || typeof p.hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(p.hex))) {
    throw new RangeError('invalid trace color palette')
  }
  const colors = [...new Set(palette.map((p) => p.hex.toLowerCase()))]
  if (hasTransparency && !colors.includes('#ffffff')) colors.push('#ffffff')
  return colors
}

async function grayscaleTrace(bytes, steps) {
  if (!Number.isInteger(steps) || steps < 1 || steps > 16) {
    throw new RangeError('trace steps must be an integer between 1 and 16')
  }
  const sharpModule = await import(workerData.sharpUrl)
  const sharp = sharpModule.default ?? sharpModule
  const image = sharp(bytes, { failOn: 'error', limitInputPixels: MAX_TRACE_PIXELS })
  const { data, info } = await image.flatten({ background: '#ffffff' }).greyscale()
    .raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  if (width * height > MAX_TRACE_PIXELS || !channels) throw new RangeError('trace image exceeds pixel budget')
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const gray = data[i * channels]
    const offset = i * 4
    rgba[offset] = gray
    rgba[offset + 1] = gray
    rgba[offset + 2] = gray
    rgba[offset + 3] = 255
  }
  const palette = grayPalette(data, channels, width, height, steps)
  return vtracer.convertPixels(rgba, width, height, {
    preset: 'poster', mode: 'spline', hierarchical: 'cutout',
    palette, maxColors: palette.length, simplify: 0.5, optimize: 1,
  })
}

function colorTrace(data, width, height, palette) {
  assertDimensions(width, height, data.length)
  const raw = Buffer.from(data)
  let hasTransparency = false
  for (let i = 0; i < raw.length; i += 4) {
    const alpha = raw[i + 3]
    if (alpha !== 255) hasTransparency = true
    // Preserve existing DVR's opaque-white SVG artifact background.
    if (alpha === 0) {
      raw[i] = 255; raw[i + 1] = 255; raw[i + 2] = 255
    } else if (alpha < 255) {
      const a = alpha / 255
      raw[i] = Math.round(raw[i] * a + 255 * (1 - a))
      raw[i + 1] = Math.round(raw[i + 1] * a + 255 * (1 - a))
      raw[i + 2] = Math.round(raw[i + 2] * a + 255 * (1 - a))
    }
    raw[i + 3] = 255
  }
  const colors = colorPalette(palette, hasTransparency)
  if (colors.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width +
      '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height +
      '"><rect width="' + width + '" height="' + height + '" fill="#ffffff"/></svg>'
  }
  return vtracer.convertPixels(raw, width, height, {
    preset: 'poster', mode: 'spline', hierarchical: 'cutout',
    maxColors: colors.length, simplify: 0.5, optimize: 1,
  })
}

async function main() {
  const { mode } = workerData
  let svg
  if (mode === 'grayscale') {
    svg = await grayscaleTrace(Buffer.from(workerData.bytes), workerData.steps)
  } else if (mode === 'color') {
    svg = colorTrace(workerData.data, workerData.width, workerData.height, workerData.palette)
  } else {
    throw new RangeError('unsupported trace mode')
  }
  if (typeof svg !== 'string' || !/<svg[\s>]/.test(svg) || svg.length > 16 * 1024 * 1024) {
    throw new Error('vectorizer returned an invalid or oversized SVG')
  }
  // VTracer writes uppercase RGB hex codes; preserve DVR's lowercase palette contract.
  parentPort.postMessage({ ok: true, svg: svg.replace(/#[a-fA-F0-9]{6}\b/g, (hex) => hex.toLowerCase()) })
}

main().catch((error) => parentPort.postMessage({ error: String(error?.message ?? error) }))
