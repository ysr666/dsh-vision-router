import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installNativeVisionControlRemote } from '../lib/native-vision-control-remote.js'
import { startNativeVisionClientObservation } from '../lib/native-vision-control-client.js'

const matchingLookup = () => ({
  resource: 'session',
  wire: 'agentId',
  wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
  resolve(id) { return { id } },
})

function remoteFixture() {
  const calls = { registrations: 0, withdrawals: 0, provisions: 0, unprovisions: 0 }
  let lookup
  let listener
  let receiver
  let descriptor
  let ownerDisposer
  let childDisposer
  let mountChild
  let lastMutationSignal

  const typert = {
    register(contribution) {
      calls.registrations++
      assert.equal(contribution.face, 'host')
      assert.deepEqual(contribution.invocations.map(x => x.method), ['observe', 'set'])
      descriptor = contribution
      return () => {
        calls.withdrawals++
        descriptor = undefined
      }
    },
    lookups: {
      get(key) { assert.equal(key, 'agent'); return lookup },
      subscribe(fn) { listener = fn },
    },
  }
  const makeChildScope = () => ({
    typert,
    provide(name, value) {
      assert.equal(name, 'dvrNativeVision')
      assert.equal(receiver, undefined, 'at most one active receiver per lookup')
      calls.provisions++
      receiver = value
      return () => {
        assert.equal(receiver, value)
        calls.unprovisions++
        receiver = undefined
      }
    },
    effect(setup) { childDisposer = setup() },
    logger: { warn() {} },
  })
  const owner = {
    typert,
    effect(setup) { ownerDisposer = setup() },
    inject(deps, callback) {
      assert.deepEqual(deps, ['agents', 'llm'])
      mountChild = callback
      return callback(makeChildScope())
    },
  }
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['typert'],
        'the strict Remote definition must outlive Agents/LLM generation churn')
      return callback(owner)
    },
  }
  const store = { subscribe() {} }
  const mutate = async (_agent, _request, signal) => {
    lastMutationSignal = signal
    return { kind: 'success', text: 'accepted' }
  }
  installNativeVisionControlRemote(ctx, store, { mutate })
  return {
    calls,
    get receiver() { return receiver },
    get descriptor() { return descriptor },
    get lastMutationSignal() { return lastMutationSignal },
    setLookup(value) {
      lookup = value
      listener?.({ kind: 'lookup', key: 'agent' })
    },
    otherChange() { listener?.({ kind: 'lookup', key: 'unrelated' }) },
    retireAgents() {
      childDisposer?.()
      childDisposer = undefined
      listener = undefined
    },
    remountAgents() {
      assert.ok(mountChild)
      return mountChild(makeChildScope())
    },
    remountOverlappingAgents() {
      const oldListener = listener
      const oldDisposer = childDisposer
      mountChild(makeChildScope())
      return {
        fireOldLookupChange() { oldListener?.({ kind: 'lookup', key: 'agent' }) },
        retireOldScope() { oldDisposer?.() },
      }
    },
    dispose() {
      this.retireAgents()
      ownerDisposer?.()
    },
  }
}

test('issue #865: a withdrawn Agent lookup revokes receiver but NOT the strict Gateway definition', async () => {
  const f = remoteFixture()
  assert.equal(f.receiver, undefined)
  assert.equal(f.descriptor, undefined, 'a never-capable Host must not register this Remote')

  f.setLookup(matchingLookup())
  assert.equal(f.calls.registrations, 1)
  assert.equal(f.calls.provisions, 1)
  const original = f.receiver
  assert.ok(original)
  assert.ok(f.descriptor)
  assert.deepEqual(await original.set(
    { id: 'one' }, { enabled: true, selection: { provider: 'native', model: 'mm' } },
  ), { kind: 'success', text: 'accepted' })
  const firstSignal = f.lastMutationSignal
  assert.equal(firstSignal.aborted, false)

  f.setLookup(undefined)
  assert.equal(f.receiver, undefined, 'no stale Agent can be resolved during registry outage')
  assert.equal(firstSignal.aborted, true, 'in-flight observation/mutation lifetime is aborted')
  assert.equal(f.calls.unprovisions, 1)
  assert.equal(f.calls.withdrawals, 0, 'no gateway/definition-unavailable while DVR itself is live')
  assert.ok(f.descriptor, 'strict definition stays registered; no unsafe SRC fallback')
  await assert.rejects(original.set(
    { id: 'one' }, { enabled: true, selection: { provider: 'native', model: 'mm' } },
  ), { name: 'AbortError' }, 'retired receiver must not execute a new mutation')

  f.setLookup({ ...matchingLookup(), wireTypeSymbol: 'incompatible' })
  assert.equal(f.receiver, undefined, 'incompatible lookup must remain fail-closed')
  assert.equal(f.calls.registrations, 1)
  f.setLookup(matchingLookup())
  assert.equal(f.calls.registrations, 1, 'do not withdraw/re-register the same strict method')
  assert.equal(f.calls.provisions, 2, 'only the receiver must be recreated')
  assert.notEqual(f.receiver, original)
  assert.deepEqual(await f.receiver.set(
    { id: 'two' }, { enabled: false, selection: { provider: 'native', model: 'mm' } },
  ), { kind: 'success', text: 'accepted' })
  f.otherChange()
  assert.equal(f.calls.provisions, 2)
  f.dispose()
  assert.equal(f.receiver, undefined)
  assert.equal(f.descriptor, undefined)
  assert.equal(f.calls.withdrawals, 1, 'the descriptor is withdrawn only when the plugin generation ends')
  assert.equal(f.calls.unprovisions, 2)
  f.setLookup(matchingLookup())
  assert.equal(f.calls.registrations, 1, 'disposed plugin must not silently remount')
})

