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

function colorPalette(palette) {
  if (!Array.isArray(palette) || palette.length > 16 ||
    palette.some((p) => !p || typeof p.hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(p.hex))) {
    throw new RangeError('invalid trace color palette')
  }
  // Exact-palette callers own their color choices. Never silently append
  // white (which could exceed the 16-color contract); alpha is still composited
  // against white before tracing.
  return [...new Set(palette.map((p) => p.hex.toLowerCase()))]
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
  // VTracer's palette option constrains color *selection* but does not force
  // grayscale pixel clustering. Without quantizing the raster itself,
  // smooth black-to-white gradients can collapse to a single solid path.
  // Explicitly posterize each input pixel to the nearest adaptive level.
  const paletteValues = palette.map((hex) => Number.parseInt(hex.slice(1, 3), 16))
  const lookup = new Uint8Array(256)
  for (let gray = 0; gray < 256; gray++) {
    let closest = paletteValues[0]
    let distance = Infinity
    for (const candidate of paletteValues) {
      const delta = Math.abs(candidate - gray)
      if (delta < distance) { distance = delta; closest = candidate }
    }
    lookup[gray] = closest
  }
  for (let i = 0; i < rgba.length; i += 4) {
    const q = lookup[rgba[i]]
    rgba[i] = q
    rgba[i + 1] = q
    rgba[i + 2] = q
  }
  return vtracer.convertPixels(rgba, width, height, {
    preset: 'poster', mode: 'spline', hierarchical: 'cutout',
    palette, maxColors: palette.length, simplify: 0.5, optimize: 1,
  })
}

function colorTrace(data, width, height, palette, colorLimit) {
  assertDimensions(width, height, data.length)
  const explicit = Array.isArray(palette)
  const colors = explicit ? colorPalette(palette) : undefined
  const maxColors = explicit ? Math.max(1, colors.length) : colorLimit
  if (!Number.isInteger(maxColors) || maxColors < 1 || maxColors > 16) {
    throw new RangeError('invalid trace color limit')
  }
  const raw = Buffer.from(data)
  for (let i = 0; i < raw.length; i += 4) {
    const alpha = raw[i + 3]
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
  if (explicit && colors.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width +
      '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height +
      '"><rect width="' + width + '" height="' + height + '" fill="#ffffff"/></svg>'
  }
  return vtracer.convertPixels(raw, width, height, {
    preset: 'poster', mode: 'spline', hierarchical: 'cutout',
    ...(explicit ? { palette: colors } : {}),
    maxColors, simplify: 0.5, optimize: 1,
  })
}

async function main() {
  const { mode } = workerData
  let svg
  if (mode === 'grayscale') {
    svg = await grayscaleTrace(Buffer.from(workerData.bytes), workerData.steps)
  } else if (mode === 'color') {
    svg = colorTrace(workerData.data, workerData.width, workerData.height,
      workerData.palette, workerData.colors)
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
