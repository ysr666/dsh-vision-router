import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { LocalOcrProcessError } from './native-ocr-supervisor.js'

// Reproducible PP-OCRv6 small -> ncnn conversion artifacts, pinned in the lab.
// Source ONNX revisions and license evidence belong in the release NOTICE/SBOM.
export const EXPERIMENTAL_OCR_MODEL_FILES = Object.freeze({
  'det.ncnn.bin': Object.freeze({
    bytes: 9813748,
    sha256: '720620c709ae18566e037f5ac086075553118c91fa2d289af405060e7d047357',
  }),
  'det.ncnn.param': Object.freeze({
    bytes: 18868,
    sha256: '986dbd2de4746574263bc616295435d9d775cf2092379ab4c0df42143205bfc4',
  }),
  'rec.ncnn.bin': Object.freeze({
    bytes: 21066500,
    sha256: '40f8afb7b9d835e8f5b7d03bd08d74d0f762b27999d05ffdf4644c1c4b24f798',
  }),
  'rec.ncnn.param': Object.freeze({
    bytes: 13845,
    sha256: 'ad92c23ca2cac8cfa414bc2b6b8c4ad73121f53543d7fb1d6953853b05fc5bda',
  }),
  'ppocrv6_dict.txt': Object.freeze({
    bytes: 74947,
    sha256: 'b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d',
  }),
})

function fail(code, message) {
  return new LocalOcrProcessError(code, message)
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Checks every distributed native model and its character dictionary before
 * starting the native worker. No downloading, rebuilding or replacing files.
 *
 * The real deployment must pin a platform-specific native executable digest
 * as well; this gate addresses the model asset closure only.
 */
export async function verifyNativeOcrAssets(modelDir, { files = EXPERIMENTAL_OCR_MODEL_FILES } = {}) {
  if (typeof modelDir !== 'string' || !isAbsolute(modelDir)) {
    throw fail('OCR_MODEL_PATH_INVALID', 'invalid native OCR model directory')
  }
  const dir = resolve(modelDir)
  let canonicalDir
  try {
    const directory = await lstat(dir)
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('not a real directory')
    canonicalDir = await realpath(dir)
  } catch {
    throw fail('OCR_MODEL_MISSING', 'native OCR model directory unavailable')
  }
  for (const [name, expected] of Object.entries(files)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
      throw fail('OCR_MODEL_MANIFEST_INVALID', 'invalid native OCR manifest filename')
    }
    if (!expected || !Number.isSafeInteger(expected.bytes) ||
        expected.bytes <= 0 || expected.bytes > 32 * 1024 * 1024 ||
        !/^[0-9a-f]{64}$/.test(expected.sha256)) {
      throw fail('OCR_MODEL_MANIFEST_INVALID', 'invalid native OCR manifest entry')
    }
    const path = join(dir, name)
    let stat
    try {
      stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file')
      const canonicalFile = await realpath(path)
      if (!canonicalFile.startsWith(canonicalDir + sep)) throw new Error('path escaped model directory')
    } catch {
      throw fail('OCR_MODEL_MISSING', 'required native OCR model asset missing')
    }
    if (stat.size !== expected.bytes) {
      throw fail('OCR_MODEL_INTEGRITY', 'native OCR model asset size mismatch')
    }
    let actual
    try { actual = await sha256(path) } catch {
      throw fail('OCR_MODEL_INTEGRITY', 'native OCR model asset unreadable')
    }
    if (actual !== expected.sha256) {
      throw fail('OCR_MODEL_INTEGRITY', 'native OCR model asset digest mismatch')
    }
  }
  return { ok: true, checked: Object.keys(files).length }
}