test('issue #865: Agents/LLM dependency restarts cannot withdraw strict native Remote definition', async () => {
  const f = remoteFixture()
  f.setLookup(matchingLookup())
  const original = f.receiver
  assert.ok(original)
  assert.ok(f.descriptor)
  assert.equal(f.calls.registrations, 1)

  f.retireAgents()
  assert.equal(f.receiver, undefined, 'old Agent lifetime must immediately revoke its receiver')
  assert.ok(f.descriptor, 'Typert-owned strict endpoint must survive child dependency retirement')
  assert.equal(f.calls.withdrawals, 0)
  await assert.rejects(original.set(
    { id: 'retired' }, { enabled: true, selection: { provider: 'native', model: 'mm' } },
  ), { name: 'AbortError' })

  f.remountAgents()
  assert.notEqual(f.receiver, original)
  assert.ok(f.receiver)
  assert.equal(f.calls.registrations, 1, 'no duplicate strict registration during dependency reload')
  assert.equal(f.calls.provisions, 2)
  f.retireAgents()
  assert.equal(f.calls.withdrawals, 0)
  f.remountAgents()
  assert.equal(f.calls.registrations, 1, 'repeated HMR-style dependency rebinding retains exact method identity')
  assert.equal(f.calls.provisions, 3)
  f.dispose()
  assert.equal(f.calls.withdrawals, 1, 'only Typert/plugin retirement withdraws the descriptor')
  assert.equal(f.calls.unprovisions, 3)
})

test('issue #865: an overlapping old Agent fiber cannot reprovide its retired Remote', async () => {
  const f = remoteFixture()
  f.setLookup(matchingLookup())
  const original = f.receiver
  const overlapping = f.remountOverlappingAgents()
  assert.notEqual(f.receiver, original)
  assert.equal(f.calls.unprovisions, 1)
  assert.equal(f.calls.provisions, 2)
  assert.equal(f.calls.registrations, 1)
  const current = f.receiver
  overlapping.fireOldLookupChange()
  assert.equal(f.receiver, current, 'old scoped listener cannot resurrect a stale receiver')
  assert.equal(f.calls.provisions, 2)
  overlapping.retireOldScope()
  assert.equal(f.receiver, current, 'late old fiber teardown cannot retire the new generation')
  f.dispose()
  assert.equal(f.calls.withdrawals, 1)
  assert.equal(f.calls.unprovisions, 2)
})

test('issue #865: only transient lookup/service READ failures are retried, never writes', async () => {
  const validView = {
    kind: 'native', selection: { provider: 'p', model: 'm' },
    enabled: false, requestedEnabled: false, canEnable: true, durable: true,
  }
  for (const reason of ['gateway/lookup-unavailable', 'gateway/service-unavailable']) {
    let reads = 0
    let writes = 0
    let observer
    const api = {
      observe() {
        reads++
        if (reads === 1) throw Object.assign(new Error(reason), { code: reason })
        return (async function* () { yield validView })()
      },
      async set() { writes++; throw new Error('the test must never replay writes') },
    }
    const result = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('read-only native observer retry timed out')), 2500)
      observer = startNativeVisionClientObservation(api, 'session', state => {
        if (state.kind === 'value' || state.kind === 'failed') {
          clearTimeout(deadline)
          resolve(state)
        }
      }, { retryDelays: [1, 1] })
    })
    observer.stop()
    assert.equal(result.kind, 'value', reason)
    assert.equal(reads, 2, 'a temporary registry outage retries only the read subscription')
    assert.equal(writes, 0)
  }
})

test('issue #865: unauthorized or withdrawn strict Remote never retries or falls back to SRC', async () => {
  for (const reason of ['gateway/definition-unavailable', 'gateway/provider-mismatch', 'remote-access/denied']) {
    let reads = 0
    let observer
    const api = {
      observe() {
        reads++
        throw Object.assign(new Error(reason), { code: reason })
      },
      async set() { throw new Error('unexpected write') },
    }
    const result = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('native observer denial timeout')), 2500)
      observer = startNativeVisionClientObservation(api, 'session', state => {
        if (state.kind === 'failed') { clearTimeout(deadline); resolve(state) }
      }, { retryDelays: [1, 1] })
    })
    observer.stop()
    assert.equal(result.kind, 'failed')
    assert.equal(result.reason, reason)
    assert.equal(reads, 1, reason + ' is a hard failure, never silent compatibility fallback')
  }
})
