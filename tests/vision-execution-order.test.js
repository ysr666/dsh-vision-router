import assert from 'node:assert/strict'
import test from 'node:test'
import {
  currentVisionExecutionOrder,
  withVisionExecutionOrder,
} from '../lib/vision-execution-order.js'

const pair = (provider, model, extra = {}) => ({ provider, model, ...extra })

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('vision execution order exists only inside its async scope and carries only provider/model', async () => {
  assert.equal(currentVisionExecutionOrder(), undefined)
  const input = [pair('a', 'm1', { credential: 'must-not-leak' }), pair('b', 'm2', { score: 99 })]
  const result = await withVisionExecutionOrder(input, async () => {
    const current = currentVisionExecutionOrder()
    assert.deepEqual(current, [pair('a', 'm1'), pair('b', 'm2')])
    assert.equal(Object.isFrozen(current), true)
    assert.equal(Object.isFrozen(current[0]), true)
    await Promise.resolve()
    assert.deepEqual(currentVisionExecutionOrder(), [pair('a', 'm1'), pair('b', 'm2')])
    return 'ok'
  })
  assert.equal(result, 'ok')
  assert.equal(currentVisionExecutionOrder(), undefined)
})

test('nested execution order restores the parent scope after the child completes', async () => {
  await withVisionExecutionOrder([pair('outer', 'm')], async () => {
    assert.equal(currentVisionExecutionOrder()[0].provider, 'outer')
    await withVisionExecutionOrder([pair('inner', 'm')], async () => {
      assert.equal(currentVisionExecutionOrder()[0].provider, 'inner')
    })
    assert.equal(currentVisionExecutionOrder()[0].provider, 'outer')
  })
  assert.equal(currentVisionExecutionOrder(), undefined)
})

test('parallel visual calls do not leak execution order across AsyncLocalStorage scopes', async () => {
  const gateA = deferred()
  const gateB = deferred()
  const readyA = deferred()
  const readyB = deferred()

  const a = withVisionExecutionOrder([pair('provider-a', 'model-a')], async () => {
    readyA.resolve()
    await gateA.promise
    return currentVisionExecutionOrder()[0]
  })
  const b = withVisionExecutionOrder([pair('provider-b', 'model-b')], async () => {
    readyB.resolve()
    await gateB.promise
    return currentVisionExecutionOrder()[0]
  })

  await Promise.all([readyA.promise, readyB.promise])
  gateB.resolve()
  const bResult = await b
  assert.deepEqual(bResult, pair('provider-b', 'model-b'))
  assert.equal(currentVisionExecutionOrder(), undefined)
  gateA.resolve()
  const aResult = await a
  assert.deepEqual(aResult, pair('provider-a', 'model-a'))
  assert.equal(currentVisionExecutionOrder(), undefined)
})

test('two sessions can execute different Auto orders concurrently without cross-leak', async () => {
  const sessionA = { id: 'session-a' }
  const sessionB = { id: 'session-b' }
  const gateA = deferred()
  const gateB = deferred()
  const ready = [deferred(), deferred()]

  const run = (session, order, gate, entered) => withVisionExecutionOrder(order, async () => {
    entered.resolve()
    await gate.promise
    return { session, order: currentVisionExecutionOrder() }
  })

  const a = run(sessionA, [pair('a', '1'), pair('b', '2')], gateA, ready[0])
  const b = run(sessionB, [pair('b', '2'), pair('a', '1')], gateB, ready[1])
  await Promise.all(ready.map((item) => item.promise))

  gateA.resolve()
  assert.deepEqual(await a, { session: sessionA, order: [pair('a', '1'), pair('b', '2')] })
  assert.equal(currentVisionExecutionOrder(), undefined)
  gateB.resolve()
  assert.deepEqual(await b, { session: sessionB, order: [pair('b', '2'), pair('a', '1')] })
  assert.equal(currentVisionExecutionOrder(), undefined)
})

test('parallel tool calls in the same session keep independent execution orders', async () => {
  const sameSession = { id: 'same-session' }
  const firstGate = deferred()
  const secondGate = deferred()
  const firstReady = deferred()
  const secondReady = deferred()

  const first = withVisionExecutionOrder([pair('quality', 'm')], async () => {
    void sameSession
    firstReady.resolve()
    await firstGate.promise
    return currentVisionExecutionOrder()[0]
  })
  const second = withVisionExecutionOrder([pair('speed', 'm')], async () => {
    void sameSession
    secondReady.resolve()
    await secondGate.promise
    return currentVisionExecutionOrder()[0]
  })

  await Promise.all([firstReady.promise, secondReady.promise])
  secondGate.resolve()
  assert.deepEqual(await second, pair('speed', 'm'))
  firstGate.resolve()
  assert.deepEqual(await first, pair('quality', 'm'))
  assert.equal(currentVisionExecutionOrder(), undefined)
})

test('cancellation unwinds the execution-order scope with no ALS residue', async () => {
  const controller = new AbortController()
  const entered = deferred()
  const running = withVisionExecutionOrder([pair('cancelled', 'm')], async () => {
    entered.resolve()
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        const error = new Error('cancelled')
        error.name = 'AbortError'
        reject(error)
      }
      if (controller.signal.aborted) return onAbort()
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
  })
  await entered.promise
  controller.abort()
  await assert.rejects(running, { name: 'AbortError' })
  assert.equal(currentVisionExecutionOrder(), undefined)
})

test('execution order rejects malformed pairs before entering a scope', () => {
  assert.throws(() => withVisionExecutionOrder({}, () => {}), /must be an array/)
  assert.throws(() => withVisionExecutionOrder([pair('', 'model')], () => {}), /non-empty provider and model/)
  assert.throws(() => withVisionExecutionOrder([pair('provider', '')], () => {}), /non-empty provider and model/)
  assert.throws(() => withVisionExecutionOrder([], undefined), /requires a function/)
  assert.equal(currentVisionExecutionOrder(), undefined)
})
