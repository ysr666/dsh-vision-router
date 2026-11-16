import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'

const DEFAULT_TIMEOUT_MS = 12_000
const MAX_TIMEOUT_MS = 30_000
const MAX_INPUT_BYTES = 24 * 1024 * 1024
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_PIXELS = 4_000_000
const MAX_IMAGE_SIDE = 4096
const MAX_ACTIVE_WORKERS = 2
const MAX_QUEUED_WORKERS = 16
let activeWorkers = 0
const waitingWorkers = []

function releaseNextWorker() {
  while (waitingWorkers.length > 0) {
    const next = waitingWorkers.shift()
    if (next.finished) continue
    next.finished = true
    clearTimeout(next.timer)
    next.signal?.removeEventListener('abort', next.abort)
    activeWorkers++
    next.resolve(makeReleaseWorker())
    break
  }
}
function makeReleaseWorker() {
  let used = false
  return () => {
    if (used) return
    used = true
    activeWorkers--
    releaseNextWorker()
  }
}
function acquireWorker(signal, waitMs) {
  if (signal?.aborted) return Promise.reject(error('OCR_CANCELLED', 'OCR cancelled'))
  if (activeWorkers < MAX_ACTIVE_WORKERS) {
    activeWorkers++
    return Promise.resolve(makeReleaseWorker())
  }
  if (waitingWorkers.length >= MAX_QUEUED_WORKERS) {
    return Promise.reject(error('OCR_BUSY', 'local OCR worker queue is full'))
  }
  return new Promise((resolve, reject) => {
    const task = { resolve, reject, signal, finished: false, timer: undefined, abort: undefined }
    const fail = (code, message) => {
      if (task.finished) return
      task.finished = true
      clearTimeout(task.timer)
      signal?.removeEventListener('abort', task.abort)
      const index = waitingWorkers.indexOf(task)
      if (index !== -1) waitingWorkers.splice(index, 1)
      reject(error(code, message))
    }
    task.abort = () => fail('OCR_CANCELLED', 'OCR cancelled')
    task.timer = setTimeout(() => fail('OCR_QUEUE_TIMEOUT', 'local OCR queue deadline exhausted'), waitMs)
    task.timer.unref?.()
    waitingWorkers.push(task)
    signal?.addEventListener('abort', task.abort, { once: true })
    if (signal?.aborted) task.abort()
  })
}

/**
 * In-memory, validated RGB24 transport for the native worker.
 * Image decoders remain Host-owned (sharp); native inference never parses
 * arbitrary PNG/JPEG/WebP bytes or reads user-controlled filesystem paths.
 */
export function encodeNativeOcrRgbFrame(rgb, width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 ||
      width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE ||
      width * height > MAX_IMAGE_PIXELS) {
    throw error('OCR_INVALID_DIMENSIONS', 'invalid local OCR image dimensions')
  }
  if (!(rgb instanceof Uint8Array) || rgb.byteLength !== width * height * 3) {
    throw error('OCR_INVALID_RGB', 'invalid local OCR RGB pixel buffer')
  }
  const frame = Buffer.allocUnsafe(20 + rgb.byteLength)
  frame.write('DVR3OCR1', 0, 'ascii')
  frame.writeUInt32LE(width, 8)
  frame.writeUInt32LE(height, 12)
  frame.writeUInt32LE(rgb.byteLength, 16)
  frame.set(rgb, 20)
  return frame
}

export class LocalOcrProcessError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LocalOcrProcessError'
    this.code = code
  }
}

function error(code, message) {
  return new LocalOcrProcessError(code, message)
}

function isValidOcrResult(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.text === 'string' &&
    value.text.length <= 250_000 &&
    (value.confidence === undefined || (
      typeof value.confidence === 'number' &&
      Number.isFinite(value.confidence) &&
      value.confidence >= 0 && value.confidence <= 1
    )) &&
    (value.uncertain === undefined || typeof value.uncertain === 'boolean')
}

/**
 * Experimental stability boundary. Does not enable/replace the production OCR engine.
 * The caller must provide a trusted, package-owned absolute executable path.
 * The native executable reads image bytes from stdin and writes one JSON result to stdout.
 *
 * No shell, no image path, no implicit cloud fallback, no inherited credentials.
 */
