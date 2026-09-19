import assert from 'node:assert/strict'
import test from 'node:test'

import { getOfficialDeepSeekCatalog } from '../lib/official-deepseek-catalog.js'

test('official DeepSeek catalog coalesces concurrent refreshes and serves a fresh snapshot', async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const adapter = {
    async listModels(provider) {
      calls += 1
      await gate
      return [{ provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }]
    },
  }
  let now = 1_000
  const a = getOfficialDeepSeekCatalog(adapter, { now: () => now, freshMs: 100 })
  const b = getOfficialDeepSeekCatalog(adapter, { now: () => now, freshMs: 100 })
  release()
  const [first, second] = await Promise.all([a, b])
  assert.equal(calls, 1)
  assert.equal(first, second)

  now = 1_050
  const cached = await getOfficialDeepSeekCatalog(adapter, { now: () => now, freshMs: 100 })
  assert.equal(cached, first)
  assert.equal(calls, 1)
})

test('official DeepSeek catalog serves bounded stale evidence on refresh failure', async () => {
  let calls = 0
  let failing = false
  const adapter = {
    async listModels(provider) {
      calls += 1
      if (failing) throw new Error('503')
      return [{ provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }]
    },
  }
  let now = 10_000
  const first = await getOfficialDeepSeekCatalog(adapter, {
    now: () => now,
    freshMs: 10,
    staleIfErrorMs: 100,
  })
  failing = true
  now = 10_050
  const stale = await getOfficialDeepSeekCatalog(adapter, {
    now: () => now,
    freshMs: 10,
    staleIfErrorMs: 100,
  })
  assert.equal(stale, first)
  assert.equal(calls, 2)
})

test('official DeepSeek catalog fails closed on cold start and after stale evidence expires', async () => {
  const cold = {
    async listModels() {
      throw new Error('503')
    },
  }
  await assert.rejects(
    getOfficialDeepSeekCatalog(cold, { now: () => 1 }),
    (error) => error?.code === 'OFFICIAL_CATALOG_UNAVAILABLE',
  )

  let failing = false
  const adapter = {
    async listModels(provider) {
      if (failing) throw new Error('503')
      return [{ provider, id: 'deepseek-v4-pro' }]
    },
  }
  let now = 100
  await getOfficialDeepSeekCatalog(adapter, {
    now: () => now,
    freshMs: 5,
    staleIfErrorMs: 20,
  })
  failing = true
  now = 150
  await assert.rejects(
    getOfficialDeepSeekCatalog(adapter, {
      now: () => now,
      freshMs: 5,
      staleIfErrorMs: 20,
    }),
    (error) => error?.code === 'OFFICIAL_CATALOG_UNAVAILABLE',
  )
})

test('official DeepSeek catalog authority is scoped to adapter identity', async () => {
  let callsA = 0
  let callsB = 0
  const adapterA = {
    async listModels(provider) {
      callsA += 1
      return [{ provider, id: 'a' }]
    },
  }
  const adapterB = {
    async listModels(provider) {
      callsB += 1
      return [{ provider, id: 'b' }]
    },
  }
  const now = () => 1_000
  const a = await getOfficialDeepSeekCatalog(adapterA, { now })
  const b = await getOfficialDeepSeekCatalog(adapterB, { now })
  assert.deepEqual(a.map((entry) => entry.id), ['a'])
  assert.deepEqual(b.map((entry) => entry.id), ['b'])
  assert.equal(callsA, 1)
  assert.equal(callsB, 1)
})


test('official DeepSeek catalog briefly backs off repeated cold-outage reads without persisting failure', async () => {
  let calls = 0
  const adapter = {
    async listModels() {
      calls += 1
      throw new Error('503')
    },
  }
  let now = 1_000
  const options = {
    now: () => now,
    failureBackoffMs: 100,
  }
  await assert.rejects(
    getOfficialDeepSeekCatalog(adapter, options),
    (error) => error?.code === 'OFFICIAL_CATALOG_UNAVAILABLE',
  )
  await assert.rejects(
    getOfficialDeepSeekCatalog(adapter, options),
    (error) => error?.code === 'OFFICIAL_CATALOG_UNAVAILABLE',
  )
  assert.equal(calls, 1)

  now = 1_101
  await assert.rejects(
    getOfficialDeepSeekCatalog(adapter, options),
    (error) => error?.code === 'OFFICIAL_CATALOG_UNAVAILABLE',
  )
  assert.equal(calls, 2)
})
