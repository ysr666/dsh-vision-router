import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createSessionVisionPolicyRuntimeStore,
  sessionVisionPolicyDomainSpec,
} from '../lib/session-vision-policy-domain.js'
import {
  delegatedSessionVisionPolicy,
  userSessionVisionPolicy,
} from '../lib/session-vision-policy.js'

function durableHarness(seed = []) {
  const rows = new Map(seed)
  const closes = []
  const warnings = []
  const domain = {
    table(name) {
      assert.equal(name, 'policies')
      return {
        get(key) { return rows.get(key) },
        async put(key, value) { rows.set(key, value) },
        async delete(key) { return rows.delete(key) },
      }
    },
    async close() { closes.push(true) },
  }
  const storageDomain = {
    async open(spec) {
      assert.equal(spec, sessionVisionPolicyDomainSpec)
      return domain
    },
  }
  const ctx = {
    get(name) {
      return name === 'storageDomain' ? storageDomain : undefined
    },
    effect(setup) {
      this.cleanup = setup()
    },
    logger: {
      warn(...args) { warnings.push(args) },
    },
  }
  return { ctx, rows, closes, warnings }
}

test('runtime policy store stays volatile when Host has no storageDomain', async () => {
  const store = createSessionVisionPolicyRuntimeStore({})
  assert.equal(store.durable, false)
  await store.set('s', userSessionVisionPolicy(true))
  assert.equal(store.get('s')?.enabled, true)
  assert.equal(await store.hydrate('s'), store.get('s'))
})

test('optional storageDomain capability never requires direct Cordis service access', async () => {
  const rows = new Map()
  const domain = {
    table() {
      return {
        get(key) { return rows.get(key) },
        async put(key, value) { rows.set(key, value) },
        async delete(key) { rows.delete(key) },
      }
    },
    async close() {},
  }
  const host = new Proxy({
    get(name) {
      if (name === 'storageDomain') {
        return { async open() { return domain } }
      }
      return undefined
    },
    effect(setup) { this.cleanup = setup() },
  }, {
    get(target, property, receiver) {
      if (property === 'storageDomain') {
        throw new Error('cannot get property "storageDomain" without inject')
      }
      return Reflect.get(target, property, receiver)
    },
  })

  const store = createSessionVisionPolicyRuntimeStore(host)
  assert.equal(store.durable, true)
  await store.set('session', userSessionVisionPolicy(true))
  assert.equal(rows.get('session')?.enabled, true)
})

test('runtime policy store writes and hydrates through the official sidecar shape', async () => {
  const h = durableHarness()
  const first = createSessionVisionPolicyRuntimeStore(h.ctx)
  assert.equal(first.durable, true)

  await first.set('child', delegatedSessionVisionPolicy(true, 'parent'))
  assert.deepEqual(h.rows.get('child'), {
    revision: 1,
    enabled: true,
    source: 'delegation',
    inheritedFrom: 'parent',
  })

  const secondHarness = durableHarness([...h.rows])
  const second = createSessionVisionPolicyRuntimeStore(secondHarness.ctx)
  assert.equal(second.get('child'), undefined)
  const restored = await second.hydrate('child')
  assert.deepEqual(restored, h.rows.get('child'))
  assert.deepEqual(second.get('child'), restored)
})

test('durable sidecar failure degrades once to volatile without blocking Vision', async () => {
  const warnings = []
  const store = createSessionVisionPolicyRuntimeStore({
    get(name) {
      if (name !== 'storageDomain') return undefined
      return {
        async open() { throw new Error('storage offline') },
      }
    },
    effect(setup) { this.cleanup = setup() },
    logger: { warn(...args) { warnings.push(args) } },
  })

  await store.set('child', delegatedSessionVisionPolicy(true, 'parent'))
  assert.equal(store.durable, false)
  assert.equal(store.get('child')?.enabled, true)
  await store.set('other', userSessionVisionPolicy(false))
  assert.equal(warnings.length, 1)
})

test('policy domain uses per-record backup-and-skip storage semantics', () => {
  assert.equal(sessionVisionPolicyDomainSpec.layout, 'per-record')
  assert.equal(sessionVisionPolicyDomainSpec.invalidRecords, 'backup-and-skip')
  assert.ok(sessionVisionPolicyDomainSpec.tables.policies.valueSchema.safeParse({
    revision: 1,
    enabled: true,
    source: 'delegation',
    inheritedFrom: 'parent',
  }).success)
  assert.equal(sessionVisionPolicyDomainSpec.tables.policies.valueSchema.safeParse({
    revision: 1,
    enabled: true,
    source: 'delegation',
  }).success, false)
})


