import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { execFile as esmExecFile } from 'node:child_process'
import { promisify } from 'node:util'

import { installTesseractExecFileCompat } from '../lib/tesseract-exec-compat.js'

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')
const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
])

test('locked promisify.custom uses a callback-safe module wrapper instead of throwing at boot', async () => {
  const originalCustom = async (_file, args, options) => {
    assert.match(args[0], /ocr-locked[\\/]input\.png$/)
    assert.equal(Object.prototype.hasOwnProperty.call(options, 'input'), false)
    return { stdout: 'OCR_LOCKED_OK', stderr: '' }
  }
  const lockedExecFile = function lockedExecFile(_file, _args, _options, callback) {
    callback?.(null, 'callback-ok', '')
    return { pid: 1 }
  }
  Object.defineProperty(lockedExecFile, promisify.custom, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: originalCustom,
  })
  const fakeModule = { execFile: lockedExecFile }

  const dispose = installTesseractExecFileCompat(undefined, {
    childProcessModule: fakeModule,
    tempDir: '/virtual-tmp',
    async mkdtemp() { return '/virtual-tmp/ocr-locked' },
    async writeFile(_file, bytes) { assert.equal(bytes, pngBytes) },
    async rm() {},
  })

  const wrappedExecFile = fakeModule.execFile
  assert.notEqual(wrappedExecFile, lockedExecFile)
  assert.equal(wrappedExecFile('node', [], {}, () => {}).pid, 1, 'callback calls still delegate to native execFile')
  assert.deepEqual(
    await promisify(wrappedExecFile)('tesseract', ['stdin', 'stdout'], { input: pngBytes }),
    { stdout: 'OCR_LOCKED_OK', stderr: '' },
  )

  dispose()
  assert.equal(fakeModule.execFile, lockedExecFile)
})

test('custom-property install and restore synchronize builtin ESM exports', () => {
  const execFile = function execFile() { return { pid: 1 } }
  const fakeBuiltin = { execFile }
  const synchronizedHooks = []

  const dispose = installTesseractExecFileCompat(undefined, {
    childProcessModule: fakeBuiltin,
    builtinChildProcessModule: fakeBuiltin,
    syncBuiltinESMExports() {
      synchronizedHooks.push(execFile[promisify.custom])
    },
  })

  assert.equal(typeof execFile[promisify.custom], 'function')
  assert.equal(synchronizedHooks.length, 1)
  assert.equal(synchronizedHooks[0], execFile[promisify.custom])

  dispose()
  assert.equal(execFile[promisify.custom], undefined)
  assert.deepEqual(synchronizedHooks, [synchronizedHooks[0], undefined])
})

test('Electron-style detached ESM execFile receives the working Tesseract hook after sync', async () => {
  const originalCustom = async (_file, args, options) => {
    assert.match(args[0], /ocr-electron[\\/]input\.png$/)
    assert.equal(Object.prototype.hasOwnProperty.call(options, 'input'), false)
    return { stdout: 'ELECTRON_SYNC_OK', stderr: '' }
  }
  const cjsExecFile = function cjsExecFile() { return { pid: 1 } }
  Object.defineProperty(cjsExecFile, promisify.custom, {
    configurable: true, enumerable: false, writable: true, value: originalCustom,
  })
  const fakeBuiltin = { execFile: cjsExecFile }
  const esmNamespace = { execFile: function detachedEsmExecFile() { return { pid: 2 } } }
  let syncCount = 0

  assert.notEqual(esmNamespace.execFile, fakeBuiltin.execFile)
  const dispose = installTesseractExecFileCompat(undefined, {
    childProcessModule: fakeBuiltin,
    builtinChildProcessModule: fakeBuiltin,
    syncBuiltinESMExports() {
      syncCount += 1
      esmNamespace.execFile = fakeBuiltin.execFile
    },
    tempDir: '/virtual-tmp',
    async mkdtemp() { return '/virtual-tmp/ocr-electron' },
    async writeFile(_file, bytes) { assert.equal(bytes, pngBytes) },
    async rm() {},
  })

  assert.equal(esmNamespace.execFile, cjsExecFile)
  assert.deepEqual(
    await promisify(esmNamespace.execFile)('tesseract', ['stdin', 'stdout'], { input: pngBytes }),
    { stdout: 'ELECTRON_SYNC_OK', stderr: '' },
  )
  dispose()
  assert.equal(syncCount, 2, 'install and restore both synchronize the ESM namespace')
  assert.equal(cjsExecFile[promisify.custom], originalCustom)
})

test('custom-property sync failure rolls installation back instead of leaving a half patch', () => {
  const execFile = function execFile() { return { pid: 1 } }
  const fakeBuiltin = { execFile }
  const warnings = []

  const dispose = installTesseractExecFileCompat({
    logger: { warn(...args) { warnings.push(args) } },
  }, {
    childProcessModule: fakeBuiltin,
    builtinChildProcessModule: fakeBuiltin,
    syncBuiltinESMExports() { throw new Error('synthetic sync failure') },
  })

  assert.equal(execFile[promisify.custom], undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].join(' '), /synthetic sync failure/)
  assert.doesNotThrow(dispose)
})

test('real Node child_process locked descriptor installs without crashing and synchronizes ESM binding', async () => {
  const originalExecFile = childProcess.execFile
  const descriptor = Object.getOwnPropertyDescriptor(originalExecFile, promisify.custom)
  let dispose = () => {}

  try {
    assert.doesNotThrow(() => {
      dispose = installTesseractExecFileCompat(undefined, { childProcessModule: childProcess })
    })

    if (descriptor && descriptor.writable === false && descriptor.configurable === false) {
      assert.notEqual(childProcess.execFile, originalExecFile, 'locked native hook should use a module wrapper')
      assert.equal(esmExecFile, childProcess.execFile, 'syncBuiltinESMExports must update existing named-import binding')
    }

    const { stdout } = await promisify(esmExecFile)(process.execPath, ['--version'], { timeout: 5000 })
    assert.match(String(stdout), /^v\d+\./)
  } finally {
    dispose()
  }

  assert.equal(childProcess.execFile, originalExecFile)
  assert.equal(esmExecFile, originalExecFile)
})
