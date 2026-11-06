import test from 'node:test'
import assert from 'node:assert/strict'
import { installVisionToolRuntimeBoundary } from '../lib/vision-tool-runtime-boundary.js'

const CANCEL_PROBE_MS = 2500

function registeredVisionChain(iteratorFactory) {
  let registered
  const context = installVisionToolRuntimeBoundary({
    llm: {
      registerAdapter(_routes, adapter) {
        registered = adapter
        return () => {}
      },
    },
  })
  context.llm.registerAdapter(['vision-chain'], {
    providerInfo: () => ({ name: 'Vision Chain' }),
    stream: () => ({
      [Symbol.asyncIterator]: iteratorFactory,
    }),
  })
  return registered
}

async function settlesWithin(promise, maxMs = CANCEL_PROBE_MS) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('wrapped stream did not settle under bounded cancellation')), maxMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

test('delegated vision stream abort interrupts a noncooperative pending iterator.next', async () => {
  const controller = new AbortController()
  let nextCalls = 0
  let returnCalls = 0
  const adapter = registeredVisionChain(() => ({
    next() {
      nextCalls += 1
      return nextCalls === 1
        ? Promise.resolve({ done: false, value: { type: 'text', text: 'first' } })
        : new Promise(() => {})
    },
    return() {
      returnCalls += 1
      return Promise.resolve({ done: true })
    },
  }))

  const iterator = adapter.stream({ signal: controller.signal })[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.text, 'first')
  const pending = iterator.next()
  controller.abort()
  await assert.rejects(settlesWithin(pending), { name: 'AbortError' })
  assert.equal(nextCalls, 2)
  assert.equal(returnCalls, 1, 'abort still attempts owned iterator cleanup')
})

test('delegated vision stream cannot wait forever for a noncooperative iterator.return', async () => {
  let cleanupCalls = 0
  const adapter = registeredVisionChain(() => ({
    next: () => Promise.resolve({ done: false, value: 'first' }),
    return() {
      cleanupCalls += 1
      return new Promise(() => {})
    },
  }))
  const iterator = adapter.stream({})[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value, 'first')
  const result = await settlesWithin(iterator.return('stop'))
  assert.equal(result.done, true)
  assert.equal(cleanupCalls, 1)
})

test('delegated vision stream still awaits healthy iterator cleanup and propagates actual cleanup errors', async () => {
  let finished = false
  const good = registeredVisionChain(() => ({
    next: async () => ({ done: false, value: 1 }),
    return: async () => {
      await new Promise(resolve => setTimeout(resolve, 15))
      finished = true
      return { done: true }
    },
  }))
  const first = good.stream({})[Symbol.asyncIterator]()
  await first.next()
  assert.equal((await first.return()).done, true)
  assert.equal(finished, true)

  const bad = registeredVisionChain(() => ({
    next: async () => ({ done: false, value: 1 }),
    return: async () => { throw new Error('actual cleanup failure') },
  }))
  const second = bad.stream({})[Symbol.asyncIterator]()
  await second.next()
  await assert.rejects(second.return(), /actual cleanup failure/)
})

test('Vision Router-owned transparent adapter also honors caller abort during stalled next', async () => {
  const controller = new AbortController()
  let registered
  let closed = 0
  const view = installVisionToolRuntimeBoundary({
    llm: {
      registerAdapter(_routes, adapter) {
        registered = adapter
        return () => {}
      },
    },
  })
  view.llm.registerAdapter('owned-vision-route', {
    [Symbol.for('dsh-vision-router.adapter-owner')]: Object.freeze({}),
    stream: () => ({
      [Symbol.asyncIterator]: () => {
        let count = 0
        return {
          next() {
            count += 1
            return count === 1
              ? Promise.resolve({ done: false, value: { type: 'text', text: 'first' } })
              : new Promise(() => {})
          },
          return() {
            closed += 1
            return Promise.resolve({ done: true })
          },
        }
      },
    }),
  })
  const iter = registered.stream({ signal: controller.signal })[Symbol.asyncIterator]()
  await iter.next()
  const pending = iter.next()
  controller.abort()
  await assert.rejects(settlesWithin(pending), { name: 'AbortError' })
  assert.equal(closed, 1)
})

test('abort with both stalled next and stalled cleanup finishes with a bounded AbortError', async () => {
  const controller = new AbortController()
  let nextCount = 0
  let closeCount = 0
  const adapter = registeredVisionChain(() => ({
    next() {
      nextCount += 1
      return nextCount === 1
        ? Promise.resolve({ done: false, value: 'first' })
        : new Promise(() => {})
    },
    return() {
      closeCount += 1
      return new Promise(() => {})
    },
  }))
  const iter = adapter.stream({ signal: controller.signal })[Symbol.asyncIterator]()
  await iter.next()
  const pending = iter.next()
  controller.abort()
  await assert.rejects(settlesWithin(pending), { name: 'AbortError' })
  assert.equal(closeCount, 1)
})

test('direct vision-http adapter abort also interrupts an unresponsive stream next', async () => {
  const controller = new AbortController()
  let registered
  let cleanupCalls = 0
  let calls = 0
  const view = installVisionToolRuntimeBoundary({
    llm: { registerAdapter(_routes, adapter) { registered = adapter; return () => {} } },
  })
  view.llm.registerAdapter('vision-http', {
    stream() {
      return {
        [Symbol.asyncIterator]: () => ({
          next() {
            calls += 1
            return calls === 1
              ? Promise.resolve({ done: false, value: { type: 'text', text: 'first' } })
              : new Promise(() => {})
          },
          return() { cleanupCalls += 1; return Promise.resolve({ done: true }) },
        }),
      }
    },
  })
  const iter = registered.stream({ model: 'vision-http/local/image', signal: controller.signal })[Symbol.asyncIterator]()
  assert.equal((await iter.next()).value.text, 'first')
  const pending = iter.next()
  controller.abort()
  await assert.rejects(settlesWithin(pending), { name: 'AbortError' })
  assert.equal(cleanupCalls, 1)
})

test('cancellation keeps AbortError when an adapter throws during cleanup', async () => {
  const controller = new AbortController()
  let count = 0
  const adapter = registeredVisionChain(() => ({
    next() {
      count += 1
      return count === 1
        ? Promise.resolve({ done: false, value: 'first' })
        : new Promise(() => {})
    },
    return: async () => {
      throw new Error('adapter cleanup closed after abort')
    },
  }))
  const iter = adapter.stream({ signal: controller.signal })[Symbol.asyncIterator]()
  await iter.next()
  const pending = iter.next()
  controller.abort()
  await assert.rejects(settlesWithin(pending), { name: 'AbortError' })
})
