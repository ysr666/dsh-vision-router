import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')

// Install state is keyed by the concrete child_process module object. This
// keeps tests injectable and, more importantly, lets multiple Vision Router
// contexts share one process-level shim without overwriting each other.
const installStates = new WeakMap()

function extensionForBytes(input) {
  const bytes = Buffer.from(input)
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp'
  if (bytes.length >= 6) {
    const gif = bytes.toString('ascii', 0, 6)
    if (gif === 'GIF87a' || gif === 'GIF89a') return '.gif'
  }
  return '.img'
}

function cleanupTempDir(dir) {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    // Cleanup is best-effort. Never turn a successful OCR result into a tool
    // failure because antivirus/indexing briefly held the temporary file.
  }
}

/**
 * Wrap callback-style execFile so the legacy `options.input` shape used by
 * Vision Router's OCR helper becomes a real seekable input file for Tesseract.
 * Async child_process.execFile does not consume an `input` option, so without
 * this boundary no bytes/EOF reach the child and it waits until timeout.
 *
 * The wrapper can be deactivated. Deactivation turns it into an inert
 * delegator to the function it originally wrapped. This matters when another
 * plugin loads after Vision Router and captures this wrapper: unloading Vision
 * Router must not clobber the later plugin's process-level patch, and the
 * captured Vision Router layer must not spring back to life if that later
 * plugin subsequently restores what it captured.
 */
export function createTesseractExecFileCompat(execFileImpl) {
  if (typeof execFileImpl !== 'function') {
    throw new TypeError('createTesseractExecFileCompat: execFileImpl must be a function')
  }

  let active = true

  function tesseractExecFileCompat(file, args, options, callback) {
    if (!active) return execFileImpl.apply(this, arguments)

    const isTesseract = typeof file === 'string' && /(^|[\\/])tesseract(?:\.exe)?$/i.test(file)
    const readsStdin = Array.isArray(args) && (args[0] === 'stdin' || args[0] === '-')
    const hasInput =
      options &&
      typeof options === 'object' &&
      Object.prototype.hasOwnProperty.call(options, 'input') &&
      options.input !== undefined &&
      options.input !== null

    if (!isTesseract || !readsStdin || !hasInput || typeof callback !== 'function') {
      return execFileImpl.apply(this, arguments)
    }

    const bytes = Buffer.from(options.input)
    let dir
    let inputPath
    try {
      dir = mkdtempSync(path.join(tmpdir(), 'dsh-vision-router-ocr-'))
      inputPath = path.join(dir, `input${extensionForBytes(bytes)}`)
      writeFileSync(inputPath, bytes)
    } catch (error) {
      cleanupTempDir(dir)
      throw error
    }

    const { input: _ignoredInput, ...restOptions } = options
    const nextOptions = { ...restOptions, windowsHide: true }
    const nextArgs = [inputPath, ...args.slice(1)]

    try {
      return execFileImpl.call(this, file, nextArgs, nextOptions, (error, stdout, stderr) => {
        cleanupTempDir(dir)
        callback(error, stdout, stderr)
      })
    } catch (error) {
      cleanupTempDir(dir)
      throw error
    }
  }

  Object.defineProperty(tesseractExecFileCompat, 'deactivate', {
    configurable: false,
    enumerable: false,
    value() {
      active = false
    },
  })
  Object.defineProperty(tesseractExecFileCompat, 'active', {
    configurable: false,
    enumerable: false,
    get() {
      return active
    },
  })

  // Native execFile's custom promisify resolves { stdout, stderr }. Preserve
  // that contract because index.js destructures this exact shape.
  Object.defineProperty(tesseractExecFileCompat, promisify.custom, {
    configurable: true,
    value(file, args, options) {
      return new Promise((resolve, reject) => {
        tesseractExecFileCompat(file, args, options, (error, stdout, stderr) => {
          if (error) {
            if (error && typeof error === 'object') {
              try {
                error.stdout = stdout
                error.stderr = stderr
              } catch {
                // Preserve the original error if it is frozen/read-only.
              }
            }
            reject(error)
            return
          }
          resolve({ stdout, stderr })
        })
      })
    },
  })

  return tesseractExecFileCompat
}

/**
 * Install the narrow shim for the Vision Router context lifetime.
 * syncBuiltinESMExports updates index.js's already-imported execFile binding.
 *
 * Cleanup is chain-safe: only restore the original function when our wrapper
 * is still the process-level top layer. If another plugin patched execFile
 * later, leave that patch installed and merely deactivate our captured layer.
 */
export function installTesseractExecFileCompat(ctx, options = {}) {
  const moduleObject = options.childProcessModule ?? childProcess
  const syncBuiltin = options.syncBuiltinESMExports ?? syncBuiltinESMExports
  if (!moduleObject || typeof moduleObject !== 'object' || typeof moduleObject.execFile !== 'function') {
    throw new TypeError('installTesseractExecFileCompat: childProcessModule.execFile must be a function')
  }

  let state = installStates.get(moduleObject)
  if (state === undefined) {
    const originalExecFile = moduleObject.execFile
    const patchedExecFile = createTesseractExecFileCompat(originalExecFile)
    moduleObject.execFile = patchedExecFile
    try { syncBuiltin() } catch { /* keep the CJS patch even if ESM sync is unavailable */ }
    state = {
      count: 0,
      originalExecFile,
      patchedExecFile,
      syncBuiltin,
    }
    installStates.set(moduleObject, state)
  }
  state.count += 1

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    state.count = Math.max(0, state.count - 1)
    if (state.count !== 0) return

    // Always deactivate first. A later plugin may have captured this function
    // and still legitimately sit above us in the patch chain.
    try { state.patchedExecFile.deactivate?.() } catch { /* best effort */ }

    if (moduleObject.execFile === state.patchedExecFile) {
      moduleObject.execFile = state.originalExecFile
    }
    // Sync the ESM binding to whatever function is CURRENTLY authoritative:
    // either the original function or a later plugin's wrapper. This avoids
    // leaving index.js pinned to our now-inert layer after unload.
    try { state.syncBuiltin() } catch { /* best effort */ }
    installStates.delete(moduleObject)
  }

  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, 'vision-router: tesseract execFile input compatibility')
  }
  return dispose
}
