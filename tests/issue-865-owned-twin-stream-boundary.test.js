import { test } from 'node:test'
import assert from 'node:assert/strict'
import { identifyOwnedTwinStream, installOwnedTwinStreamBoundary, restoreOwnedTwinStreamInput } from '../lib/owned-twin-stream-boundary.js'
import { contextWithTwinImageCapabilityFallback } from '../lib/twin-image-capability-fallback.js'

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
      seen.push(restoreOwnedTwinStreamInput(options, 'account-vision'))
      return streamOf('delegated')
    },
  }
  const unrelated = { stream: () => streamOf('foreign') }
  const map = new Map([['account-vision', ownedAdapter]])
  const dispose = installOwnedTwinStreamBoundary(owner, route => map.get(route))
  const invoke = (provider) => {
    const options = { provider, model: 'm', messages: ['raw'] }
    return listeners[0](options, () => registrations.get(provider) === ownedAdapter
      ? ownedAdapter.stream({ ...options, messages: ['projected'] }) : streamOf('next'))
  }

  assert.deepEqual(await take(invoke('account')), ['next'], 'normal model routes remain untouched')
  assert.deepEqual(await take(invoke('someone-else-vision')), ['next'], 'similar suffix has no authority')
  assert.deepEqual(await take(invoke('account-vision')), ['next'], 'unregistered route is not intercepted')

  registrations.set('account-vision', unrelated)
  assert.deepEqual(await take(invoke('account-vision')), ['next'], 'foreign replacement is never hijacked')
  registrations.set('account-vision', ownedAdapter)
  assert.deepEqual(await take(invoke('account-vision')), ['delegated'], 'own matching adapter is intercepted')
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].messages, ['raw'])

  const canceled = new AbortController()
  canceled.abort(new Error('synthetic cancellation'))
  assert.deepEqual(await take(listeners[0]({
    provider: 'account-vision', model: 'm', messages: [], signal: canceled.signal,
  }, () => streamOf('host-aborted-path'))), ['host-aborted-path'],
  'already-aborted twin calls must return to Host cancellation validation')
  assert.equal(seen.length, 1, 'canceled request never reaches the delegated adapter')

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

test('issue #865: public-entry proxies preserve exact registration token and composed stream', async () => {
  let listener
  let registered
  const mark = Symbol.for('dsh-vision-router.adapter-owner')
  const token = Object.freeze({})
  const seen = []
  const core = identifyOwnedTwinStream({
    [mark]: token,
    stream(options) {
      seen.push(['core', options.provider])
      return streamOf('core stream')
    },
  })
  const ctx = {
    on(_event, handler) { listener = handler },
    llm: { registration() { return { adapter: registered } } },
  }
  installOwnedTwinStreamBoundary(ctx, route => route === 'account-vision' ? core : undefined)
  let pinned
  const invoke = () => listener({ provider: 'account-vision', model: 'm', messages: [] }, () => pinned === registered ? registered.stream({ provider: 'account-vision', model: 'm', messages: [] }) : streamOf('host'))
  registered = new Proxy(core, {
    get(target, prop, receiver) {
      if (prop !== 'stream') return Reflect.get(target, prop, receiver)
      return (opts) => {
        seen.push(['composed stream', opts.provider])
        return target.stream(opts)
      }
    },
  })
  assert.notEqual(registered, core)
  pinned = registered
  assert.deepEqual(await take(invoke()), ['core stream'])
  assert.deepEqual(seen, [['composed stream', 'account-vision'], ['core', 'account-vision']])
  registered = identifyOwnedTwinStream({ [mark]: token, stream: () => streamOf('other DVR generation') })
  assert.deepEqual(await take(invoke()), ['host'], 'even a shared generic owner marker cannot authorize another twin generation')
  registered = { [mark]: token, stream: () => streamOf('foreign with same generic marker') }
  assert.deepEqual(await take(invoke()), ['host'])
  registered = { [mark]: true, stream: () => streamOf('foreign') }
  assert.deepEqual(await take(invoke()), ['host'], 'truthy marker is not a registration token')
  registered = { stream: () => streamOf('foreign') }
  assert.deepEqual(await take(invoke()), ['host'])
  assert.equal(seen.length, 2)
})

test('issue #865: missing matching token never permits proxy alias dispatch', async () => {
  let listener
  const core = { stream: () => streamOf('raw') }
  const registered = new Proxy(core, {})
  installOwnedTwinStreamBoundary({
    on(_event, fn) { listener = fn },
    llm: { registration() { return { adapter: registered } } },
  }, () => core)
  assert.deepEqual(await take(listener({ provider: 'a-vision' }, () => streamOf('fallback'))), ['fallback'])
})

