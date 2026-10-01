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
