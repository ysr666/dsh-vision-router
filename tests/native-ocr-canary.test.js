import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import {
  verifyExperimentalNativeOcrBinary,
  decodeExperimentalOcrRgb,
  runExperimentalNativeOcrCanary,
} from '../src/lib/native-ocr-canary.js'

const digest = content => createHash('sha256').update(content).digest('hex')
async function localSharp() {
  const resolved = process.env.DVR_OCR_TEST_SHARP_PATH
    ? pathToFileURL(process.env.DVR_OCR_TEST_SHARP_PATH).href
    : 'sharp'
  const mod = await import(resolved)
  return mod.default ?? mod
}
const tiny = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nuF0AAAAASUVORK5CYII=',
  'base64',
)

test('binary integrity gate rejects untrusted, missing, changed and unsupported binaries', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'dvr-ocr-bin-'))
  const executable = path.join(folder, 'worker')
  const binaries = { [process.platform + '-' + process.arch]: digest('trusted') }
  try {
    await writeFile(executable, 'trusted')
    assert.deepEqual(await verifyExperimentalNativeOcrBinary(executable, {
      binaryDigests: binaries,
    }), { ok: true, digest: digest('trusted') })
    await writeFile(executable, 'evil!!')
    await assert.rejects(verifyExperimentalNativeOcrBinary(executable, {
      binaryDigests: binaries,
    }), { code: 'OCR_BINARY_INTEGRITY' })
    await assert.rejects(verifyExperimentalNativeOcrBinary('relative/worker'), {
      code: 'OCR_UNTRUSTED_RUNNER',
    })
    await assert.rejects(verifyExperimentalNativeOcrBinary(executable, {
      platform: 'linux', arch: 'riscv64',
    }), { code: 'OCR_UNSUPPORTED_PLATFORM' })
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('preview rejects corrupt binary before invoking any image decoder', async () => {
  let decoded = false
  await assert.rejects(runExperimentalNativeOcrCanary(tiny, {
    binaryPath: path.join(os.tmpdir(), 'no-native-ocr-file-abc'),
    modelDir: os.tmpdir(),
    loadSharp: async () => { decoded = true; throw new Error('must not decode') },
  }), { code: 'OCR_UNTRUSTED_RUNNER' })
  assert.equal(decoded, false)
})

test('preview validates input and cancellation before worker processing', async () => {
  await assert.rejects(decodeExperimentalOcrRgb(Buffer.alloc(0), {
    loadSharp: async () => { throw new Error('must not decode') },
  }), { code: 'OCR_INVALID_INPUT' })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runExperimentalNativeOcrCanary(tiny, {
    signal: controller.signal,
  }), { code: 'OCR_CANCELLED' })
  await assert.rejects(runExperimentalNativeOcrCanary(tiny, {
    timeoutMs: Number.NaN,
  }), { code: 'OCR_INVALID_TIMEOUT' })
})

test('sharp decodes a real RGB24 image without filesystem exposure', async (t) => {
  let sharp
  try { sharp = await localSharp() } catch {
    t.skip('sharp not available on this test machine')
    return
  }
  const input = await sharp({
    create: { width: 8, height: 6, channels: 3, background: { r: 8, g: 23, b: 47 } },
  }).png().toBuffer()
  const result = await decodeExperimentalOcrRgb(input, { loadSharp: async () => sharp })
  assert.equal(result.width, 8)
  assert.equal(result.height, 6)
  assert.equal(result.rgb.length, 8 * 6 * 3)
  assert.deepEqual([...result.rgb.subarray(0, 3)], [8, 23, 47])

  // DSH's durable attachment API returns Uint8Array, unlike fs.readBytes.
  // A non-zero byteOffset must not leak surrounding bytes into sharp.
  const framed = new Uint8Array(input.byteLength + 9)
  framed.fill(0xab)
  framed.set(input, 3)
  const attachmentBytes = framed.subarray(3, 3 + input.byteLength)
  const fromAttachment = await decodeExperimentalOcrRgb(attachmentBytes, {
    loadSharp: async () => sharp,
  })
  assert.equal(fromAttachment.width, result.width)
  assert.equal(fromAttachment.height, result.height)
  assert.deepEqual(fromAttachment.rgb, result.rgb)
  await assert.rejects(decodeExperimentalOcrRgb(new DataView(input.buffer), {
    loadSharp: async () => sharp,
  }), { code: 'OCR_INVALID_INPUT' })
})

test('actual private photographed textbook runs end-to-end ONLY when local env points to it', async (t) => {
  const photo = process.env.DVR_OCR_PRIVATE_PHOTO
  const executable = process.env.DVR_OCR_PRIVATE_BIN
  const models = process.env.DVR_OCR_PRIVATE_MODELS
  if (!photo || !executable || !models) {
    t.skip('private photo and native model assets are intentionally not packaged')
    return
  }
  const sharp = await localSharp()
  // Real Host attachment reads use Uint8Array, not necessarily Buffer.
  const bytes = Uint8Array.from(await readFile(photo))
  const result = await runExperimentalNativeOcrCanary(bytes, {
    binaryPath: executable, modelDir: models, loadSharp: async () => sharp,
    timeoutMs: 24_000,
  })
  const numbers = result.regions.flatMap(row => {
    const match = String(row.text).match(/^\s*(1[0-2]|[1-9])[.．]/)
    return match ? [Number(match[1])] : []
  })
  assert.deepEqual(numbers, Array.from({ length: 12 }, (_, i) => i + 1))
  assert.ok(result.text.includes('C2H2(g)'))
  assert.ok(result.reviewQueue.some(x => x.reason === 'numeric_text_overlapped_by_red_annotation'))
  assert.ok(result.uncertain)
})
