import assert from 'node:assert/strict'
import test from 'node:test'

import { installAbortSignalCompat } from '../lib/abort-signal-compat.js'
import {
  currentVisionTurnBudget,
  currentVisionTurnBudgetSignal,
  runWithVisionTurnBudget,
} from '../lib/turn-budget-context.js'

test('nested structured deadlines preserve outer cancellation and the earliest deadline', async () => {
  const agent = new AbortController()
  const structured = new AbortController()
  const parentDeadline = Date.now() + 10_000

  await runWithVisionTurnBudget({ deadlineAt: parentDeadline, signal: agent.signal }, async () => {
    await runWithVisionTurnBudget({ deadlineAt: parentDeadline + 50_000, signal: structured.signal }, async () => {
      const budget = currentVisionTurnBudget()
      const combined = currentVisionTurnBudgetSignal()
      assert.equal(budget.deadlineAt, parentDeadline, 'inner budget may not extend an earlier parent deadline')
      assert.ok(combined)
      assert.equal(combined.aborted, false)
      agent.abort()
      await Promise.resolve()
      assert.equal(combined.aborted, true, 'inner structured budget must not hide user cancellation')
      assert.equal(structured.signal.aborted, false, 'child deadline itself should remain independent')
    })
  })
})

class LegacyAbortSignal extends EventTarget {
  constructor() {
    super()
    this.aborted = false
    this.reason = undefined
  }
}

class LegacyAbortController {
  constructor() {
    this.signal = new LegacyAbortSignal()
  }

  abort(reason) {
    if (this.signal.aborted) return
    this.signal.aborted = true
    this.signal.reason = reason
    this.signal.dispatchEvent(new Event('abort'))
  }
}

test('public abort compatibility restores any and timeout in a legacy Host realm', async () => {
  const root = {
    AbortSignal: LegacyAbortSignal,
    AbortController: LegacyAbortController,
    DOMException,
    setTimeout,
  }

  const installed = installAbortSignalCompat(root)
  assert.deepEqual(installed, { any: true, timeout: true })
  assert.equal(typeof root.AbortSignal.any, 'function')
  assert.equal(typeof root.AbortSignal.timeout, 'function')

  const first = new root.AbortController()
  const second = new root.AbortController()
  const combined = root.AbortSignal.any([first.signal, second.signal])
  const reason = new Error('second cancelled')
  second.abort(reason)
  assert.equal(combined.aborted, true)
  assert.equal(combined.reason, reason, 'the combined signal must preserve the winning abort reason')

  const already = new root.AbortController()
  const alreadyReason = new Error('already cancelled')
  already.abort(alreadyReason)
  const immediate = root.AbortSignal.any([already.signal, first.signal])
  assert.equal(immediate.aborted, true)
  assert.equal(immediate.reason, alreadyReason)

  assert.throws(() => root.AbortSignal.any(), TypeError)
  assert.throws(() => root.AbortSignal.any([{}]), TypeError)
  assert.throws(() => root.AbortSignal.timeout('5'), TypeError)
  assert.throws(() => root.AbortSignal.timeout(1.5), RangeError)
  assert.throws(() => root.AbortSignal.timeout(0x1_0000_0000), RangeError)

  const timed = root.AbortSignal.timeout(5)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('legacy timeout shim did not abort')), 100)
    timed.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
  assert.equal(timed.aborted, true)
  assert.equal(timed.reason?.name, 'TimeoutError')
})

test('AbortSignal.any compatibility removes prior listeners if later registration fails', () => {
  class CountingSignal extends LegacyAbortSignal {
    constructor(failOnAdd = false) {
      super()
      this.failOnAdd = failOnAdd
      this.abortListeners = 0
    }

    addEventListener(type, listener, options) {
      if (this.failOnAdd) throw new Error('listener registration rejected')
      if (type === 'abort') this.abortListeners += 1
      return super.addEventListener(type, listener, options)
    }

    removeEventListener(type, listener, options) {
      if (type === 'abort' && this.abortListeners > 0) this.abortListeners -= 1
      return super.removeEventListener(type, listener, options)
    }
  }

  const first = new CountingSignal()
  const broken = new CountingSignal(true)
  assert.throws(
    () => LegacyAbortSignal.any([first, broken]),
    /listener registration rejected/,
  )
  assert.equal(first.abortListeners, 0, 'failed composition must not leak a listener onto earlier signals')
})

test('abort compatibility never replaces native static helpers', () => {
  class NativeSignal {}
  class NativeController {}
  const nativeAny = () => 'native-any'
  const nativeTimeout = () => 'native-timeout'
  NativeSignal.any = nativeAny
  NativeSignal.timeout = nativeTimeout

  const installed = installAbortSignalCompat({ AbortSignal: NativeSignal, AbortController: NativeController })
  assert.deepEqual(installed, { any: true, timeout: true })
  assert.equal(NativeSignal.any, nativeAny)
  assert.equal(NativeSignal.timeout, nativeTimeout)
})
