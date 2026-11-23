import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createSessionImageProjectionModeStore,
  imageProjectionModeDomainSpec,
} from '../lib/session-image-projection-mode.js'

function fixture(initial = []) {
  const rows = new Map(initial)
  const stats = { opens: 0, closes: 0, puts: 0 }
  const facility = { async open(spec) {
    assert.equal(spec, imageProjectionModeDomainSpec)
    stats.opens++
    return {
      table(name) {
        assert.equal(name, 'modes')
        return {
          get: key => rows.get(key),
          async put(key, value) { stats.puts++; rows.set(key, structuredClone(value)) },
        }
      },
      async close() { stats.closes++ },
    }
  } }
  const ctx = {
    get(name) { return name === 'storageDomain' ? facility : undefined },
    effect(setup) { this.cleanup = setup() },
  }
  const store = createSessionImageProjectionModeStore(ctx)
  return { ctx, rows, stats, store }
}
function session(id, events = []) {
  return {
    id, seq: events.length, eventAt: i => events[i],
    requestHeader() { return events.some(x => x.type === 'request/header') ? {} : undefined },
    snapshotEvents() { return events },
  }
}

test('stage 2: brand-new Session commits stable format before request, and restores it after cold restart', async () => {
  const h = fixture()
  const events = [{ type: 'session/start' }]
  const s = session('new', events)
  assert.equal(await h.store.resolve(s, true), 'stable')
  assert.deepEqual(h.rows.get('new'), { revision: 1, mode: 'stable' })
  events.push({ type: 'request/header' }, { type: 'assistant/message' })
  s.seq = events.length
  assert.equal(await h.store.resolve(s, true), 'stable', 'a later header must not reverse the persisted decision')
  await h.ctx.cleanup()
  assert.equal(h.stats.closes, 1)
  const restarted = fixture(h.rows)
  assert.equal(await restarted.store.resolve(s, false), 'stable',
    'an explicit later configuration change may not silently switch existing wire bytes')
  assert.equal(restarted.stats.puts, 0, 'restored mode is read, never rewritten')
  await restarted.ctx.cleanup()
})

test('stage 2: preexisting conversation/fork stays legacy forever, even when default-on is enabled', async () => {
  const h = fixture()
  const legacy = session('historical', [
    { type: 'request/header' }, { type: 'user/message' }, { type: 'assistant/message' },
  ])
  assert.equal(await h.store.resolve(legacy, true), 'legacy')
  assert.deepEqual(h.rows.get('historical'), { revision: 1, mode: 'legacy' })
  const imported = session('forked', [{ type: 'assistant/message' }])
  assert.equal(await h.store.resolve(imported, true), 'legacy',
    'an imported history without request/header cannot be classified as new')
  await h.ctx.cleanup()
  const cold = fixture(h.rows)
  assert.equal(await cold.store.resolve(session('historical', []), true), 'legacy')
  assert.equal(await cold.store.resolve(session('forked', []), true), 'legacy')
  await cold.ctx.cleanup()
})

test('stage 2: explicit new-Session opt-out persists, including after Settings turn back on', async () => {
  const h = fixture()
  const s = session('optout')
  assert.equal(await h.store.resolve(s, false), 'legacy')
  assert.equal(await h.store.resolve(s, true), 'legacy')
  assert.deepEqual(h.rows.get('optout'), { revision: 1, mode: 'legacy' })
  await h.ctx.cleanup()
})

test('stage 2: absent storage, uninspectable history, and corrupted stored rows all fail closed', async () => {
  const plain = createSessionImageProjectionModeStore({ get() { return undefined }, effect(setup) { this.cleanup = setup() } })
  assert.equal(await plain.resolve(session('no-storage'), true), 'legacy')
  assert.equal(plain.get('no-storage'), undefined)
  const missingHistory = fixture()
  assert.equal(await missingHistory.store.resolve({ id: 'uninspectable' }, true), 'legacy')
  await missingHistory.ctx.cleanup()
  const corrupted = fixture([['broken', { revision: 100, mode: 'stable' }]])
  assert.equal(await corrupted.store.resolve(session('broken'), true), 'legacy')
  assert.equal(corrupted.stats.puts, 0, 'bad record must not be overwritten with a guessed stable mode')
  await corrupted.ctx.cleanup()
})

test('stage 2: concurrent first turns commit only one durable mode; Sessions cannot influence each other', async () => {
  const h = fixture()
  const s = session('parallel')
  const answers = await Promise.all(Array.from({ length: 12 }, () => h.store.resolve(s, true)))
  assert.deepEqual(answers, Array(12).fill('stable'))
  assert.equal(h.stats.puts, 1)
  assert.equal(await h.store.resolve(session('old', [{ type: 'request/header' }]), true), 'legacy')
  assert.equal(await h.store.resolve(session('new-2'), true), 'stable')
  assert.equal(h.stats.puts, 3)
  h.store.release('parallel')
  assert.equal(h.store.get('parallel'), undefined)
  assert.equal(await h.store.resolve(s, true), 'stable',
    'Agent disposal must rehydrate row rather than infer changed historical mode')
  await h.ctx.cleanup()
})

test('stage 2: storage write failure does not enable volatile stable history', async () => {
  const ctx = {
    get(name) {
      if (name !== 'storageDomain') return undefined
      return { async open() {
        return { table() {
          return { get() { return undefined }, async put() { throw new Error('disk error') } }
        }, async close() {} }
      } }
    },
    effect(setup) { this.cleanup = setup() },
    logger: { warn() {} },
  }
  const store = createSessionImageProjectionModeStore(ctx)
  assert.equal(await store.resolve(session('disk'), true), 'legacy')
  assert.equal(store.get('disk'), undefined)
  await ctx.cleanup()
})
