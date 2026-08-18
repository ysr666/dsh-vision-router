import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')

let installs = 0
let originalExecFile
let patchedExecFile

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
 */
export function createTesseractExecFileCompat(execFileImpl) {
  if (typeof execFileImpl !== 'function') {
    throw new TypeError('createTesseractExecFileCompat: execFileImpl must be a function')
  }

  function tesseractExecFileCompat(file, args, options, callback) {
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
 */
export function installTesseractExecFileCompat(ctx) {
  if (installs === 0) {
    originalExecFile = childProcess.execFile
    patchedExecFile = createTesseractExecFileCompat(originalExecFile)
    childProcess.execFile = patchedExecFile
    syncBuiltinESMExports()
  }
  installs += 1

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    installs = Math.max(0, installs - 1)
    if (installs === 0 && originalExecFile) {
      childProcess.execFile = originalExecFile
      syncBuiltinESMExports()
      originalExecFile = undefined
      patchedExecFile = undefined
    }
  }

  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, 'vision-router: tesseract execFile input compatibility')
  }
  return dispose
}
