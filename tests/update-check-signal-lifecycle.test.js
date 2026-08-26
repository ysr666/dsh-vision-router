import assert from 'node:assert/strict'
import test from 'node:test'

import { checkPackageUpdate } from '../lib/update-check.js'

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function rejectWhenAborted(signal) {
  return new Promise((_resolve, reject) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      signal.removeEventListener('abort', fail)
      reject(error)
    }
    const fail = () => finish(signal.reason ?? new Error('aborted'))
    // AbortSignal.timeout() does not keep Node 22's test event loop alive by
    // itself. Keep one ordinary timer referenced so this test observes the
    // real request timeout instead of being cancelled by the test runner.
    // This is only a fail-safe guard; no wall-clock threshold is asserted.
    const guard = setTimeout(
      () => finish(new Error('test guard expired while waiting for request abort')),
      1_000,
    )
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail, { once: true })
  })
}

test('caller cancellation signal does not disable the per-request update timeout', async () => {
  const controller = new AbortController()
  const seenSignals = []
  const releaseApi = 'https://release.example.test/latest'
  const result = await checkPackageUpdate({
    currentVersion: '2.0.0',
    registry: 'https://slow-registry.example.test',
    fallbackRegistry: 'https://slow-registry.example.test',
    releaseApi,
    signal: controller.signal,
    timeoutMs: 20,
    fetchImpl: async (url, init) => {
      seenSignals.push(init.signal)
      if (url === releaseApi) return jsonResponse({ tag_name: 'v2.0.1' })
      return rejectWhenAborted(init.signal)
    },
  })

  assert.equal(controller.signal.aborted, false, 'internal timeout must not abort caller-owned authority')
  assert.equal(result.ok, true)
  assert.equal(result.latestSource, 'github-release')
  assert.equal(result.latestVersion, '2.0.1')
  assert.equal(result.registryFailures.length, 1)
  assert.equal(seenSignals.length, 2)
  assert.notEqual(seenSignals[0], controller.signal, 'network request must receive the combined timeout signal')
})

test('caller abort still preempts timeout and prevents registry/release fallbacks', async () => {
  const controller = new AbortController()
  let calls = 0
  const pending = checkPackageUpdate({
    currentVersion: '2.0.0',
    registry: 'https://slow-registry.example.test',
    fallbackRegistry: 'https://registry.npmjs.org',
    releaseApi: 'https://release.example.test/latest',
    signal: controller.signal,
    timeoutMs: 10_000,
    fetchImpl: async (_url, init) => {
      calls += 1
      return rejectWhenAborted(init.signal)
    },
  })

  controller.abort(new Error('caller cancelled update check'))
  await assert.rejects(pending, /caller cancelled update check/)
  assert.equal(calls, 1, 'external cancellation must not fall through to another network endpoint')
})
