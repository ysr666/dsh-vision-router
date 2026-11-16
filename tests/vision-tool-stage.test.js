import assert from 'node:assert/strict'
import test from 'node:test'
import { createVisionToolStageTrace } from '../lib/vision-tool-stage.js'

test('stage tracing reports privacy-safe progress and successful completion', async () => {
  const entries = []
  const logger = {
    info(...args) { entries.push(['info', ...args]) },
    warn(...args) { entries.push(['warn', ...args]) },
  }
  const trace = createVisionToolStageTrace(logger, 'vision_describe')
  assert.equal(await trace('read-image-0', async () => 'pixels'), 'pixels')
  assert.deepEqual(entries.map((entry) => entry[5]), ['begin', 'ok'])
  assert.ok(entries.every((entry) => !JSON.stringify(entry).includes('sha256:')))
})

test('stage tracing logs the unresolved Host stage at cancellation without late success', async () => {
  const entries = []
  const logger = {
    info(...args) { entries.push(args) },
    warn(...args) { entries.push(args) },
  }
  const controller = new AbortController()
  const trace = createVisionToolStageTrace(logger, 'vision_describe', controller.signal)
  let finish
  const pending = trace('read-image-0', () => new Promise((resolve) => { finish = resolve }))
  controller.abort(new Error('stop'))
  assert.ok(entries.some((entry) => entry[3] === 'read-image-0' && entry[4] === 'aborted'))
  finish('late')
  await assert.rejects(pending, /stop/)
  assert.equal(entries.filter((entry) => entry[4] === 'ok').length, 0)
  assert.equal(entries.filter((entry) => entry[4] === 'aborted').length, 1)
})

test('a never-settling Host image stage is abandoned promptly on abort', async () => {
  const entries = []
  const trace = createVisionToolStageTrace({
    info(...args) { entries.push(args) },
    warn(...args) { entries.push(args) },
  }, 'vision_describe', AbortSignal.timeout(80))
  let finishLate
  const started = Date.now()
  const pending = trace('resolve-upload-refs', () => new Promise((resolve) => {
    finishLate = resolve
  }))
  await assert.rejects(pending, /aborted|timeout|operation timed out/i)
  assert.ok(Date.now() - started < 800, 'a pending Host Promise must not hold the caller')
  finishLate?.('ref-from-canceled-session')
  await Promise.resolve()
  assert.ok(entries.some((entry) => entry[3] === 'resolve-upload-refs' && entry[4] === 'aborted'))
  assert.equal(entries.filter((entry) => entry[4] === 'ok').length, 0)
})
