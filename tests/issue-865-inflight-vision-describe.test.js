import assert from 'node:assert/strict'
import test from 'node:test'
import { createVisionDescribeSingleFlight } from '../lib/vision-describe-singleflight.js'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
test('#865 simultaneous same-Session/same-signal/same-content requests call provider only once', async () => {
  const run = createVisionDescribeSingleFlight()
  const session = {}
  const signal = new AbortController().signal
  const gate = deferred()
  let calls = 0
  const task = () => { calls++; return gate.promise }
  const a = run(session, signal, 'hash-for-authorized-local-image', task)
  const b = run(session, signal, 'hash-for-authorized-local-image', task)
  assert.equal(a, b)
  await Promise.resolve()
  assert.equal(calls, 1)
  gate.resolve('evidence')
  assert.deepEqual(await Promise.all([a,b]), ['evidence','evidence'])
  await Promise.resolve()
  assert.equal(await run(session, signal, 'hash-for-authorized-local-image', () => {
    calls++; return 'fresh'
  }), 'fresh')
  assert.equal(calls, 2, 'in-flight result is not an unbounded hidden cache')
})
test('#865 Session and cancellation domains never coalesce', async () => {
  const run = createVisionDescribeSingleFlight()
  const sessionA = {}, sessionB = {}
  const s1 = new AbortController().signal, s2 = new AbortController().signal
  const gate = deferred()
  let calls = 0
  const factory = () => { calls++; return gate.promise }
  const a = run(sessionA, s1, 'k', factory)
  const b = run(sessionB, s1, 'k', factory)
  const c = run(sessionA, s2, 'k', factory)
  const d = run(sessionA, s1, 'distinct-key', factory)
  await Promise.resolve()
  assert.equal(calls, 4)
  gate.resolve('done')
  assert.deepEqual(await Promise.all([a,b,c,d]), ['done','done','done','done'])
})
test('#865 unknown authorization, missing signal and cancelled signal never share', async () => {
  const run = createVisionDescribeSingleFlight()
  const session = {}, signal = new AbortController().signal
  let calls = 0
  const factory = () => ++calls
  await Promise.all([
    run(session, signal, undefined, factory),
    run(session, undefined, 'hash', factory),
    run(undefined, signal, 'hash', factory),
  ])
  assert.equal(calls, 3)
  const controller = new AbortController()
  controller.abort()
  await Promise.all([
    run(session, controller.signal, 'hash', factory),
    run(session, controller.signal, 'hash', factory),
  ])
  assert.equal(calls, 5, 'cancelled execution stays independent and Host abort gate still applies')
})
test('#865 failed producer is never replayed as a permanent cached result', async () => {
  const run = createVisionDescribeSingleFlight()
  const session = {}, signal = new AbortController().signal
  const gate = deferred()
  let calls = 0
  const failing = () => { calls++; return gate.promise }
  const a = run(session, signal, 'k', failing)
  const b = run(session, signal, 'k', failing)
  await Promise.resolve()
  gate.reject(new Error('backend unavailable'))
  const results = await Promise.allSettled([a,b])
  assert.equal(calls,1)
  assert.deepEqual(results.map(x=>x.status),['rejected','rejected'])
  await Promise.resolve()
  assert.equal(await run(session, signal, 'k', () => ++calls),2)
})
