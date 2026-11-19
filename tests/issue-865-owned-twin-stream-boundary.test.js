import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installOwnedTwinStreamBoundary } from '../lib/owned-twin-stream-boundary.js'

const take = async (stream) => {
  const result = []
  for await (const chunk of stream) result.push(chunk)
  return result
}
const streamOf = (value) => (async function* () { yield value })()

test('issue #865: only the active DVR-owned twin bypasses outer Host adapter projection', async () => {
  const listeners = []
  const registrations = new Map()
  const owner = {
    on(event, handler, options) {
      assert.equal(event, 'llm/stream')
      assert.deepEqual(options, { global: true })
      listeners.push(handler)
      return () => { listeners.splice(listeners.indexOf(handler), 1) }
    },
    llm: {
      registration(provider) {
        const adapter = registrations.get(provider)
        if (!adapter) throw new Error('not registered')
        return { adapter }
      },
    },
  }
  const seen = []
  const ownedAdapter = {
    stream(options) {
      seen.push(options)
      return streamOf('delegated')
    },
  }
  const unrelated = { stream: () => streamOf('foreign') }
  const map = new Map([['account-vision', ownedAdapter]])
  const dispose = installOwnedTwinStreamBoundary(owner, route => map.get(route))
  const invoke = (provider) => listeners[0]({ provider, model: 'm', messages: [] }, () => streamOf('next'))

  assert.deepEqual(await take(invoke('account')), ['next'], 'normal model routes remain untouched')
  assert.deepEqual(await take(invoke('someone-else-vision')), ['next'], 'similar suffix has no authority')
  assert.deepEqual(await take(invoke('account-vision')), ['next'], 'unregistered route is not intercepted')

  registrations.set('account-vision', unrelated)
  assert.deepEqual(await take(invoke('account-vision')), ['next'], 'foreign replacement is never hijacked')
  registrations.set('account-vision', ownedAdapter)
  assert.deepEqual(await take(invoke('account-vision')), ['delegated'], 'own matching adapter is intercepted')
  assert.equal(seen.length, 1)

  registrations.delete('account-vision')
  assert.deepEqual(await take(invoke('account-vision')), ['next'], 'after unregistration Host remains authority')
  dispose()
  assert.equal(listeners.length, 0)
})

test('issue #865: injected route resolver failures are inert and never block unrelated calls', async () => {
  let listener
  const ctx = {
    on(_name, fn) { listener = fn },
    llm: { registration() { throw new Error('replaced') } },
  }
  installOwnedTwinStreamBoundary(ctx, () => { throw new Error('resolver failure') })
  assert.deepEqual(await take(listener({ provider: 'a-vision' }, () => streamOf('continued'))), ['continued'])
  assert.throws(() => installOwnedTwinStreamBoundary(undefined, () => undefined), TypeError)
})