test('slow domain open is still owned when DVR unloads before the handle resolves', async () => {
  let resolveOpen
  let active = false
  let closes = 0
  const rows = new Map()
  const domain = {
    table() {
      return {
        get(key) { return rows.get(key) },
        async put(key, value) { rows.set(key, value) },
        async delete(key) { rows.delete(key) },
      }
    },
    async close() {
      closes += 1
      active = false
    },
  }
  let opens = 0
  const facility = {
    async open() {
      if (active) throw new Error('already-open')
      active = true
      opens += 1
      if (opens > 1) return domain
      return await new Promise((resolve) => { resolveOpen = () => resolve(domain) })
    },
  }
  const ctx = {
    get(name) { return name === 'storageDomain' ? facility : undefined },
    effect(setup) { this.cleanup = setup() },
  }

  const first = createSessionVisionPolicyRuntimeStore(ctx)
  const pending = first.set('child', delegatedSessionVisionPolicy(true, 'parent'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(typeof resolveOpen, 'function')
  const cleanup = ctx.cleanup()
  resolveOpen()
  await Promise.all([pending, cleanup])
  assert.equal(closes, 1)
  assert.equal(active, false)
  assert.equal(first.get('child')?.enabled, true, 'unload race must retain volatile authority')

  const nextCtx = {
    get(name) { return name === 'storageDomain' ? facility : undefined },
    effect(setup) { this.cleanup = setup() },
  }
  const second = createSessionVisionPolicyRuntimeStore(nextCtx)
  await second.set('next', userSessionVisionPolicy(false))
  assert.equal(active, true, 'next generation must be able to reopen the same domain')
  await nextCtx.cleanup()
  assert.equal(closes, 2)
})

test('storageDomain replacement retires the previous handle before opening the replacement', async () => {
  const closes = []
  const rowsA = new Map()
  const rowsB = new Map()
  const domain = (label, rows) => ({
    table() {
      return {
        get(key) { return rows.get(key) },
        async put(key, value) { rows.set(key, value) },
        async delete(key) { rows.delete(key) },
      }
    },
    async close() { closes.push(label) },
  })
  const domainA = domain('a', rowsA)
  const domainB = domain('b', rowsB)
  const facilityA = { async open() { return domainA } }
  const facilityB = { async open() { return domainB } }
  let current = facilityA
  const ctx = {
    get(name) { return name === 'storageDomain' ? current : undefined },
    effect(setup) { this.cleanup = setup() },
  }
  const store = createSessionVisionPolicyRuntimeStore(ctx)
  await store.set('a', userSessionVisionPolicy(true))
  current = facilityB
  await store.set('b', userSessionVisionPolicy(false))
  assert.deepEqual(closes, ['a'])
  assert.equal(rowsB.get('b')?.enabled, false)
  await ctx.cleanup()
  assert.deepEqual(closes, ['a', 'b'])
})

test('durable hot cache can be released and rehydrated without deleting Session truth', async () => {
  const h = durableHarness()
  const store = createSessionVisionPolicyRuntimeStore(h.ctx)
  await store.set('session', userSessionVisionPolicy(true))
  assert.equal(store.get('session')?.enabled, true)
  store.release('session')
  assert.equal(store.get('session'), undefined)
  assert.equal((await store.hydrate('session'))?.enabled, true)
  assert.equal(h.rows.get('session')?.enabled, true)
})


test('same-Session durable writes preserve Session event order under reordered storage completion', async () => {
  const rows = new Map()
  const pending = []
  const domain = {
    table() {
      return {
        get(key) { return rows.get(key) },
        put(key, value) {
          return new Promise((resolve) => {
            pending.push({ key, value, resolve: () => { rows.set(key, value); resolve() } })
          })
        },
        async delete(key) { rows.delete(key) },
      }
    },
    async close() {},
  }
  const ctx = {
    get(name) { return name === 'storageDomain' ? { async open() { return domain } } : undefined },
    effect(setup) { this.cleanup = setup() },
  }
  const store = createSessionVisionPolicyRuntimeStore(ctx)
  const first = store.set('session', userSessionVisionPolicy(true))
  const second = store.set('session', userSessionVisionPolicy(false))
  while (pending.length < 1) await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(pending.length, 1, 'later durable write must wait behind the earlier Session event')

  pending[0].resolve()
  await first
  while (pending.length < 2) await new Promise((resolve) => setImmediate(resolve))
  pending[1].resolve()
  await second

  assert.equal(store.get('session')?.enabled, false, 'hot authority follows the newest Session event')
  assert.equal(rows.get('session')?.enabled, false, 'durable authority must preserve the same event order')
})


test('policy domain unload waits for an admitted durable mutation before closing its handle', async () => {
  let resolvePut
  let putStarted = false
  let closes = 0
  const domain = {
    table() {
      return {
        get() { return undefined },
        put() {
          putStarted = true
          return new Promise((resolve) => { resolvePut = resolve })
        },
        async delete() {},
      }
    },
    async close() { closes += 1 },
  }
  const ctx = {
    get(name) { return name === 'storageDomain' ? { async open() { return domain } } : undefined },
    effect(setup) { this.cleanup = setup() },
  }
  const store = createSessionVisionPolicyRuntimeStore(ctx)
  const write = store.set('session', userSessionVisionPolicy(true))
  while (!putStarted) await new Promise((resolve) => setImmediate(resolve))
  const cleanup = ctx.cleanup()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closes, 0, 'consumer unload must not close the domain underneath an admitted put')
  resolvePut()
  await Promise.all([write, cleanup])
  assert.equal(closes, 1)
})


test('late durable hydration cannot overwrite a newer in-process Session selection', async () => {
  const rows = new Map([['session', userSessionVisionPolicy(false)]])
  let releaseOpen
  const domain = {
    table() {
      return {
        get(key) { return rows.get(key) },
        async put(key, value) { rows.set(key, value) },
        async delete(key) { rows.delete(key) },
      }
    },
    async close() {},
  }
  const facility = {
    open() { return new Promise((resolve) => { releaseOpen = () => resolve(domain) }) },
  }
  const ctx = {
    get(name) { return name === 'storageDomain' ? facility : undefined },
    effect(setup) { this.cleanup = setup() },
  }
  const store = createSessionVisionPolicyRuntimeStore(ctx)
  const hydration = store.hydrate('session')
  while (typeof releaseOpen !== 'function') await new Promise((resolve) => setImmediate(resolve))
  const selection = store.set('session', userSessionVisionPolicy(true))
  releaseOpen()
  await Promise.all([hydration, selection])

  assert.equal(rows.get('session')?.enabled, true)
  assert.equal(store.get('session')?.enabled, true, 'cold hydration must not replace newer live authority')
})


test('policy domain unload drains a mutation admitted behind an earlier same-Session write', async () => {
  const rows = new Map()
  const pending = []
  let closes = 0
  const domain = {
    table() {
      return {
        get(key) { return rows.get(key) },
        put(key, value) {
          return new Promise((resolve) => {
            pending.push({ key, value, resolve: () => { rows.set(key, value); resolve() } })
          })
        },
        async delete(key) { rows.delete(key) },
      }
    },
    async close() { closes += 1 },
  }
  const facility = { async open() { return domain } }
  const ctx = {
    get(name) { return name === 'storageDomain' ? facility : undefined },
    effect(setup) { this.cleanup = setup() },
  }
  const store = createSessionVisionPolicyRuntimeStore(ctx)
  const first = store.set('session', userSessionVisionPolicy(true))
  const second = store.set('session', userSessionVisionPolicy(false))
  while (pending.length < 1) await new Promise((resolve) => setImmediate(resolve))

  const cleanup = ctx.cleanup()
  pending[0].resolve()
  await first
  while (pending.length < 2) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closes, 0, 'unload must keep the domain alive for already-admitted queued writes')
  pending[1].resolve()
  await Promise.all([second, cleanup])

  assert.equal(rows.get('session')?.enabled, false, 'the queued pre-unload mutation must reach durable storage')
  assert.equal(closes, 1)
})

