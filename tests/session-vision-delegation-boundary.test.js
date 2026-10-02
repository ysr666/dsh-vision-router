import assert from 'node:assert/strict'
import test from 'node:test'

import {
  installSessionVisionDelegationBoundary,
} from '../lib/session-vision-delegation-boundary.js'
import {
  createSessionVisionPolicyStore,
  userSessionVisionPolicy,
} from '../lib/session-vision-policy.js'

function harness({ parent, owned = true, seed = [] } = {}) {
  const rows = new Map(seed)
  const store = createSessionVisionPolicyStore({
    get(key) { return rows.get(key) },
    async put(key, value) { rows.set(key, value) },
    async delete(key) { rows.delete(key) },
  })
  let listener
  const ctx = {
    agents: {
      currentInitiator() { return parent },
      isOwnedBy(id, owner) {
        return owned && owner === parent && id === 'child'
      },
    },
    on(event, callback) {
      assert.equal(event, 'agent/created')
      listener = callback
    },
  }
  return {
    rows,
    store,
    ctx,
    async created(agent) {
      assert.ok(listener)
      await listener({ agent })
    },
  }
}

test('agent/created snapshots DVR authority for the exact runtime-owned child', async () => {
  const parent = { id: 'parent', routeEnabled: true }
  const h = harness({ parent })
  installSessionVisionDelegationBoundary(
    h.ctx,
    h.store,
    agent => ({ enabled: agent.routeEnabled }),
  )

  await h.created({ id: 'child', routeEnabled: false })

  assert.deepEqual(h.store.get('child'), {
    revision: 1,
    enabled: true,
    source: 'delegation',
    inheritedFrom: 'parent',
  })
})

test('agent/created ignores roots and unrelated Agents', async () => {
  const root = harness()
  installSessionVisionDelegationBoundary(root.ctx, root.store, () => ({ enabled: true }))
  await root.created({ id: 'child' })
  assert.equal(root.store.get('child'), undefined)

  const parent = { id: 'parent' }
  const foreign = harness({ parent, owned: false })
  installSessionVisionDelegationBoundary(foreign.ctx, foreign.store, () => ({ enabled: true }))
  await foreign.created({ id: 'child' })
  assert.equal(foreign.store.get('child'), undefined)
})

test('agent/created preserves an existing child-local decision', async () => {
  const parent = { id: 'parent', routeEnabled: true }
  const h = harness({ parent })
  await h.store.set('child', userSessionVisionPolicy(false))
  installSessionVisionDelegationBoundary(
    h.ctx,
    h.store,
    agent => ({ enabled: agent.routeEnabled }),
  )

  await h.created({ id: 'child', routeEnabled: true })
  assert.deepEqual(h.store.get('child'), {
    revision: 1,
    enabled: false,
    source: 'user',
  })
})

test('policy persistence failure rejects the serial creation listener', async () => {
  const parent = { id: 'parent' }
  let listener
  const ctx = {
    agents: {
      currentInitiator() { return parent },
      isOwnedBy() { return true },
    },
    on(_event, callback) { listener = callback },
  }
  const failingStore = {
    get() { return undefined },
    async set() { throw new Error('durability failed') },
    async delete() {},
  }
  installSessionVisionDelegationBoundary(ctx, failingStore, () => ({ enabled: true }))

  await assert.rejects(
    () => listener({ agent: { id: 'child' } }),
    /durability failed/,
  )
})
