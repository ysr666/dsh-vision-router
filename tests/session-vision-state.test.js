import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionVisionStateStore } from '../lib/session-vision-state.js'

test('stable session id survives Session object replacement without cross-session leakage', () => {
  const store = createSessionVisionStateStore({ maxSessions: 8 })
  const firstObject = { id: 'session-a' }
  store.recordAttachments(firstObject, [{ attachmentId: 'img-a', name: 'a.png' }])
  const memory = store.memoryForSession(firstObject)
  memory.set('img-a', 'a private description')

  const resumedObject = { id: 'session-a' }
  assert.equal(store.memoryForSession(resumedObject).get('img-a'), 'a private description')
  assert.equal(store.lookupAttachment(resumedObject, 'img-a').name, 'a.png')

  const other = { id: 'session-b' }
  assert.equal(store.memoryForSession(other).get('img-a'), undefined)
  assert.equal(store.lookupAttachment(other, 'img-a'), undefined)
})

test('global compatibility facade resolves only an unambiguous stable attachment owner', () => {
  const store = createSessionVisionStateStore({ maxSessions: 8 })
  const a = { id: 'a' }
  const b = { id: 'b' }
  store.recordAttachments(a, [{ attachmentId: 'shared' }, { attachmentId: 'only-a' }])
  store.memoryForSession(a).set('shared', 'from a')
  store.memoryForSession(a).set('only-a', 'private a')

  assert.equal(store.descriptionFacade.get('only-a'), 'private a')
  store.descriptionFacade.set('only-a', 'updated through facade')
  assert.equal(store.memoryForSession(a).get('only-a'), 'updated through facade')

  store.recordAttachments(b, [{ attachmentId: 'shared' }])
  store.memoryForSession(b).set('shared', 'from b')
  assert.equal(store.descriptionFacade.get('shared'), undefined)
  store.descriptionFacade.set('shared', 'must not leak')
  assert.equal(store.memoryForSession(a).get('shared'), 'from a')
  assert.equal(store.memoryForSession(b).get('shared'), 'from b')
})

test('description memory is bounded by entry count and text weight', () => {
  const store = createSessionVisionStateStore({
    descriptionMaxEntries: 3,
    descriptionMaxChars: 12,
  })
  const session = { id: 'bounded' }
  const memory = store.memoryForSession(session)
  memory.set('1', 'aaaa')
  memory.set('2', 'bbbb')
  memory.set('3', 'cccc')
  assert.equal(memory.size, 3)

  memory.get('1') // refresh 1; 2 becomes oldest
  memory.set('4', 'dddd')
  assert.equal(memory.has('2'), false)
  assert.equal(memory.has('1'), true)
  assert.equal(memory.size, 3)
  assert.ok(store.stateStats(session).descriptionChars <= 12)

  memory.set('oversized', 'x'.repeat(100))
  assert.equal(memory.has('oversized'), false)
  assert.ok(store.stateStats(session).descriptionChars <= 12)
})

test('attachment refs and stable sessions are bounded while event scan cursor survives resume', () => {
  const store = createSessionVisionStateStore({
    maxSessions: 3,
    attachmentMaxEntries: 2,
  })
  const active = { id: 'active' }
  store.recordAttachments(active, [
    { attachmentId: 'one' },
    { attachmentId: 'two' },
    { attachmentId: 'three' },
  ])
  assert.equal(store.lookupAttachment(active, 'one'), undefined)
  assert.equal(store.lookupAttachment(active, 'two').attachmentId, 'two')
  store.setScannedEventSeq(active, 41)
  assert.equal(store.getScannedEventSeq({ id: 'active' }), 41)

  for (let i = 0; i < 10; i++) {
    const session = { id: `short-${i}` }
    store.recordAttachments(session, [{ attachmentId: `img-${i}` }])
  }
  assert.ok(store.stats().stableSessions <= 3)
})

test('ten thousand short-lived stable sessions remain bounded', () => {
  const store = createSessionVisionStateStore({
    maxSessions: 8,
    descriptionMaxEntries: 8,
    attachmentMaxEntries: 8,
  })
  for (let i = 0; i < 10_000; i++) {
    const session = { id: `s-${i}` }
    const id = `img-${i}`
    store.recordAttachments(session, [{ attachmentId: id }])
    store.memoryForSession(session).set(id, `description ${i}`)
  }
  const stats = store.stats()
  assert.ok(stats.stableSessions <= 8)
  assert.ok(stats.descriptions <= 64)
  assert.ok(stats.attachments <= 64)
})

test('idle stable sessions expire, while id-less sessions are weakly owned only', () => {
  let clock = 1_000
  const store = createSessionVisionStateStore({
    maxSessions: 8,
    idleTtlMs: 100,
    now: () => clock,
  })
  const stable = { id: 'ttl' }
  store.recordAttachments(stable, [{ attachmentId: 'ttl-image' }])
  store.memoryForSession(stable).set('ttl-image', 'temporary')
  assert.equal(store.stats().stableSessions, 1)
  clock += 101
  assert.equal(store.stats().stableSessions, 0)

  const anonymous = {}
  const anonymousMemory = store.memoryForSession(anonymous)
  anonymousMemory.set('local', 'weak state')
  assert.equal(anonymousMemory.get('local'), 'weak state')
  assert.equal(store.stats().stableSessions, 0)
  assert.equal(store.descriptionFacade.get('local'), undefined)
})