test('issue #865 B2: subscribe to the same cache authority, isolate Sessions and dispose exactly', async () => {
  const h = durableHarness()
  const store = createSessionVisionPolicyRuntimeStore(h.ctx)
  const seen = []
  const listener = () => seen.push(store.get('a')?.enabled)
  const offA = store.subscribe('a', listener)
  const offB = store.subscribe('b', () => seen.push('unexpected-b'))
  const offA2 = store.subscribe('a', listener)
  const offThrow = store.subscribe('a', () => { throw Error('broken observer') })
  await store.set('a', userSessionVisionPolicy(true))
  assert.deepEqual(seen, [true, true])
  offA()
  offA()
  await store.set('a', userSessionVisionPolicy(false))
  assert.deepEqual(seen, [true, true, false])
  store.release('a')
  assert.equal(seen.at(-1), undefined)
  await store.hydrate('a')
  assert.equal(seen.at(-1), false)
  await store.delete('a')
  assert.equal(seen.at(-1), undefined)
  assert.equal(h.rows.has('a'), false)
  offA2(); offB(); offThrow()
  const count = seen.length
  await store.set('a', userSessionVisionPolicy(true))
  assert.equal(seen.length, count)
  await h.ctx.cleanup()
  const offClosed = store.subscribe('a', listener)
  offClosed()
  assert.equal(seen.length, count)
})

