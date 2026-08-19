import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

// Install state is keyed by the concrete execFile function object. Multiple
// Vision Router contexts therefore share one custom-promisify shim without
// replacing child_process.execFile or affecting callback-style callers.
const installStates = new WeakMap()

function bytesView(input) {
  if (Buffer.isBuffer(input)) return input
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  }
  if (input instanceof ArrayBuffer) return Buffer.from(input)
  return Buffer.from(input)
}

function extensionForBytes(input) {
  const bytes = bytesView(input)
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp'
  if (bytes.length >= 6) {
    const gif = bytes.toString('ascii', 0, 6)
    if (gif === 'GIF87a' || gif === 'GIF89a') return '.gif'
  }
  return '.img'
}

function isCompatCall(file, args, options) {
  const isTesseract = typeof file === 'string' && /(^|[\\/])tesseract(?:\.exe)?$/i.test(file)
  const readsStdin = Array.isArray(args) && (args[0] === 'stdin' || args[0] === '-')
  const hasInput =
    options &&
    typeof options === 'object' &&
    Object.prototype.hasOwnProperty.call(options, 'input') &&
    options.input !== undefined &&
    options.input !== null
  return isTesseract && readsStdin && hasInput
}

function nativePromisified(execFileImpl, originalCustom) {
  if (typeof originalCustom === 'function') return originalCustom
  return (file, args, options) => new Promise((resolve, reject) => {
    execFileImpl(file, args, options, (error, stdout, stderr) => {
      if (error) {
        if (error && typeof error === 'object') {
          try {
            error.stdout = stdout
            error.stderr = stderr
          } catch {
            /* preserve the original error */
          }
        }
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/**
 * Create an async-only compatibility layer for promisify(execFile).
 *
 * Node's async execFile ignores an `options.input` field. Vision Router's OCR
 * caller historically supplied image bytes that way, so Tesseract waited on
 * stdin until timeout. Instead of replacing execFile process-wide, intercept
 * only its custom promisified form, materialize the one OCR input with
 * fs/promises, delegate to the native promisified implementation, then remove
 * the temporary directory asynchronously.
 */
export function createTesseractPromisifyCompat(execFileImpl, originalCustom, options = {}) {
  if (typeof execFileImpl !== 'function') {
    throw new TypeError('createTesseractPromisifyCompat: execFileImpl must be a function')
  }

  const delegate = nativePromisified(execFileImpl, originalCustom)
  const makeTempDir = options.mkdtemp ?? mkdtemp
  const writeTempFile = options.writeFile ?? writeFile
  const removeTempDir = options.rm ?? rm
  const tempDir = options.tempDir ?? tmpdir()
  let active = true

  async function tesseractPromisifyCompat(file, args, execOptions) {
    if (!active || !isCompatCall(file, args, execOptions)) {
      return delegate(file, args, execOptions)
    }

    const bytes = bytesView(execOptions.input)
    let dir
    try {
      dir = await makeTempDir(path.join(tempDir, 'dsh-vision-router-ocr-'))
      const inputPath = path.join(dir, `input${extensionForBytes(bytes)}`)
      await writeTempFile(inputPath, bytes)

      const { input: _ignoredInput, ...restOptions } = execOptions
      const nextOptions = { ...restOptions, windowsHide: true }
      const nextArgs = [inputPath, ...args.slice(1)]
      return await delegate(file, nextArgs, nextOptions)
    } finally {
      if (dir) {
        try {
          await removeTempDir(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
        } catch {
          // Cleanup is best-effort. Antivirus/indexing may briefly hold the
          // file; never turn a successful OCR result into a tool failure.
        }
      }
    }
  }

  Object.defineProperty(tesseractPromisifyCompat, 'deactivate', {
    configurable: false,
    enumerable: false,
    value() { active = false },
  })
  Object.defineProperty(tesseractPromisifyCompat, 'active', {
    configurable: false,
    enumerable: false,
    get() { return active },
  })

  return tesseractPromisifyCompat
}

/**
 * Install the narrow promisify compatibility for the Vision Router context.
 * Callback-style child_process.execFile is never replaced. Cleanup is
 * chain-safe: if another plugin replaces execFile[promisify.custom] later, its
 * value remains authoritative while our captured wrapper becomes inert.
 */
export function installTesseractExecFileCompat(ctx, options = {}) {
  const moduleObject = options.childProcessModule ?? awaitableChildProcess()
  if (!moduleObject || typeof moduleObject !== 'object' || typeof moduleObject.execFile !== 'function') {
    throw new TypeError('installTesseractExecFileCompat: childProcessModule.execFile must be a function')
  }

  const execFileImpl = moduleObject.execFile
  let state = installStates.get(execFileImpl)
  if (state === undefined) {
    const originalCustom = execFileImpl[promisify.custom]
    const patchedCustom = createTesseractPromisifyCompat(execFileImpl, originalCustom, options)
    execFileImpl[promisify.custom] = patchedCustom
    state = { count: 0, execFileImpl, originalCustom, patchedCustom }
    installStates.set(execFileImpl, state)
  }
  state.count += 1

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    state.count = Math.max(0, state.count - 1)
    if (state.count !== 0) return

    try { state.patchedCustom.deactivate?.() } catch { /* best effort */ }
    if (state.execFileImpl[promisify.custom] === state.patchedCustom) {
      if (state.originalCustom === undefined) delete state.execFileImpl[promisify.custom]
      else state.execFileImpl[promisify.custom] = state.originalCustom
    }
    installStates.delete(state.execFileImpl)
  }

  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, 'vision-router: tesseract promisify input compatibility')
  }
  return dispose
}

// Lazy CommonJS acquisition avoids touching the process-level API during module
// evaluation and keeps tests able to inject a fake child_process module.
function awaitableChildProcess() {
  // createRequire is avoided deliberately: importing the builtin here is safe
  // and the function runs only when install() actually needs the default.
  // eslint/oxlint environments used by the project allow require through the
  // global process main module only inconsistently, so keep this tiny dynamic
  // bridge in one place.
  return globalThis.process?.getBuiltinModule?.('child_process')
}
