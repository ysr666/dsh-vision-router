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
  const ctx = {
    storageDomain: {
      async open(spec) {
        assert.equal(spec, sessionVisionPolicyDomainSpec)
        return domain
      },
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
    storageDomain: {
      async open() { throw new Error('storage offline') },
    },
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