test('issue #865 B2: reentrant observers cannot reorder the durable policy queue', async () => {
  const h = durableHarness()
  const store = createSessionVisionPolicyRuntimeStore(h.ctx)
  let nested
  const unsubscribe = store.subscribe('a', () => {
    if (store.get('a')?.enabled === true) nested = store.set('a', userSessionVisionPolicy(false))
  })
  await store.set('a', userSessionVisionPolicy(true))
  await nested
  assert.equal(store.get('a')?.enabled, false)
  assert.equal(h.rows.get('a')?.enabled, false)
  unsubscribe()
  await h.ctx.cleanup()
})

test('issue #865 B2: durability degradation invalidates all active views without clearing policy', async () => {
  const store = createSessionVisionPolicyRuntimeStore({
    get(name) { return name === 'storageDomain' ? { async open() { throw Error('offline') } } : undefined },
    effect(setup) { this.cleanup = setup() },
  })
  const seenA = []
  const seenB = []
  const offA = store.subscribe('a', () => seenA.push([store.get('a')?.enabled, store.durable]))
  const offB = store.subscribe('b', () => seenB.push(store.durable))
  await store.set('a', userSessionVisionPolicy(true))
  assert.deepEqual(seenA, [[true, true], [true, false]])
  assert.deepEqual(seenB, [false])
  assert.equal(store.get('a')?.enabled, true)
  offA(); offB()
})

function delayedPolicyMutationHarness() {
  const rows = new Map([['s', userSessionVisionPolicy(true)]])
  const writes = []
  const domain = {
    table() {
      return {
        get(key) { return rows.get(key) },
        put(key, value) {
          return new Promise((resolve, reject) => writes.push({
            finish() { rows.set(key, value); resolve() },
            fail() { reject(Error('storage offline')) },
          }))
        },
        delete(key) {
          return new Promise(resolve => writes.push({
            finish() { rows.delete(key); resolve() },
          }))
        },
      }
    },
    async close() {},
  }
  const facility = { async open() { return domain } }
  const ctx = {
    get(name) { return name === 'storageDomain' ? facility : undefined },
    effect(setup) { this.cleanup = setup() },
  }
  return { rows, writes, ctx, store: createSessionVisionPolicyRuntimeStore(ctx) }
}

test('release during a pending OFF write cannot restore old ON authority', async () => {
  const h = delayedPolicyMutationHarness()
  await h.store.hydrate('s')
  const off = h.store.set('s', userSessionVisionPolicy(false))
  while (!h.writes.length) await new Promise(resolve => setImmediate(resolve))
  h.store.release('s')
  assert.equal(h.rows.get('s')?.enabled, true, 'old disk row is still ON')
  assert.equal((await h.store.hydrate('s'))?.enabled, false)
  h.writes[0].finish()
  await off
  assert.equal(h.rows.get('s')?.enabled, false)
  assert.equal(h.store.get('s')?.enabled, false, 'deferred eviction cannot retire the resumed Agent')
  h.store.release('s')
  assert.equal(h.store.get('s'), undefined)
  assert.equal((await h.store.hydrate('s'))?.enabled, false)
  await h.ctx.cleanup()
})

test('deferred release evicts a successfully flushed inactive Session but not a failed write', async () => {
  for (const fail of [false, true]) {
    const h = delayedPolicyMutationHarness()
    await h.store.hydrate('s')
    const off = h.store.set('s', userSessionVisionPolicy(false))
    while (!h.writes.length) await new Promise(resolve => setImmediate(resolve))
    h.store.release('s')
    assert.equal(h.store.get('s')?.enabled, false)
    if (fail) h.writes[0].fail()
    else h.writes[0].finish()
    await off
    assert.equal(h.store.durable, !fail)
    assert.equal(h.store.get('s')?.enabled, fail ? false : undefined)
    await h.ctx.cleanup()
  }
})

