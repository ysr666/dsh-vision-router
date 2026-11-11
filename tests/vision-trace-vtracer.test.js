import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import {
  posterizeSvg, posterizeSvgColor, quantizeColors,
} from '../lib/core-primitives.js'

function colorSample() {
  const width = 64, height = 48
  const rgba = Buffer.alloc(width * height * 4, 255)
  for (let y = 10; y < 30; y++) for (let x = 20; x < 40; x++) {
    const i = (y * width + x) * 4
    rgba[i] = 220; rgba[i + 1] = 30; rgba[i + 2] = 30
  }
  return { rgba, info: { width, height } }
}

test('VTracer color output uses supplied palette, stable SVG and white holes', async () => {
  const { rgba, info } = colorSample()
  const palette = quantizeColors(rgba, 2)
  const outputs = await Promise.all(Array.from({ length: 4 }, () =>
    posterizeSvgColor(rgba, info, palette, 10000)))
  assert.equal(new Set(outputs).size, 1, 'parallel calls should be deterministic')
  assert.match(outputs[0], /<svg[\s>]/)
  assert.match(outputs[0], /<path\b/)
  console.log('TRACE_PALETTE', JSON.stringify(palette), 'SVG', outputs[0].slice(0, 500))
  const raster = await sharp(Buffer.from(outputs[0])).resize(info.width, info.height)
    .flatten({ background: '#ffffff' }).raw().toBuffer()
  const center = (20 * info.width + 30) * 3
  assert.ok(raster[center] > raster[center + 1], 'red region must be visibly red')
})

test('VTracer grayscale respects 1 and 4 posterization levels', async () => {
  const input = await sharp({
    create: { width: 128, height: 96, channels: 4, background: '#ffffff' },
  }).composite([{
    input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="96"><rect x="10" y="5" width="36" height="86" fill="#1a1a1a"/><rect x="49" y="5" width="38" height="86" fill="#777777"/><rect x="90" y="5" width="28" height="86" fill="#d0d0d0"/></svg>'),
  }]).png().toBuffer()
  const a = await posterizeSvg(input, 1, 'dominant', 8000)
  const b = await posterizeSvg(input, 4, 'dominant', 8000)
  assert.match(a, /<svg[\s>]/)
  assert.match(b, /<svg[\s>]/)
  assert.notEqual(a, b, 'steps must affect the output')
})

test('invalid color buffers and non-palettes are rejected', async () => {
  await assert.rejects(posterizeSvgColor(Buffer.alloc(4), { width: 64, height: 64 }, [{ hex: '#ffffff' }]), /RGBA/)
  await assert.rejects(posterizeSvgColor(Buffer.alloc(4), { width: 1, height: 1 }, [{ hex: 'javascript:foo' }]), /palette/)
})

test('AbortSignal cancels Worker and zero deadline is fail closed', async () => {
  const { rgba, info } = colorSample()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(posterizeSvgColor(rgba, info, [{ hex: '#ffffff' }], 10000, { signal: controller.signal }), /abort/i)
  await assert.rejects(posterizeSvgColor(rgba, info, [{ hex: '#ffffff' }], 0), /timed out/)
})

test('VTracer executes off-main-thread', async () => {
  const png = await sharp({ create: { width: 128, height: 128, channels: 4, background: '#ffffff' } }).png().toBuffer()
  const vectorizing = posterizeSvg(png, 4, 'dominant', 8000)
  const winner = await Promise.race([
    vectorizing.then(() => 'worker-done'),
    delay(0).then(() => 'main-timer'),
  ])
  assert.equal(winner, 'main-timer')
  await vectorizing
})
