import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, symlink, rm, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { verifyNativeOcrAssets } from '../src/lib/native-ocr-integrity.js'

const digest = (text) => createHash('sha256').update(text).digest('hex')

test('all model assets are pinned by both byte length and SHA-256', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'dvr-ocr-integrity-'))
  const file = path.join(folder, 'det.ncnn.bin')
  const expected = { 'det.ncnn.bin': { bytes: 3, sha256: digest('abc') } }
  try {
    await writeFile(file, 'abc')
    assert.deepEqual(await verifyNativeOcrAssets(folder, { files: expected }), { ok: true, checked: 1 })
    await writeFile(file, 'abd')
    await assert.rejects(verifyNativeOcrAssets(folder, { files: expected }), { code: 'OCR_MODEL_INTEGRITY' })
    await unlink(file)
    await assert.rejects(verifyNativeOcrAssets(folder, { files: expected }), { code: 'OCR_MODEL_MISSING' })
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test('invalid model paths and corrupted manifests fail closed', async () => {
  await assert.rejects(verifyNativeOcrAssets('relative/models'), { code: 'OCR_MODEL_PATH_INVALID' })
  await assert.rejects(verifyNativeOcrAssets(path.join(os.tmpdir(), 'ocr-missing-xxxx')), { code: 'OCR_MODEL_MISSING' })
  const folder = await mkdtemp(path.join(os.tmpdir(), 'dvr-ocr-invalid-manifest-'))
  try {
    await assert.rejects(verifyNativeOcrAssets(folder, { files: { '../escape': { bytes: 1, sha256: digest('a') } } }), { code: 'OCR_MODEL_MANIFEST_INVALID' })
    await assert.rejects(verifyNativeOcrAssets(folder, { files: { 'a.bin': { bytes: -1, sha256: digest('a') } } }), { code: 'OCR_MODEL_MANIFEST_INVALID' })
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test('symlinked model files do not bypass the integrity boundary', async (context) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dvr-ocr-links-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'dvr-ocr-outside-'))
  try {
    const source = path.join(outside, 's.bin')
    await writeFile(source, 'abc')
    try { await symlink(source, path.join(dir, 'det.ncnn.bin')) }
    catch { context.skip('symlink creation requires permission on this platform'); return }
    await assert.rejects(verifyNativeOcrAssets(dir, {
      files: { 'det.ncnn.bin': { bytes: 3, sha256: digest('abc') } },
    }), { code: 'OCR_MODEL_MISSING' })
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('actual PP-OCRv6 small models pass the pinned checksum gate when present', async (context) => {
  const dir = process.env.DVR_OCR_TEST_MODEL_DIR
  if (!dir) { context.skip('actual models not configured for this environment'); return }
  const result = await verifyNativeOcrAssets(dir)
  assert.deepEqual(result, { ok: true, checked: 5 })
})
