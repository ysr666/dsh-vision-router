import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createSessionImageProjectionModeStore,
  imageProjectionModeDomainSpec,
  requiresVerifiedImageProjection,
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
function session(id, events = [], { firstLiveSeq = 0, isSeeded = false, inheritedEventCount = 0 } = {}) {
  return {
    id, seq: events.length, eventAt: i => events[i],
    firstLiveSeq, header: { isSeeded }, inheritedEventCount,
    requestHeader() { return events.some(x => x.type === 'request/header') ? {} : undefined },
    snapshotEvents() { return events },
  }
}

test('stage 2: brand-new Session commits stable format before request, and restores it after cold restart', async () => {
  const h = fixture()
  assert.equal(h.store.hasStorageFacility(), true)
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
  const imported = session('forked', [{ type: 'assistant/message' }], { firstLiveSeq: 1, isSeeded: true, inheritedEventCount: 1 })
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
  assert.equal(plain.hasStorageFacility(), false, 'optional domain is absent on legacy-only Hosts')
  const missingHistory = fixture()
  assert.equal(await missingHistory.store.resolve({ id: 'uninspectable' }, true), 'legacy')
  await missingHistory.ctx.cleanup()
  const corrupted = fixture([['broken', { revision: 100, mode: 'stable' }]])
  assert.equal(await corrupted.store.resolve(session('broken'), true), 'unknown')
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

test('stage 2: first-turn lifecycle recognizes uncommitted or just-admitted user input, not old model history', async () => {
  const h = fixture()
  const first = session('first-prestep', [{ type: 'session/start' }])
  assert.equal(await h.store.resolve(first, true), 'stable', 'DSH pre-step precedes request/header')
  const alreadyClaimed = session('first-admitted', [
    { type: 'user/message', data: { id: 'first-inbox', role: 'user' } },
  ])
  assert.equal(await h.store.resolve(alreadyClaimed, true), 'stable',
    'a user message on a demonstrably fresh Session is not proof of an earlier request')
  const snapshotFork = session('fork-only-user', [
    { type: 'user/message' }, { type: 'session/end-seed', data: { inherited: true } },
  ], { isSeeded: true, firstLiveSeq: 2, inheritedEventCount: 1 })
  assert.equal(await h.store.resolve(snapshotFork, true), 'legacy',
    'a fork of a user-only source Session is never a new unseeded conversation')
  const resumedNoHeader = session('restored-user-only', [
    { type: 'user/message' },
  ], { firstLiveSeq: 1 })
  assert.equal(await h.store.resolve(resumedNoHeader, true), 'legacy')
  await h.ctx.cleanup()
})

test('stage 2: immutable per-Session mode beats later global opt-in and opt-out settings', async () => {
  const h = fixture()
  const legacy = session('immutable-legacy')
  assert.equal(await h.store.resolve(legacy, false), 'legacy')
  assert.equal(await h.store.resolve(legacy, true), 'legacy')
  const stable = session('immutable-stable')
  assert.equal(await h.store.resolve(stable, true), 'stable')
  assert.equal(await h.store.resolve(stable, false), 'stable')
  await h.ctx.cleanup()
  const restart = fixture(h.rows)
  assert.equal(await restart.store.resolve(session('immutable-legacy', [{ type: 'request/header' }]), true), 'legacy')
  assert.equal(await restart.store.resolve(session('immutable-stable', [{ type: 'request/header' }]), false), 'stable')
  await restart.ctx.cleanup()
})

test('stage 2: missing storage after a prior request is UNKNOWN, never guessed legacy', async () => {
  const store = createSessionImageProjectionModeStore({
    get() { return undefined },
    effect(setup) { this.cleanup = setup() },
  })
  assert.equal(await store.resolve(session('brand-new'), true), 'legacy',
    'a fresh Session may safely choose legacy if stable storage is not available')
  const old = session('recovered-stable-unknown', [
    { type: 'user/message' }, { type: 'request/header' },
    { type: 'assistant/message' },
  ], { firstLiveSeq: 3 })
  assert.equal(await store.resolve(old, false), 'unknown',
    'restarted image Sessions must not silently switch from prior stable to legacy')
})

test('stage 2: failed open retries on next step, can recover the same stable mode without switching format', async () => {
  let attempts = 0
  const row = { revision: 1, mode: 'stable' }
  const ctx = {
    get() { return { async open() {
      attempts++
      if (attempts === 1) throw new Error('transient storage offline')
      return {
        table() { return { get() { return row }, async put() { throw new Error('no write expected') } } },
        async close() {},
      }
    } } },
    effect(setup) { this.cleanup = setup() },
    logger: { warn() {} },
  }
  const store = createSessionImageProjectionModeStore(ctx)
  const existing = session('restored', [{ type: 'request/header' }], { firstLiveSeq: 1 })
  assert.equal(await store.resolve(existing), 'unknown')
  assert.equal(await store.resolve(existing), 'stable')
  assert.equal(attempts, 2)
  await ctx.cleanup()
})

test('stage 2: unknown format blocks every image-bearing Session surface but allows pure text', () => {
  const blocksHaveImage = blocks => blocks.some(block =>
    block?.type === 'image' ||
    (Array.isArray(block?.content) && blocksHaveImage(block.content)))
  const text = { id: 'plain', content: [{ type: 'text', text: 'no image' }] }
  const picture = { id: 'picture', content: [{ type: 'text', text: 'view' },
    { type: 'image', attachment: { attachmentId: 'sha256:private-test' } }] }
  const safe = { snapshotEvents() { return [
    { type: 'user/message', data: text },
    { type: 'assistant/message', data: { message: text } },
  ] } }
  assert.equal(requiresVerifiedImageProjection(safe, [text], blocksHaveImage), false)
  assert.equal(requiresVerifiedImageProjection(safe, [picture], blocksHaveImage), true,
    'a newly claimed image must not be projected without a known durable format')
  for (const type of ['user/message', 'tool/result', 'assistant/message',
    'system/message', 'developer/message']) {
    const event = { type, data: type === 'user/message'
      ? picture : { message: picture } }
    const session = { snapshotEvents() { return [event] } }
    assert.equal(requiresVerifiedImageProjection(session, [text], blocksHaveImage), true,
      type + ' can retain historical image content')
  }
  const nested = { id: 'nested', content: [{ type: 'tool-result',
    content: [{ type: 'image', attachment: { attachmentId: 'sha256:nested' } }] }] }
  assert.equal(requiresVerifiedImageProjection({
    snapshotEvents() { return [{ type: 'tool/result', data: { message: nested } }] },
  }, [text], blocksHaveImage), true)
  assert.equal(requiresVerifiedImageProjection({
    snapshotEvents() { return [{ type: 'user/message', data: {
      id: 'vision-router-image-evidence-v1-existing', content: [{ type: 'text', text: 'OCR update' }],
    } }] },
  }, [text], blocksHaveImage), true, 'append-only OCR updates witness previous image history')
  assert.equal(requiresVerifiedImageProjection({}, [text], blocksHaveImage), true,
    'unreadable history must not be mistaken for an empty image history')
  assert.equal(requiresVerifiedImageProjection({
    snapshotEvents() { throw new Error('session log offline') },
  }, [text], blocksHaveImage), true)
})
