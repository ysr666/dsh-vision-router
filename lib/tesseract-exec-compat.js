import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')

// Install state is keyed by every concrete execFile function exposed while our
// shim is active. Modern Node marks execFile[promisify.custom] as read-only and
// non-configurable, so the installer sometimes has to publish a callback-safe
// wrapper through child_process.execFile and synchronize the builtin ESM live
// binding. Multiple Vision Router contexts still share one shim/refcount.
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
 * stdin until timeout. The compatibility layer materializes the one OCR input
 * with fs/promises, delegates to the native promisified implementation, then
 * removes the temporary directory asynchronously.
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

function canReplaceCustomPromisify(execFileImpl) {
  const descriptor = Object.getOwnPropertyDescriptor(execFileImpl, promisify.custom)
  if (descriptor === undefined) return Object.isExtensible(execFileImpl)
  if ('writable' in descriptor) return descriptor.writable === true
  return typeof descriptor.set === 'function'
}

function setCustomPromisify(execFileImpl, custom) {
  const descriptor = Object.getOwnPropertyDescriptor(execFileImpl, promisify.custom)
  if (descriptor === undefined) {
    Object.defineProperty(execFileImpl, promisify.custom, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: custom,
    })
    return
  }
  execFileImpl[promisify.custom] = custom
}

function restoreCustomPromisify(execFileImpl, originalCustom) {
  if (originalCustom === undefined) delete execFileImpl[promisify.custom]
  else execFileImpl[promisify.custom] = originalCustom
}

function callbackForwarder(execFileImpl, patchedCustom) {
  const wrapped = function execFile(...args) {
    return Reflect.apply(execFileImpl, this, args)
  }
  Object.defineProperty(wrapped, promisify.custom, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: patchedCustom,
  })
  return wrapped
}

function syncIfBuiltin(moduleObject) {
  if (moduleObject === childProcess) syncBuiltinESMExports()
}

function warnInstallDegraded(ctx, reason) {
  try {
    ctx?.logger?.warn?.(
      'vision-router: tesseract execFile compatibility could not be installed (%s); continuing without the local stdin shim',
      reason,
    )
  } catch {
    /* boot must never fail for optional local OCR compatibility */
  }
}

/**
 * Install the narrow promisify compatibility for the Vision Router context.
 *
 * Node 22/24 expose execFile[promisify.custom] as a non-writable,
 * non-configurable property. Direct assignment therefore throws during plugin
 * boot. When that native descriptor is locked, publish a callback-equivalent
 * execFile wrapper on the builtin module, give only the wrapper our custom
 * promisify hook, and call syncBuiltinESMExports() so existing ESM named-import
 * live bindings (including index.js) see the wrapper. Callback semantics stay
 * native; only promisified Tesseract stdin calls are specialized.
 *
 * Cleanup is chain-safe: if another plugin replaces either the module export or
 * the wrapper's custom promisify later, that newer value remains authoritative.
 */
export function installTesseractExecFileCompat(ctx, options = {}) {
  const moduleObject = options.childProcessModule ?? childProcess
  if (!moduleObject || typeof moduleObject !== 'object' || typeof moduleObject.execFile !== 'function') {
    throw new TypeError('installTesseractExecFileCompat: childProcessModule.execFile must be a function')
  }

  const execFileImpl = moduleObject.execFile
  let state = installStates.get(execFileImpl)
  if (state === undefined) {
    const originalCustom = execFileImpl[promisify.custom]
    const patchedCustom = createTesseractPromisifyCompat(execFileImpl, originalCustom, options)

    if (canReplaceCustomPromisify(execFileImpl)) {
      try {
        setCustomPromisify(execFileImpl, patchedCustom)
      } catch (error) {
        patchedCustom.deactivate?.()
        warnInstallDegraded(ctx, error && error.message ? error.message : String(error))
        return () => {}
      }
      state = {
        count: 0,
        mode: 'custom-property',
        moduleObject,
        execFileImpl,
        exposedExecFile: execFileImpl,
        originalCustom,
        patchedCustom,
      }
      installStates.set(execFileImpl, state)
    } else {
      const exposedExecFile = callbackForwarder(execFileImpl, patchedCustom)
      try {
        moduleObject.execFile = exposedExecFile
        if (moduleObject.execFile !== exposedExecFile) throw new Error('child_process.execFile export is not writable')
        syncIfBuiltin(moduleObject)
      } catch (error) {
        try {
          if (moduleObject.execFile === exposedExecFile) {
            moduleObject.execFile = execFileImpl
            syncIfBuiltin(moduleObject)
          }
        } catch {
          /* best effort rollback */
        }
        patchedCustom.deactivate?.()
        warnInstallDegraded(ctx, error && error.message ? error.message : String(error))
        return () => {}
      }
      state = {
        count: 0,
        mode: 'module-wrapper',
        moduleObject,
        execFileImpl,
        exposedExecFile,
        originalCustom,
        patchedCustom,
      }
      installStates.set(execFileImpl, state)
      installStates.set(exposedExecFile, state)
    }
  }
  state.count += 1

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    state.count = Math.max(0, state.count - 1)
    if (state.count !== 0) return

    try { state.patchedCustom.deactivate?.() } catch { /* best effort */ }
    const stillOwnsCustom = state.exposedExecFile[promisify.custom] === state.patchedCustom

    if (state.mode === 'custom-property') {
      if (stillOwnsCustom) {
        try { restoreCustomPromisify(state.execFileImpl, state.originalCustom) } catch { /* best effort */ }
      }
    } else if (
      state.mode === 'module-wrapper' &&
      state.moduleObject.execFile === state.exposedExecFile &&
      stillOwnsCustom
    ) {
      try {
        state.moduleObject.execFile = state.execFileImpl
        syncIfBuiltin(state.moduleObject)
      } catch {
        /* a later host/plugin mutation stays authoritative */
      }
    }

    installStates.delete(state.execFileImpl)
    installStates.delete(state.exposedExecFile)
  }

  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, 'vision-router: tesseract promisify input compatibility')
  }
  return dispose
}
