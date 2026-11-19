import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import { runIsolatedLocalOcr, LocalOcrProcessError } from './native-ocr-supervisor.js'
import { runExperimentalNativeDocumentOcr } from './native-ocr-document.js'
import { verifyNativeOcrAssets } from './native-ocr-integrity.js'

const MAX_TIME_MS = 22_000
const MAX_DECODE_INPUT_BYTES = 24 * 1024 * 1024
const MAX_INPUT_PIXELS = 16_000_000
// Runtime pins for the exact owner-published resource pair (npm 1.0.0).
// Updated together with the verified public download catalog. The historical
// LAB identities remain in the audit fixture; this is not legal certification
// or minimum-OS runtime proof. Never bundle these assets in the main JS package.
export const EXPERIMENTAL_OCR_BINARY_SHA256 = Object.freeze({
  'darwin-arm64': '56499298089bc98709d3b6818fc870c8cf16c4c8607edd5ded842f304cbe84de',
  'win32-x64': 'd1d958de7d48474aac1b945cfa4d8f0a70c05745334322d00f776c17c70b7166',
})

function fail(code, description) {
  return new LocalOcrProcessError(code, description)
}
async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const buf of createReadStream(path)) hash.update(buf)
  return hash.digest('hex')
}

export async function verifyExperimentalNativeOcrBinary(binaryPath, {
  platform = process.platform,
  arch = process.arch,
  binaryDigests = EXPERIMENTAL_OCR_BINARY_SHA256,
} = {}) {
  const expected = binaryDigests[platform + '-' + arch]
  if (!expected) throw fail('OCR_UNSUPPORTED_PLATFORM', 'native OCR preview unsupported on this platform')
  if (typeof binaryPath !== 'string' || !isAbsolute(binaryPath)) {
    throw fail('OCR_UNTRUSTED_RUNNER', 'native OCR binary path must be absolute')
  }
  let info
  try {
    info = await lstat(binaryPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) {
      throw new Error('not a regular executable')
    }
    // On macOS /tmp is an OS-managed symlink to /private/tmp; requiring
    // literal canonical-path equality would reject legitimate runner files.
    // Reject a symlink at the file itself and pin file content by SHA-256.
    const canonical = await realpath(binaryPath)
    if (!isAbsolute(canonical)) throw new Error('invalid canonical path')
  } catch {
    throw fail('OCR_UNTRUSTED_RUNNER', 'native OCR runner missing or invalid')
  }
  const digest = await hashFile(binaryPath)
  if (digest !== expected) throw fail('OCR_BINARY_INTEGRITY', 'native OCR executable integrity mismatch')
  return { ok: true, digest }
}

function isAbort(signal, error) {
  return signal?.aborted || error?.code === 'OCR_CANCELLED' || error?.name === 'AbortError'
}

/**
 * Build the same strict RGB24 input used by the native ncnn worker. sharp is
 * Host-owned and supplied lazily; native code does not parse untrusted JPEG
 * and is never given an image file path. Existing image admission happens
 * before calling this function.
 */
export async function decodeExperimentalOcrRgb(bytes, {
  loadSharp,
  signal,
} = {}) {
  // DSH's attachment store returns Uint8Array; filesystem reads may be Buffer.
  // Normalize only byte views, preserving byteOffset/byteLength so no adjacent
  // ArrayBuffer content is decoded or transported to the native process.
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8 ||
    bytes.byteLength > MAX_DECODE_INPUT_BYTES) {
    throw fail('OCR_INVALID_INPUT', 'invalid image buffer')
  }
  const imageBuffer = Buffer.isBuffer(bytes)
    ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (signal?.aborted) throw fail('OCR_CANCELLED', 'OCR cancelled')
  if (typeof loadSharp !== 'function') throw fail('OCR_DECODER_MISSING', 'sharp loader unavailable')
  const sharp = await loadSharp()
  if (signal?.aborted) throw fail('OCR_CANCELLED', 'OCR cancelled')
  const { data, info } = await sharp(imageBuffer, {
    failOn: 'error',
    limitInputPixels: MAX_INPUT_PIXELS,
    sequentialRead: true,
  })
    .rotate()
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (signal?.aborted) throw fail('OCR_CANCELLED', 'OCR cancelled')
  if (!info || !Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) ||
    info.channels !== 3 || info.width < 1 || info.height < 1 ||
    info.width > 4096 || info.height > 4096 ||
    info.width * info.height > 4_000_000 ||
    data.byteLength !== info.width * info.height * 3) {
    throw fail('OCR_INVALID_RGB', 'decoded image outside native OCR limits')
  }
  return { rgb: data, width: info.width, height: info.height }
}

/**
 * Called only for explicit isolated canary tests or when auto mode finds an
 * approved owner-installed native worker; absent native assets cannot enable
 * OCR by themselves. The executable's hash AND all 5 model/charset file hashes
 * must match before the child process can be started.
 *
 * Returns full document OCR evidence for the caller to render conservatively.
 * Does not contact any vision service, change user settings or mutate images.
 */
export async function runExperimentalNativeOcrCanary(bytes, {
  binaryPath,
  modelDir,
  loadSharp,
  signal,
  timeoutMs = 18_000,
  platform = process.platform,
  arch = process.arch,
  binaryDigests,
} = {}) {
  if (signal?.aborted) throw fail('OCR_CANCELLED', 'OCR cancelled')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw fail('OCR_INVALID_TIMEOUT', 'invalid native OCR timeout')
  }
  const started = performance.now()
  const budget = Math.min(MAX_TIME_MS, Math.floor(timeoutMs))
  const left = () => budget - (performance.now() - started)
  // Cheap gate first: don't decode an untrusted image if model assets are broken.
  await verifyExperimentalNativeOcrBinary(binaryPath, { platform, arch, binaryDigests })
  if (signal?.aborted) throw fail('OCR_CANCELLED', 'OCR cancelled')
  await verifyNativeOcrAssets(modelDir)
  if (signal?.aborted) throw fail('OCR_CANCELLED', 'OCR cancelled')
  const { rgb, width, height } = await decodeExperimentalOcrRgb(bytes, { loadSharp, signal })
  if (left() <= 0) throw fail('OCR_TIMEOUT', 'native OCR time exhausted before inference')
  const nativeRun = (frame, options) => runIsolatedLocalOcr(frame, {
    executable: binaryPath,
    args: [modelDir],
    timeoutMs: Math.min(Math.max(1, left()), options.timeoutMs),
    signal,
  })
  const result = await runExperimentalNativeDocumentOcr(rgb, width, height, {
    nativeRun, signal, timeoutMs: Math.max(1, left()),
  })
  if (signal?.aborted) throw fail('OCR_CANCELLED', 'OCR cancelled')
  if (!result || typeof result.text !== 'string') {
    throw fail('OCR_INVALID_RESULT', 'native OCR returned malformed result')
  }
  return result
}
