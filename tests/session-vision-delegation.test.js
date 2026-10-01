import assert from 'node:assert/strict'
import test from 'node:test'

import {
  materializeDelegatedSessionVisionPolicy,
} from '../lib/session-vision-delegation.js'
import {
  createSessionVisionPolicyStore,
  userSessionVisionPolicy,
} from '../lib/session-vision-policy.js'

function memoryStore(seed = []) {
  const rows = new Map(seed)
  const table = {
    get(key) { return rows.get(key) },
    async put(key, value) { rows.set(key, value) },
    async delete(key) { rows.delete(key) },
  }
  return { rows, store: createSessionVisionPolicyStore(table) }
}

test('delegation snapshots parent route-derived authority when no parent policy exists', async () => {
  const { store } = memoryStore()
  const parent = { id: 'parent', routeEnabled: true }
  const child = { id: 'child', routeEnabled: false }

  const result = await materializeDelegatedSessionVisionPolicy(
    store,
    parent,
    child,
    agent => ({ enabled: agent.routeEnabled }),
  )

  assert.equal(result.status, 'materialized')
  assert.deepEqual(store.get('child'), {
    revision: 1,
    enabled: true,
    source: 'delegation',
    inheritedFrom: 'parent',
  })
})

test('parent durable policy outranks route-derived compatibility authority', async () => {
  const { store } = memoryStore()
  await store.set('parent', userSessionVisionPolicy(true))

  await materializeDelegatedSessionVisionPolicy(
    store,
    { id: 'parent', routeEnabled: false },
    { id: 'child', routeEnabled: false },
    agent => ({ enabled: agent.routeEnabled }),
  )

  assert.equal(store.get('child')?.enabled, true)
})

test('existing child-local policy is never overwritten by delegation', async () => {
  const { store } = memoryStore()
  await store.set('child', userSessionVisionPolicy(false))

  const result = await materializeDelegatedSessionVisionPolicy(
    store,
    { id: 'parent', routeEnabled: true },
    { id: 'child', routeEnabled: true },
    agent => ({ enabled: agent.routeEnabled }),
  )

  assert.equal(result.status, 'existing')
  assert.deepEqual(store.get('child'), {
    revision: 1,
    enabled: false,
    source: 'user',
  })
})

test('delegation is a snapshot and later parent policy changes do not mutate the child', async () => {
  const { store } = memoryStore()
  await store.set('parent', userSessionVisionPolicy(true))

  await materializeDelegatedSessionVisionPolicy(
    store,
    { id: 'parent' },
    { id: 'child' },
    () => ({ enabled: false }),
  )
  await store.set('parent', userSessionVisionPolicy(false))

  assert.equal(store.get('child')?.enabled, true)
})

test('delegation rejects self-parenting instead of creating ambiguous lineage', async () => {
  const { store } = memoryStore()
  await assert.rejects(
    () => materializeDelegatedSessionVisionPolicy(
      store,
      { id: 'same' },
      { id: 'same' },
      () => ({ enabled: true }),
    ),
    /distinct parent and child ids/,
  )
})
