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
