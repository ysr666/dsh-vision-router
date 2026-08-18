import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'

import { createCoalescingRunner } from '../lib/adapter-update-coalescer.js'
import {
  createTesseractExecFileCompat,
  installTesseractExecFileCompat,
} from '../lib/tesseract-exec-compat.js'

test('coalescing runner reaches a fixed point across synchronous re-entry and mid-pass topology changes', () => {
  const providers = new Set(['alpha'])
  const twins = new Set()
  const registrations = new Map()
  let reconcile
  let depth = 0
  let maxDepth = 0
  let injectedSecondProvider = false

  reconcile = createCoalescingRunner(() => {
    depth += 1
    maxDepth = Math.max(maxDepth, depth)
    try {
      for (const provider of [...providers]) {
        if (twins.has(provider)) continue
        twins.add(provider)
        registrations.set(provider, (registrations.get(provider) ?? 0) + 1)

        // Mirrors registerAdapter() synchronously emitting adapters-updated.
        reconcile()

        // Mirrors another listener adding a real provider during the same
        // synchronous event. A simple "already syncing -> return" guard loses
        // this update if no later event arrives.
        if (provider === 'alpha' && !injectedSecondProvider) {
          injectedSecondProvider = true
          providers.add('beta')
          reconcile()
        }
      }
    } finally {
      depth -= 1
    }
  })

  reconcile()

  assert.deepEqual([...twins].sort(), ['alpha', 'beta'])
  assert.equal(registrations.get('alpha'), 1)
  assert.equal(registrations.get('beta'), 1)
  assert.equal(maxDepth, 1, 'nested notifications must be coalesced, never recursively executed')
})

test('coalescing runner stops a permanently dirty synchronous event cycle', () => {
  let passes = 0
  let reported
  let reconcile
  reconcile = createCoalescingRunner(
    () => {
      passes += 1
      // Pathological host/plugin semantics: every reconciliation publishes the
      // same event again even though no stable fixed point is reachable.
      reconcile()
    },
    {
      maxPasses: 5,
      onNonConverging(info) { reported = info },
    },
  )

  reconcile()

  assert.equal(passes, 5)
  assert.equal(reported.passes, 5)
  // A later real event gets a fresh bounded attempt instead of leaving the
  // runner permanently wedged in a `running` state.
  reconcile()
  assert.equal(passes, 10)
})

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
])

test('tesseract execFile compatibility materializes input bytes and preserves promisify shape', async () => {
  let materializedPath
  let delegatedOptions

  const fakeExecFile = (_file, args, options, callback) => {
    materializedPath = args[0]
    delegatedOptions = options
    assert.notEqual(materializedPath, 'stdin')
    assert.match(materializedPath, /input\.png$/)
    assert.equal(existsSync(materializedPath), true)
    assert.deepEqual(readFileSync(materializedPath), pngBytes)
    callback(null, 'OCR_OK', '')
    return { pid: 1 }
  }

  const wrapped = createTesseractExecFileCompat(fakeExecFile)
  const result = await promisify(wrapped)(
    'tesseract',
    ['stdin', 'stdout', '-l', 'chi_sim+eng', '--psm', '6'],
    { timeout: 1500, maxBuffer: 1024, input: pngBytes },
  )

  assert.deepEqual(result, { stdout: 'OCR_OK', stderr: '' })
  assert.equal(Object.prototype.hasOwnProperty.call(delegatedOptions, 'input'), false)
  assert.equal(delegatedOptions.timeout, 1500)
  assert.equal(delegatedOptions.windowsHide, true)
  assert.equal(existsSync(materializedPath), false, 'temporary OCR input must be removed after success')
})

test('tesseract execFile compatibility removes materialized input after failure', async () => {
  let materializedPath

  const fakeExecFile = (_file, args, _options, callback) => {
    materializedPath = args[0]
    assert.equal(existsSync(materializedPath), true)
    assert.deepEqual(readFileSync(materializedPath), pngBytes)
    callback(new Error('fake tesseract failure'), '', 'boom')
    return { pid: 2 }
  }

  const wrapped = createTesseractExecFileCompat(fakeExecFile)
  await assert.rejects(
    promisify(wrapped)(
      'tesseract',
      ['stdin', 'stdout', '-l', 'chi_sim+eng', '--psm', '6'],
      { timeout: 1500, maxBuffer: 1024, input: pngBytes },
    ),
    /fake tesseract failure/,
  )

  assert.equal(existsSync(materializedPath), false, 'temporary OCR input must be removed after failure')
})

test('non-tesseract execFile calls are delegated unchanged', () => {
  const calls = []
  const fakeExecFile = function (...args) {
    calls.push(args)
    return { pid: 3 }
  }
  const wrapped = createTesseractExecFileCompat(fakeExecFile)
  const callback = () => {}
  const options = { timeout: 99, input: Buffer.from('not for us') }

  const child = wrapped('powershell.exe', ['-NoProfile'], options, callback)

  assert.deepEqual(child, { pid: 3 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'powershell.exe')
  assert.deepEqual(calls[0][1], ['-NoProfile'])
  assert.equal(calls[0][2], options)
  assert.equal(calls[0][3], callback)
})

test('tesseract installer unload does not clobber a later process-level execFile patch', () => {
  const hostCalls = []
  const hostExecFile = function (...args) {
    hostCalls.push(args)
    return { pid: 4 }
  }
  const fakeChildProcess = { execFile: hostExecFile }
  let syncCalls = 0
  const dispose = installTesseractExecFileCompat(undefined, {
    childProcessModule: fakeChildProcess,
    syncBuiltinESMExports() { syncCalls += 1 },
  })
  const visionPatch = fakeChildProcess.execFile
  assert.notEqual(visionPatch, hostExecFile)
  assert.equal(visionPatch.active, true)

  // A later plugin captures Vision Router then becomes the top-level patch.
  const laterPatch = function (...args) {
    return visionPatch.apply(this, args)
  }
  fakeChildProcess.execFile = laterPatch

  dispose()

  assert.equal(fakeChildProcess.execFile, laterPatch, 'later patch must remain authoritative')
  assert.equal(visionPatch.active, false, 'captured Vision Router wrapper becomes inert')
  assert.ok(syncCalls >= 2, 'ESM binding is resynced to the current authoritative patch')

  // If the later plugin eventually restores what it captured, the old Vision
  // Router layer must delegate directly instead of re-enabling OCR materialize.
  let seenArgs
  const callback = () => {}
  hostCalls.length = 0
  visionPatch('tesseract', ['stdin', 'stdout'], { input: pngBytes }, callback)
  seenArgs = hostCalls[0]
  assert.equal(seenArgs[1][0], 'stdin')
  assert.equal(seenArgs[2].input, pngBytes)
})
