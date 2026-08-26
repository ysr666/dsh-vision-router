import assert from 'node:assert/strict'
import test from 'node:test'
import {
  currentVisionExecutionOrder,
  withVisionExecutionOrder,
} from '../lib/vision-execution-order.js'

const pair = (provider, model, extra = {}) => ({ provider, model, ...extra })

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
  let releaseA
  let releaseB
  const gateA = new Promise((resolve) => { releaseA = resolve })
  const gateB = new Promise((resolve) => { releaseB = resolve })
  let enteredA
  let enteredB
  const readyA = new Promise((resolve) => { enteredA = resolve })
  const readyB = new Promise((resolve) => { enteredB = resolve })

  const a = withVisionExecutionOrder([pair('provider-a', 'model-a')], async () => {
    enteredA()
    await gateA
    return currentVisionExecutionOrder()[0]
  })
  const b = withVisionExecutionOrder([pair('provider-b', 'model-b')], async () => {
    enteredB()
    await gateB
    return currentVisionExecutionOrder()[0]
  })

  await Promise.all([readyA, readyB])
  releaseB()
  const bResult = await b
  assert.deepEqual(bResult, pair('provider-b', 'model-b'))
  assert.equal(currentVisionExecutionOrder(), undefined)
  releaseA()
  const aResult = await a
  assert.deepEqual(aResult, pair('provider-a', 'model-a'))
  assert.equal(currentVisionExecutionOrder(), undefined)
})

test('execution order rejects malformed pairs before entering a scope', () => {
  assert.throws(() => withVisionExecutionOrder({}, () => {}), /must be an array/)
  assert.throws(() => withVisionExecutionOrder([pair('', 'model')], () => {}), /non-empty provider and model/)
  assert.throws(() => withVisionExecutionOrder([pair('provider', '')], () => {}), /non-empty provider and model/)
  assert.throws(() => withVisionExecutionOrder([], undefined), /requires a function/)
  assert.equal(currentVisionExecutionOrder(), undefined)
})
