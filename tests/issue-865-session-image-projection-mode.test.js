import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyImageProjectionAdmission } from '../lib/session-image-projection-admission.js'
import {
  createSessionImageProjectionModeStore,
  imageProjectionModeDomainSpec,
  requiresVerifiedImageProjection,
  createStableProjectionWitness,
  isCommittedStableProjectionWitness,
  STABLE_IMAGE_PROJECTION_WITNESS_V1,
  STABLE_IMAGE_PROJECTION_WITNESS_V2,
  committedStableProjectionWitnessMode,
  inspectCommittedProjectionWitnesses,
  preserveClaimedMessagesOnBlockedStep,
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
  const hooks = new Map()
  const ctx = {
    get(name) { return name === 'storageDomain' ? facility : undefined },
    effect(setup) { this.cleanup = setup() },
    on(event, listener) { hooks.set(event, listener) },
  }
  const store = createSessionImageProjectionModeStore(ctx)
  return { ctx, rows, stats, store, hooks }
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
  assert.equal(await plain.resolve(session('no-storage'), true), 'stable')
  assert.equal(plain.get('no-storage'), 'stable')
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

test('stage 2: a fresh Session safely uses durable in-Session witness even if optional sidecar write fails', async () => {
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
  const fresh = session('disk')
  assert.equal(await store.resolve(fresh, true), 'stable')
  assert.equal(store.get('disk'), 'stable')
  assert.ok(store.witnessFor(fresh, { kind: 'plugin:dsh-vision-router' }),
    'successful Host step admission will durably record the witness despite failed sidecar')
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
  assert.equal(await store.resolve(session('brand-new'), true), 'stable',
    'a genuinely fresh opted-in Session can persist format in the DSH event log itself')
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

test('stage 2: committed stable witness is the authoritative source even after sidecar deletion', async () => {
  const ownedSource = { kind: 'plugin:dsh-vision-router' }
  const h = fixture()
  const events = [{ type: 'turn/start' }]
  const s = session('witness-original', events)
  assert.equal(await h.store.resolve(s, true), 'stable')
  const witness = h.store.witnessFor(s, ownedSource)
  assert.ok(witness)
  assert.equal(witness.content[0].text, STABLE_IMAGE_PROJECTION_WITNESS_V1)
  assert.equal(isCommittedStableProjectionWitness(witness), true)
  assert.deepEqual(h.store.witnessFor(s, ownedSource), witness,
    'a planned but not committed witness is still retryable with exactly the same ID')
  const event = { type: 'user/message', data: witness }
  events.push(event)
  s.seq = events.length
  h.store.onSessionEvent(s, event)
  assert.equal(h.store.witnessFor(s, ownedSource), undefined,
    'once the official Host commits the user message, do not repeat it')
  await h.ctx.cleanup()

  // A cold restore must not depend on any surviving sidecar data.
  const absentSidecar = fixture([])
  const resumed = session('witness-original', [
    ...events, { type: 'request/header' }, { type: 'assistant/message' },
  ], { firstLiveSeq: events.length + 2 })
  assert.equal(await absentSidecar.store.resolve(resumed, false), 'stable',
    'authoritative history witness recovers the exact stable projection after sidecar deletion')
  assert.equal(absentSidecar.stats.puts, 0, 'restored witness does not need to recreate sidecar')
  assert.equal(absentSidecar.store.witnessFor(resumed, ownedSource), undefined)
  await absentSidecar.ctx.cleanup()
})

test('stage 2: fork inherits stable format witness even with new Session ID and no sidecar', async () => {
  const source = { kind: 'plugin:dsh-vision-router' }
  const original = createStableProjectionWitness('parent-of-fork', source)
  const inheritedEvents = [{ type: 'user/message', data: original },
    { type: 'session/end-seed', data: { inherited: true } }]
  const h = fixture()
  const child = session('child-of-fork', inheritedEvents, {
    firstLiveSeq: inheritedEvents.length, inheritedEventCount: 1, isSeeded: true,
  })
  assert.equal(await h.store.resolve(child, true), 'stable')
  assert.equal(h.store.witnessFor(child, source), undefined,
    'a child with an inherited v1 witness must not append a new one')
  assert.equal(h.stats.puts, 0)
  await h.ctx.cleanup()
})

test('stage 2: a fake user message cannot spoof a trusted stable format witness', () => {
  const source = { kind: 'plugin:dsh-vision-router' }
  const witness = createStableProjectionWitness('private', source)
  assert.equal(isCommittedStableProjectionWitness(witness), true)
  assert.equal(isCommittedStableProjectionWitness({ ...witness, source: { kind: 'user' } }), false)
  assert.equal(isCommittedStableProjectionWitness({ ...witness, id: 'fake' }), false)
  assert.equal(isCommittedStableProjectionWitness({ ...witness,
    content: [{ type: 'text', text: 'different text' }] }), false)
  assert.throws(() => createStableProjectionWitness('private', { kind: 'user' }),
    /DVR-owned source/)
})

test('stage 2: missing optional storage still recovers a committed witness', async () => {
  const original = createStableProjectionWitness('previously-stable', { kind: 'plugin:dsh-vision-router' })
  const events = [{ type: 'user/message', data: original }, { type: 'request/header' }]
  const ctx = { get() { return undefined }, effect(setup) { this.cleanup = setup() } }
  const h = createSessionImageProjectionModeStore(ctx)
  assert.equal(h.hasStorageFacility(), false)
  assert.equal(await h.resolve(session('previously-stable', events, { firstLiveSeq: 2 }), false), 'stable')
  assert.equal(h.get('previously-stable'), 'stable')
  await ctx.cleanup()
})

test('stage 2: no Storage Domain is required for explicit first-request stable opt-in', async () => {
  const ctx = { get() { return undefined }, effect(setup) { this.cleanup = setup() } }
  const store = createSessionImageProjectionModeStore(ctx)
  const fresh = session('no-sidecar-opt-in')
  assert.equal(await store.resolve(fresh, true), 'stable')
  const witness = store.witnessFor(fresh, { kind: 'plugin:dsh-vision-router' })
  assert.ok(witness)
  const event = { type: 'user/message', data: witness }
  store.onSessionEvent(fresh, event)
  await ctx.cleanup()
  const restored = createSessionImageProjectionModeStore(ctx)
  assert.equal(await restored.resolve(session('no-sidecar-opt-in', [
    event, { type: 'request/header' },
  ], { firstLiveSeq: 2 }), false), 'stable',
  'the witness, not optional sidecar persistence, determines format after cold restore')
  await ctx.cleanup()
})

test('stage 2: blocked first step durably requeues exact claimed input in original order', () => {
  const first = { role: 'user', id: 'claimed-user-image', content: [{ type: 'image' }] }
  const second = { role: 'user', id: 'claimed-user-followup', content: [{ type: 'text', text: 'followup' }] }
  const later = { role: 'user', id: 'already-queued', content: [{ type: 'text', text: 'later' }] }
  const pending = [later]
  const calls = []
  const agent = { inbox: {
    splice(target, index, count, inserted) {
      calls.push({ target, index, count, inserted })
      pending.splice(index, count, ...inserted)
      // Actual Host emits agent/inbox/spliced for this operation; this fixture
      // verifies we call the public atomic mutation seam, never raw Session.append.
    },
  } }
  const claimed = [first, second]
  assert.equal(preserveClaimedMessagesOnBlockedStep(agent, claimed), 2)
  assert.deepEqual(pending, [first, second, later],
    "the blocked user\'s original messages must remain pending before later inputs")
  assert.deepEqual(calls, [{
    target: 'next-turn', index: 0, count: 0, inserted: claimed,
  }], 'one atomic official Inbox.splice, not duplicate best-effort insertions')
  assert.equal(pending[0], first, 'do not clone or rewrite the original image attachment')
  assert.equal(preserveClaimedMessagesOnBlockedStep(agent, []), 0)
  assert.equal(calls.length, 1, 'an empty tool continuation cannot requeue synthetic input')
  assert.throws(() => preserveClaimedMessagesOnBlockedStep({}, [first]),
    /Agent\.inbox\.splice is unavailable/, 'never claim successful requeue if the Host lacks the interface')
})

test('stage 2: v2 first request is witnessed in DSH history and survives deleted sidecar and fork', async () => {
  const h = fixture()
  const owner = { kind: 'plugin:dsh-vision-router' }
  const original = session('canonical-v2-first')
  assert.equal(await h.store.resolve(original, 'stable-v2'), 'stable-v2')
  assert.equal(h.rows.has('canonical-v2-first'), false, 'v2 must not write an unsupported value into the v1 sidecar')
  const witness = h.store.witnessFor(original, owner)
  assert.ok(witness)
  assert.equal(witness.content[0].text, STABLE_IMAGE_PROJECTION_WITNESS_V2)
  assert.equal(committedStableProjectionWitnessMode(witness), 'stable-v2')
  assert.equal(h.store.witnessFor(original, owner).id, witness.id,
    'a failed request must retry the same deterministic v2 witness')
  await h.ctx.cleanup()

  const persistedEvents = [{ type: 'user/message', data: witness }, { type: 'request/header' }]
  const cold = fixture([])
  const resumed = session('canonical-v2-first', persistedEvents, { firstLiveSeq: 2 })
  assert.equal(await cold.store.resolve(resumed, false), 'stable-v2')
  assert.equal(cold.store.witnessFor(resumed, owner), undefined)
  const child = session('canonical-v2-fork', persistedEvents, {
    firstLiveSeq: 2, inheritedEventCount: 1, isSeeded: true,
  })
  assert.equal(await cold.store.resolve(child, true), 'stable-v2',
    'v2 fork inheritance is based on the Session witness, not mutable settings or child ID')
  assert.equal(cold.stats.puts, 0)
  await cold.ctx.cleanup()
})

test('stage 2: a committed v1 witness always stays v1, even when new Sessions prefer v2', async () => {
  const h = fixture()
  const v1 = createStableProjectionWitness('older-v1', { kind: 'plugin:dsh-vision-router' })
  const restored = session('older-v1', [{ type: 'user/message', data: v1 },
    { type: 'request/header' }], { firstLiveSeq: 2 })
  assert.equal(await h.store.resolve(restored, 'stable-v2'), 'stable')
  assert.equal(h.store.witnessFor(restored, { kind: 'plugin:dsh-vision-router' }), undefined)
  await h.ctx.cleanup()
})

test('stage 2: conflicting witnessed versions fail closed, a v2 witness beats stale v1 sidecar', async () => {
  const owner = { kind: 'plugin:dsh-vision-router' }
  const v1 = createStableProjectionWitness('same-visual-conversation', owner)
  const v2 = createStableProjectionWitness('same-visual-conversation', owner, 'stable-v2')
  assert.equal(isCommittedStableProjectionWitness(v2), true)
  assert.equal(committedStableProjectionWitnessMode(v2), 'stable-v2')
  const h = fixture([['same-visual-conversation', { revision: 1, mode: 'legacy' }]])
  const rescued = session('same-visual-conversation', [
    { type: 'user/message', data: v2 }, { type: 'request/header' },
  ], { firstLiveSeq: 2 })
  assert.equal(await h.store.resolve(rescued, false), 'stable-v2',
    'the official Session log is authoritative when an old sidecar row disagrees')
  assert.deepEqual(h.rows.get('same-visual-conversation'), { revision: 1, mode: 'legacy' })
  const conflicted = session('same-visual-conversation-conflict', [
    { type: 'user/message', data: v1 }, { type: 'user/message', data: v2 },
    { type: 'request/header' },
  ], { firstLiveSeq: 3 })
  assert.equal(await h.store.resolve(conflicted, 'stable-v2'), 'unknown',
    'two incompatible committed format witnesses may not silently pick one')
  assert.equal(h.store.get('same-visual-conversation-conflict'), undefined,
    'a contradictory Session log must not leave a stale in-process format choice')
  assert.equal(committedStableProjectionWitnessMode({ ...v2,
    content: [{ type: 'text', text: STABLE_IMAGE_PROJECTION_WITNESS_V1 }] }), undefined,
    'no witness ID/body cross-version confusion')
  await h.ctx.cleanup()
})

test('stage 2: live conflicting witness clears a formerly stable format cache', async () => {
  const h = fixture()
  const source = { kind: 'plugin:dsh-vision-router' }
  const live = session('live-conflict')
  assert.equal(await h.store.resolve(live, 'stable-v2'), 'stable-v2')
  const v2 = createStableProjectionWitness('live-conflict', source, 'stable-v2')
  h.store.onSessionEvent(live, { type: 'user/message', data: v2 })
  assert.equal(h.store.get('live-conflict'), 'stable-v2')
  const v1 = createStableProjectionWitness('live-conflict', source)
  h.store.onSessionEvent(live, { type: 'user/message', data: v1 })
  assert.equal(h.store.get('live-conflict'), undefined,
    'conflict must revoke even the previously cached v2 mode')
  assert.equal(h.store.witnessFor(live, source), undefined)
  await h.ctx.cleanup()
})

test('stage 2: 530 simultaneously live Sessions retain pinned format until Agent disposal', async () => {
  const h = fixture()
  for (let i = 0; i < 530; i++) {
    assert.equal(await h.store.resolve(session('many-' + i), true), 'stable')
  }
  assert.equal(h.store.get('many-0'), 'stable',
    'an in-flight Adapter may read this first Session after 529 unrelated pre-steps')
  assert.equal(h.store.get('many-529'), 'stable')
  h.hooks.get('agent/disposed')?.({ agent: { id: 'many-0', session: { id: 'many-0' } } })
  assert.equal(h.store.get('many-0'), undefined,
    'the Agent lifetime, not an unrelated LRU operation, ends the format binding')
  assert.equal(await h.store.resolve(session('many-0', [
    { type: 'request/header' },
  ], { firstLiveSeq: 1 }), false), 'stable',
  'the retired and later restored Session reads the original durable v1 row')
  await h.ctx.cleanup()
})

test('stage 2: retired Agent invalidates process-local Session choice', async () => {
  const h = fixture()
  assert.equal(await h.store.resolve(session('retiring'), 'stable-v2'), 'stable-v2')
  assert.equal(h.store.get('retiring'), 'stable-v2')
  h.hooks.get('agent/disposed')?.({ agent: { id: 'retiring', session: { id: 'retiring' } } })
  assert.equal(h.store.get('retiring'), undefined,
    'a later Agent owner must rederive the image format from its Session history')
  await h.ctx.cleanup()
})

test('stage 2: failed command-level durability fences v2 mode through Agent disposal until successful flush', async () => {
  const h = fixture()
  const source = { kind: 'plugin:dsh-vision-router' }
  const events = [{ type: 'request/header' }]
  const witness = createStableProjectionWitness('durability-fenced', source, 'stable-v2')
  events.push({ type: 'user/message', data: witness })
  const s = session('durability-fenced', events, { firstLiveSeq: 2 })
  assert.equal(await h.store.resolve(s, false), 'stable-v2')
  assert.equal(h.store.get(s.id), 'stable-v2')
  h.store.markUnverifiedDurability(s.id)
  assert.equal(h.store.isDurabilityUnverified(s.id), true)
  assert.equal(h.store.get(s.id), undefined,
    'auxiliary dispatch cannot accidentally use the pending-unflushed v2 mode')
  assert.equal(await h.store.resolve(s, false), 'unknown',
    'the authoritative witness is not sufficient without command-level disk acknowledgement')
  h.store.release(s.id)
  assert.equal(h.store.isDurabilityUnverified(s.id), true,
    'disposing an Agent cannot erase the disk-failure fence')
  h.store.markVerifiedDurability(s.id)
  assert.equal(h.store.isDurabilityUnverified(s.id), false)
  assert.equal(await h.store.resolve(s, false), 'stable-v2')
  await h.ctx.cleanup()
})


test('adversarial #865: trusted malformed witness is UNKNOWN, never rescued by an old sidecar', async () => {
  const source = { kind: 'plugin:dsh-vision-router' }
  const original = createStableProjectionWitness('bad-witness', source, 'stable-v2')
  const malformed = { ...original, content: [{ type: 'text', text: 'tampered' }] }
  const events = [{ type: 'user/message', data: malformed }, { type: 'request/header' }]
  assert.equal(inspectCommittedProjectionWitnesses(events), 'unknown')
  assert.equal(inspectCommittedProjectionWitnesses([{
    type: 'user/message', data: { ...malformed, source: { kind: 'user' } },
  }]), undefined, 'foreign user prose never becomes a DVR-owned mode witness')
  const h = fixture([['bad-witness', { revision: 1, mode: 'legacy' }]])
  const restored = session('bad-witness', events, { firstLiveSeq: 2 })
  assert.equal(await h.store.resolve(restored, false), 'unknown',
    'malformed trusted proof cannot fall back to a plausible stale sidecar row')
  assert.equal(h.store.hasCommittedWitness(restored), true)
  assert.equal(h.store.get(restored.id), undefined)
  await h.ctx.cleanup()
})

test('adversarial #865: live malformed witness poisons previous valid mode and cannot be repaired by another valid marker', async () => {
  const source = { kind: 'plugin:dsh-vision-router' }
  const h = fixture()
  const events = []
  const live = session('live-malformed', events)
  assert.equal(await h.store.resolve(live, 'stable-v2'), 'stable-v2')
  const original = createStableProjectionWitness(live.id, source, 'stable-v2')
  const validEvent = { type: 'user/message', data: original }
  events.push(validEvent)
  h.store.onSessionEvent(live, validEvent)
  assert.equal(h.store.get(live.id), 'stable-v2')
  const malformed = { type: 'user/message', data: {
    ...original, content: [{ type: 'text', text: 'altered in storage' }],
  } }
  events.push(malformed)
  h.store.onSessionEvent(live, malformed)
  assert.equal(h.store.get(live.id), undefined)
  assert.equal(await h.store.resolve(live, 'stable-v2'), 'unknown')
  h.store.onSessionEvent(live, validEvent)
  assert.equal(await h.store.resolve(live, 'stable-v2'), 'unknown',
    'subsequent valid marker cannot override an already committed contradiction')
  await h.ctx.cleanup()
})


test('adversarial #865: v2 admission refuses an unidentified image and restores the claimed Inbox entry', async () => {
  const image = { role: 'user', content: [{ type: 'image', attachment: { name: 'no-id.png' } }] }
  const claimed = [image]
  const restored = []
  const payload = {
    messages: claimed, agent: { inbox: { splice(target, index, count, messages) {
      assert.equal(target, 'next-turn')
      assert.equal(index, 0)
      assert.equal(count, 0)
      restored.push(...messages)
    } } },
  }
  const modeStore = {
    isDurabilityUnverified() { return false },
    hasStorageFacility() { return false },
    hasCommittedWitness() { return true },
    get() { return 'stable-v2' },
    async resolve() { return 'stable-v2' },
  }
  await assert.rejects(() => verifyImageProjectionAdmission({
    session: { id: 'v2-pinned' }, payload, decision: { messages: claimed },
    modeStore, settings: { stableImageHistoryNewSessions: false },
    hasRetainedImage: blocks => blocks.some(b => b.type === 'image'),
  }), /cannot prove an image identity/)
  assert.deepEqual(restored, claimed, 'the exact human input, not a rewritten history, must be retained')
})

test('adversarial #865: new Session with unprovable image identity never acquires v2 witness', async () => {
  const image = { role: 'user', content: [{
    type: 'image', attachment: { name: 'no-id.png' },
  }] }
  const requests = []
  const store = {
    async resolve(session, requested) { requests.push(requested); return 'legacy' },
  }
  await verifyImageProjectionAdmission({
    session: { id: 'first-prompt' }, payload: { messages: [image] },
    decision: { messages: [image] }, modeStore: store,
    settings: { stableImageHistoryNewSessions: true },
    hasRetainedImage: blocks => blocks.some(b => b.type === 'image'),
  })
  assert.deepEqual(requests, [false],
    'the opt-in v2 format cannot be selected based on mutable request position')
})
