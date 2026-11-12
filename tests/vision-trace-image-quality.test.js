import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { posterizeSvgColor } from '../lib/core-primitives.js'

const svgImage = (body) => Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">' + body + '</svg>',
)
async function compare(source, { maxMAE, center, ring } = {}) {
  const input = await sharp(source).png().toBuffer()
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const svg = await posterizeSvgColor(data, info, 8, 10000)
  const expected = await sharp(input).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer()
  const actual = await sharp(Buffer.from(svg)).resize(info.width, info.height)
    .flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer()
  let deviation = 0
  for (let i = 0; i < actual.length; i++) deviation += Math.abs(expected[i] - actual[i])
  const mae = deviation / actual.length
  assert.ok(mae < maxMAE, 'trace color error ' + mae.toFixed(2) + ' > ' + maxMAE)
  const sampleAt = ([x, y]) => {
    const index = (y * info.width + x) * 3
    return actual[index] + actual[index + 1] + actual[index + 2]
  }
  if (center) assert.ok(sampleAt(center) > 690, 'white hole must remain transparent/white')
  if (ring) assert.ok(sampleAt(ring) < 300, 'dark ring must not be filled white')
  return { mae: +mae.toFixed(2), paths: (svg.match(/<path\b/g) ?? []).length }
}
test('color trace preserves black ring hole (regression for missing evenodd)', async () => {
  const input = svgImage('<rect width="128" height="128" fill="#ffffff"/><circle cx="64" cy="64" r="44" fill="#111111"/><circle cx="64" cy="64" r="21" fill="#ffffff"/>')
  const r = await compare(input, { maxMAE: 12, center: [64, 64], ring: [64, 25] })
  console.log('TRACE_HOLE_MAE=' + r.mae)
})
test('color trace preserves thin lines and letter holes instead of gray flooding', async () => {
  const input = svgImage('<rect width="128" height="128" fill="#ffffff"/><path d="M8 8H120V120H8Z M16 16H112V112H16Z M14 48H114 M14 53H114 M14 58H114" fill="none" stroke="#222222" stroke-width="1.5"/><text x="12" y="92" font-family="Arial" font-size="26" font-weight="bold" fill="#111111">TEST</text>')
  const r = await compare(input, { maxMAE: 14 })
  console.log('TRACE_FINE_LINES_MAE=' + r.mae)
})
test('color trace handles transparency against existing opaque white background', async () => {
  const input = svgImage('<circle cx="64" cy="64" r="48" fill="#eb3938"/><path d="M20 88 L64 18 L108 88Z" fill="#f5ce31"/><circle cx="64" cy="67" r="16" fill="#333333"/>')
  const r = await compare(input, { maxMAE: 14 })
  console.log('TRACE_ALPHA_MAE=' + r.mae)
})
test('color trace avoids uncontrolled error on poster-like gradient', async () => {
  const input = svgImage('<defs><linearGradient id="g"><stop offset="0" stop-color="#1432b0"/><stop offset=".5" stop-color="#edca50"/><stop offset="1" stop-color="#dc3945"/></linearGradient></defs><rect width="128" height="128" fill="url(#g)"/><circle cx="80" cy="55" r="33" fill="#ffffff" opacity=".72"/><path d="M0 114L60 51 128 120Z" fill="#09502a" opacity=".83"/>')
  const r = await compare(input, { maxMAE: 40 })
  console.log('TRACE_GRADIENT_MAE=' + r.mae)
})