test('pending policy deletion is not resurrected by Agent hydration', async () => {
  const h = delayedPolicyMutationHarness()
  await h.store.hydrate('s')
  const deletion = h.store.delete('s')
  while (!h.writes.length) await new Promise(resolve => setImmediate(resolve))
  h.store.release('s')
  assert.equal(await h.store.hydrate('s'), undefined)
  h.writes[0].finish()
  await deletion
  assert.equal(h.rows.has('s'), false)
  assert.equal(await h.store.hydrate('s'), undefined)
  await h.ctx.cleanup()
})

test('concurrent cold hydration shares one read and returns identical OFF authority', async () => {
  const h = durableHarness([['s', userSessionVisionPolicy(false)]])
  const store = createSessionVisionPolicyRuntimeStore(h.ctx)
  const [a, b] = await Promise.all([store.hydrate('s'), store.hydrate('s')])
  assert.equal(a?.enabled, false)
  assert.equal(a, b)
  assert.equal(store.get('s'), a)
  await h.ctx.cleanup()
})

test('storage disappearance during OFF or delete cannot resurrect an older policy after service recovery', async () => {
  for (const operation of ['off', 'delete']) {
    const h = durableHarness([['s', userSessionVisionPolicy(true)]])
    const lookup = h.ctx.get.bind(h.ctx)
    let available = true
    h.ctx.get = name => available ? lookup(name) : undefined
    const store = createSessionVisionPolicyRuntimeStore(h.ctx)
    assert.equal((await store.hydrate('s'))?.enabled, true)
    available = false
    if (operation === 'off') await store.set('s', userSessionVisionPolicy(false))
    else await store.delete('s')
    assert.equal(store.durable, false)
    assert.equal(h.rows.get('s')?.enabled, true, 'unavailable storage still has old ON')
    available = true
    assert.equal(store.durable, false, 'service availability cannot prove an earlier write')
    store.release('s')
    assert.equal((await store.hydrate('s'))?.enabled, operation === 'off' ? false : undefined)
    await h.ctx.cleanup()
  }
})

test('a service appearing after a volatile mutation cannot make that intent evictable', async () => {
  const h = durableHarness([['s', userSessionVisionPolicy(true)]])
  const lookup = h.ctx.get.bind(h.ctx)
  let available = false
  h.ctx.get = name => available ? lookup(name) : undefined
  const store = createSessionVisionPolicyRuntimeStore(h.ctx)
  await store.set('s', userSessionVisionPolicy(false))
  available = true
  store.release('s')
  assert.equal(store.durable, false)
  assert.equal((await store.hydrate('s'))?.enabled, false)
  await h.ctx.cleanup()
})

test('one Session storage failure cannot turn another cold persisted OFF into a route grant', async () => {
  const h = durableHarness([['b', userSessionVisionPolicy(false)]])
  const lookup = h.ctx.get.bind(h.ctx)
  let available = true
  h.ctx.get = name => available ? lookup(name) : undefined
  const store = createSessionVisionPolicyRuntimeStore(h.ctx)
  assert.equal((await store.hydrate('b'))?.enabled, false)
  store.release('b')
  available = false
  await store.set('a', userSessionVisionPolicy(false))
  available = true
  assert.equal(await store.hydrate('b'), undefined)
  assert.equal(store.isUnverified('b'), true, 'unreadable is not absent')
  assert.equal(store.isUnverified('a'), false, 'explicit live authority remains known')
  assert.equal(h.rows.get('b')?.enabled, false)
  await store.set('b', userSessionVisionPolicy(true))
  assert.equal(store.isUnverified('b'), false, 'explicit new user intent can resolve the unknown')
  assert.equal(store.get('b')?.enabled, true)
  await h.ctx.cleanup()
})

test('only a verified absent record or a Host without the optional store may use route fallback', async () => {
  const h = durableHarness()
  const store = createSessionVisionPolicyRuntimeStore(h.ctx)
  assert.equal(store.isUnverified('fresh'), true)
  assert.equal(await store.hydrate('fresh'), undefined)
  assert.equal(store.isUnverified('fresh'), false)
  store.release('fresh')
  assert.equal(store.isUnverified('fresh'), true)
  await store.delete('fresh')
  assert.equal(store.isUnverified('fresh'), false)
  await h.ctx.cleanup()
  const legacy = createSessionVisionPolicyRuntimeStore({})
  assert.equal(legacy.isUnverified('fresh'), false)
})