test('issue #865: actual image fallback facade forwards identity minted before ownership decoration', async () => {
  let listener
  const registrations = new Map()
  const ownerSymbol = Symbol.for('dsh-vision-router.adapter-owner')
  const ownerToken = Object.freeze({})
  const ctx = {
    on(_event, handler) { listener = handler },
    llm: {
      registration(route) {
        const adapter = registrations.get(route)
        if (!adapter) throw Error('unregistered')
        return { adapter }
      },
      registerAdapter(routes, adapter) {
        // The lower ownership layer writes onto the facade's OWN shell,
        // not the Core object hidden underneath.
        Object.defineProperty(adapter, ownerSymbol, {
          configurable: true, value: ownerToken,
        })
        for (const route of routes) registrations.set(route, adapter)
        return () => { for (const route of routes) registrations.delete(route) }
      },
    },
  }
  const composed = contextWithTwinImageCapabilityFallback(ctx)
  const core = identifyOwnedTwinStream({ stream: () => streamOf('exact core') })
  installOwnedTwinStreamBoundary(composed, route => route === 'account-vision' ? core : undefined)
  composed.llm.registerAdapter(['account-vision'], core)
  const registered = registrations.get('account-vision')
  assert.notEqual(registered, core)
  assert.equal(registered[ownerSymbol], ownerToken)
  assert.equal(core[ownerSymbol], undefined, 'old owner comparison would reject this real facade')
  const invoke = () => listener({ provider: 'account-vision', model: 'm', messages: [] }, () => registrations.get('account-vision') === registered ? registered.stream({ provider: 'account-vision', model: 'm', messages: [] }) : streamOf('host fallback'))
  assert.deepEqual(await take(invoke()), ['exact core'])
  composed.llm.registerAdapter(['account-vision'], identifyOwnedTwinStream({ stream: () => streamOf('replacement') }))
  assert.deepEqual(await take(invoke()), ['host fallback'])
})


test('Host next pins the old generation; scoped input is one-shot and retains resolved controls', async () => {
  let listener
  const old = identifyOwnedTwinStream({ stream: () => streamOf('old') })
  const replacement = identifyOwnedTwinStream({ stream: () => { throw Error('replacement dispatched') } })
  installOwnedTwinStreamBoundary({
    on(_event, fn) { listener = fn },
    llm: { registration() { return { adapter: replacement } } },
  }, () => replacement)
  let nextCalls = 0
  const signal = new AbortController().signal
  const original = { provider: 'x-vision', model: 'm', sessionId: 'one', signal,
    messages: ['raw'], tools: ['raw-tool'], toolHistory: ['history'] }
  const projected = { ...original, messages: ['projected'], tools: ['projected-tool'], reasoningEffort: 'high' }
  const result = await take(listener(original, () => {
    nextCalls++
    return (async function* () {
      assert.equal(restoreOwnedTwinStreamInput({ ...projected, sessionId: 'other' }, 'x-vision').messages[0], 'projected')
      assert.equal(restoreOwnedTwinStreamInput(projected, 'foreign-vision'), projected)
      const restored = restoreOwnedTwinStreamInput(projected, 'x-vision')
      assert.deepEqual(restored.messages, ['raw'])
      assert.deepEqual(restored.tools, ['raw-tool'])
      assert.deepEqual(restored.toolHistory, ['history'])
      assert.equal(restored.reasoningEffort, 'high')
      assert.equal(restoreOwnedTwinStreamInput(projected, 'x-vision'), projected)
      yield* old.stream()
    })()
  }))
  assert.deepEqual(result, ['old'])
  assert.equal(nextCalls, 1)
  assert.equal(restoreOwnedTwinStreamInput(projected, 'x-vision'), projected)
})

test('concurrent twin streams cannot consume one another’s input and cleanup keeps Host return', async () => {
  let listener
  const adapter = identifyOwnedTwinStream({ stream() {} })
  installOwnedTwinStreamBoundary({
    on(_event, fn) { listener = fn },
    llm: { registration() { return { adapter } } },
  }, () => adapter)
  const calls = []
  function make(sessionId) {
    const raw = { provider: 'x-vision', model: 'm', sessionId, messages: [sessionId] }
    return listener(raw, () => (async function* () {
      try {
        await Promise.resolve()
        yield restoreOwnedTwinStreamInput({ ...raw, messages: ['projected'] }, 'x-vision').messages[0]
        yield 'second'
      } finally { calls.push(sessionId) }
    })())[Symbol.asyncIterator]()
  }
  const a = make('a'), b = make('b')
  assert.deepEqual((await Promise.all([a.next(), b.next()])).map(x => x.value), ['a','b'])
  await Promise.all([a.return(), b.return()])
  assert.deepEqual(calls.sort(), ['a','b'])
})
