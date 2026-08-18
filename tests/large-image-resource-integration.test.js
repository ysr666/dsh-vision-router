import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { downscaleImage } from '../index.js'

const HIGH_WIDTH = 6000
const HIGH_HEIGHT = 4000
const SAFE_PIXELS = 4_000_000

async function highResolutionFixture() {
  return sharp({
    create: {
      width: HIGH_WIDTH,
      height: HIGH_HEIGHT,
      channels: 3,
      background: { r: 238, g: 242, b: 247 },
    },
  })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

test('a high-resolution legal image is reduced to a usable semantic preview, not rejected', async () => {
  const input = await highResolutionFixture()
  assert.ok(input.length < 20 * 1024 * 1024, 'fixture must remain legal under the 20MB upload admission')

  const original = await sharp(input).metadata()
  assert.equal(original.width, HIGH_WIDTH)
  assert.equal(original.height, HIGH_HEIGHT)
  assert.ok(original.width * original.height > SAFE_PIXELS)

  const preview = await downscaleImage(input, SAFE_PIXELS)
  assert.ok(preview.length > 0)
  const meta = await sharp(preview).metadata()
  assert.ok((meta.width ?? Infinity) * (meta.height ?? Infinity) <= SAFE_PIXELS)
  assert.ok((meta.width ?? 0) > 0)
  assert.ok((meta.height ?? 0) > 0)
})

test('once metadata proves an image is oversized, damaged input cannot escape as the oversized original', async (t) => {
  const valid = await highResolutionFixture()
  // Keep the PNG signature + IHDR (dimensions) but remove most image data.
  // Some libvips builds can still salvage a preview with failOn:none; others
  // reject the decode. Both outcomes are safe. The forbidden outcome is the
  // old behavior: returning the proven-oversized source bytes unchanged.
  const truncated = valid.subarray(0, Math.min(128, valid.length))
  let meta
  try {
    meta = await sharp(truncated, { failOn: 'none' }).metadata()
  } catch {
    t.skip('this platform/libvips build rejects the truncated fixture during metadata inspection')
    return
  }
  if (!meta.width || !meta.height || meta.width * meta.height <= SAFE_PIXELS) {
    t.skip('this platform/libvips build did not retain oversized dimensions from the truncated fixture')
    return
  }

  try {
    const guarded = await downscaleImage(truncated, SAFE_PIXELS)
    assert.notStrictEqual(guarded, truncated, 'proven-oversized input must not be returned unchanged')
    const guardedMeta = await sharp(guarded, { failOn: 'none' }).metadata()
    assert.ok((guardedMeta.width ?? Infinity) * (guardedMeta.height ?? Infinity) <= SAFE_PIXELS)
  } catch (error) {
    assert.equal(error?.code, 'VISION_IMAGE_PREPROCESS_FAILED')
  }
})