function runIsolatedLocalOcrProcess(imageBytes, {
  executable,
  args = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  maxOutputBytes = MAX_OUTPUT_BYTES,
} = {}) {
  if (!Buffer.isBuffer(imageBytes) || imageBytes.length === 0 || imageBytes.length > MAX_INPUT_BYTES) {
    return Promise.reject(error('OCR_INVALID_INPUT', 'invalid OCR image size'))
  }
  if (typeof executable !== 'string' || !isAbsolute(executable) || executable.includes('\0')) {
    return Promise.reject(error('OCR_UNTRUSTED_RUNNER', 'OCR executable path must be absolute and trusted'))
  }
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string' || value.includes('\0'))) {
    return Promise.reject(error('OCR_INVALID_ARGUMENTS', 'invalid OCR executable arguments'))
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(error('OCR_INVALID_TIMEOUT', 'invalid OCR timeout'))
  }
  const deadlineMs = Math.max(1, Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS))
  const limit = Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0
    ? Math.min(maxOutputBytes, MAX_OUTPUT_BYTES)
    : MAX_OUTPUT_BYTES
  if (signal?.aborted) return Promise.reject(error('OCR_CANCELLED', 'OCR cancelled'))

  return new Promise((resolve, reject) => {
    let done = false
    let child
    let timer
    let size = 0
    const buffers = []
    let spawnFailure = false

    const terminate = () => {
      try { child?.kill('SIGKILL') } catch {}
    }
    const abort = () => {
      terminate()
      settle(error('OCR_CANCELLED', 'OCR cancelled'))
    }
    const settle = (failure, result) => {
      if (done) return
      done = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else resolve(result)
    }

    try {
      // Limit the environment to OS runtime variables, not secrets or user-provided
      // proxy/configuration variables. The executable MUST be bundled and self-contained.
      const env = {}
      for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'LANG', 'LC_ALL']) {
        if (typeof process.env[name] === 'string') env[name] = process.env[name]
      }
      // Linux worker registers PR_SET_PDEATHSIG before reading RGB input.
      // A non-secret expected PID closes the fork/exec vs parent-SIGKILL race.
      if (process.platform === 'linux') env.DVR_OCR_PARENT_PID = String(process.pid)
      child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      })
    } catch {
      settle(error('OCR_SPAWN_FAILED', 'unable to start local OCR worker'))
      return
    }

    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => {
      terminate()
      settle(error('OCR_TIMEOUT', 'local OCR worker exceeded its deadline'))
    }, deadlineMs)
    timer.unref?.()

    child.on('error', () => {
      spawnFailure = true
      settle(error('OCR_SPAWN_FAILED', 'unable to start local OCR worker'))
    })
    // Some platforms write EPIPE after the worker exits early. Its exit status,
    // not this stream error, determines the OCR result.
    child.stdin.on('error', () => {})
    child.stderr.on('data', () => {}) // Never leak native stderr or sensitive images.
    child.stdout.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        terminate()
        settle(error('OCR_OUTPUT_LIMIT', 'local OCR output exceeded the size limit'))
        return
      }
      buffers.push(chunk)
    })
    child.on('close', (exitCode, exitSignal) => {
      if (done) return
      if (spawnFailure || exitCode !== 0 || exitSignal !== null) {
        settle(error('OCR_WORKER_FAILED', 'local OCR worker exited unsuccessfully'))
        return
      }
      try {
        const result = JSON.parse(Buffer.concat(buffers, size).toString('utf8'))
        if (!isValidOcrResult(result)) {
          settle(error('OCR_INVALID_RESULT', 'local OCR returned an invalid result'))
          return
        }
        settle(undefined, { ...result, engine: 'ncnn' })
      } catch {
        settle(error('OCR_INVALID_RESULT', 'local OCR returned invalid JSON'))
      }
    })
    if (signal?.aborted) {
      abort()
      return
    }
    child.stdin.end(imageBytes)
  })
}

/**
 * At most two native model instances can execute simultaneously. All other
 * requests wait in a bounded, abortable FIFO. This protects the Host against
 * a burst of 100+ concurrent images creating hundreds of native model copies.
 */
export async function runIsolatedLocalOcr(imageBytes, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw error('OCR_INVALID_TIMEOUT', 'invalid OCR timeout')
  }
  const budgetMs = Math.max(1, Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS))
  const started = performance.now()
  const release = await acquireWorker(options.signal, budgetMs)
  try {
    const remainingMs = budgetMs - (performance.now() - started)
    if (remainingMs <= 0) {
      throw error('OCR_QUEUE_TIMEOUT', 'local OCR queue deadline exhausted')
    }
    return await runIsolatedLocalOcrProcess(imageBytes, {
      ...options,
      timeoutMs: remainingMs,
    })
  } finally {
    release()
  }
}
