import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createSessionVisionPolicyStore,
  delegatedSessionVisionPolicy,
  parseSessionVisionPolicy,
  userSessionVisionPolicy,
} from '../lib/session-vision-policy.js'

function memoryTable(seed = []) {
  const rows = new Map(seed)
  return {
    rows,
    get(key) {
      return rows.get(key)
    },
    async put(key, value) {
      rows.set(key, value)
    },
    async delete(key) {
      rows.delete(key)
    },
  }
}

test('Session Vision policy stores intent without provider/model coupling', async () => {
  const table = memoryTable()
  const store = createSessionVisionPolicyStore(table)

  const saved = await store.set('session-parent', userSessionVisionPolicy(true))
  assert.deepEqual(saved, {
    revision: 1,
    enabled: true,
    source: 'user',
  })
  assert.equal(Object.hasOwn(saved, 'provider'), false)
  assert.equal(Object.hasOwn(saved, 'model'), false)
  assert.deepEqual(store.get('session-parent'), saved)
})

test('delegated Session Vision policy snapshots parent authority identity', async () => {
  const table = memoryTable()
  const store = createSessionVisionPolicyStore(table)

  await store.set(
    'session-child',
    delegatedSessionVisionPolicy(true, 'session-parent'),
  )

  assert.deepEqual(store.get('session-child'), {
    revision: 1,
    enabled: true,
    source: 'delegation',
    inheritedFrom: 'session-parent',
  })

  // A later child-local user decision replaces delegation truth rather than
  // mutating or consulting the parent again.
  await store.set('session-child', userSessionVisionPolicy(false))
  assert.deepEqual(store.get('session-child'), {
    revision: 1,
    enabled: false,
    source: 'user',
  })
})

test('malformed or future Session Vision policy rows fail closed as absent', () => {
  for (const value of [
    null,
    {},
    { revision: 2, enabled: true, source: 'user' },
    { revision: 1, enabled: 'yes', source: 'user' },
    { revision: 1, enabled: true, source: 'delegation' },
    { revision: 1, enabled: true, source: 'user', inheritedFrom: 'parent' },
  ]) {
    assert.equal(parseSessionVisionPolicy(value), undefined)
  }
})

test('Session Vision policy store rejects invalid ids and invalid writes', async () => {
  const table = memoryTable()
  const store = createSessionVisionPolicyStore(table)

  assert.throws(() => store.get('   '), /non-empty session id/)
  await assert.rejects(
    () => store.set('child', { revision: 1, enabled: true, source: 'delegation' }),
    /invalid session vision policy/,
  )
})

test('Session Vision policy delete removes only the requested Session', async () => {
  const table = memoryTable([
    ['a', userSessionVisionPolicy(true)],
    ['b', userSessionVisionPolicy(false)],
  ])
  const store = createSessionVisionPolicyStore(table)

  await store.delete('a')
  assert.equal(store.get('a'), undefined)
  assert.deepEqual(store.get('b'), userSessionVisionPolicy(false))
})
