import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createSessionVisionIndex, installSessionVisionIndexBoundary } from '../lib/session-vision-index.js'
import { createSessionVisionStateStore } from '../lib/session-vision-state.js'
import * as core from '../lib/core-primitives.js'

const hostRoot = process.env.DSH_SOURCE_ROOT
const expected = process.env.DSH_EXPECTED_COMMIT
assert.ok(hostRoot, 'DSH_SOURCE_ROOT is required')
assert.match(expected ?? '', /^[0-9a-f]{40}$/, 'DSH_EXPECTED_COMMIT is required')
assert.equal(execFileSync('git', ['-C', hostRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), expected)

const hostImport = (file) => import(pathToFileURL(join(resolve(hostRoot), file)).href)
const [{ Context }, { default: SessionStore, SessionId }, { createUserMessage }] = await Promise.all([
  hostImport('vendor/cordis/src/index.ts'),
  hostImport('packages/core/session/src/index.ts'),
  hostImport('packages/llm/llm/src/index.ts'),
])

const ctx = new Context()
await ctx.plugin(SessionStore)
const stateStore = createSessionVisionStateStore()
let logReads = 0
let eventReads = 0
let overflowSession
const index = createSessionVisionIndex({
  core,
  stateStore,
  readSessionLog: async () => { logReads++; throw new Error('unexpected full-history read') },
  readSessionEvent: async (session, seq) => {
    eventReads++
    if (session !== overflowSession) throw new Error('unexpected exact-event read')
    return { supported: true, event: session.eventAt(seq) }
  },
})
installSessionVisionIndexBoundary(ctx, {}, core, { index })
const seen = new Map()
ctx.on('session/event', (session, event) => {
  const records = seen.get(session) ?? []
  records.push({
    seq: event.seq,
    type: event.type,
    finalSurface: [...session.surface.nodes],
    completeLog: session.seq,
  })
  seen.set(session, records)
})

const newSession = (name) => {
  const session = ctx.sessions.create(SessionId('dvr-rc2-batch-' + name))
  assert.equal(session.header.version, 4, 'RC2 must use reviewed Session V4 attribution')
  return session
}
const message = (text, source = { kind: 'user' }, id) => ({
  ...createUserMessage({ content: [{ type: 'text', text }], source }),
  ...(id ? { id } : {}),
})
const guard = (id) => message(
  '本轮视觉总时间预算已耗尽，请停止本轮视觉调用',
  { kind: 'plugin:dsh-vision-router' },
  'vision-router-structured-guard-stop-' + id,
)
const ref = (symbol) => ({
  attachmentId: 'sha256:' + symbol.repeat(64),
  name: symbol + '.png',
  mediaType: 'image/png',
})
const withImage = (reference) => createUserMessage({
  content: [{ type: 'text', text: 'Describe this image' }, { type: 'image', attachment: reference }],
  source: { kind: 'user' },
})

try {
  // Host publishes every member only AFTER the complete final surface commits.
  // DVR must not resurrect a message shadowed by another member of the same batch.
  const replaced = newSession('intra-batch-replace')
  const first = replaced.append([
    ['user/message', guard('1'), { surfaceOp: 'append' }],
    ['user/message', message('inert replacement'), {
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
      sourceEventSeqs: [0],
    }],
  ])
  assert.deepEqual(first.map((event) => event.seq), [0, 1])
  assert.deepEqual(replaced.surface.nodes, [1])
  assert.deepEqual(seen.get(replaced).map((row) => row.finalSurface), [[1], [1]])
  assert.deepEqual(seen.get(replaced).map((row) => row.completeLog), [2, 2])
  assert.equal(await index.repairGuardStopSurface(replaced), 0,
    'the shadowed first member must not be repaired again')
  assert.equal(replaced.seq, 2, 'no spurious replacement append')

  // Real RC2 Session publishes a mixed batch with an image; DVR must index the
  // exact accepted attachment without querying or cloning the entire log.
  const images = newSession('attachment')
  const acceptedRef = ref('a')
  const batch = images.append([
    ['turn/start', { turn: 1 }],
    ['user/message', withImage(acceptedRef), { surfaceOp: 'append' }],
    ['user/message', message('follow-up'), { surfaceOp: 'append' }],
  ])
  assert.deepEqual(batch.map((event) => event.seq), [0, 1, 2])
  assert.deepEqual(images.surface.nodes, [1, 2])
  assert.deepEqual(seen.get(images).map((row) => row.finalSurface), [[1, 2], [1, 2], [1, 2]])
  assert.deepEqual(index.lookupAttachment(images, acceptedRef.attachmentId), acceptedRef)
  assert.equal(index.lookupAttachment(replaced, acceptedRef.attachmentId), undefined,
    'attachments must not leak across Sessions')

  // Atomic rejection must not produce event callbacks, phantom attachments,
  // incremented sequence numbers, or a partially mutated surface.
  const rejectedRef = ref('b')
  const seqBefore = images.seq
  const surfaceBefore = [...images.surface.nodes]
  const observationsBefore = seen.get(images).length
  assert.throws(() => images.append([
    ['user/message', withImage(rejectedRef), { surfaceOp: 'append' }],
    ['turn/start', { turn: Number.NaN }],
  ]), /non-JSON-serializable/)
  assert.equal(images.seq, seqBefore)
  assert.deepEqual(images.surface.nodes, surfaceBefore)
  assert.equal(seen.get(images).length, observationsBefore)
  assert.equal(index.lookupAttachment(images, rejectedRef.attachmentId), undefined,
    'a rejected batch must not enter the DVR attachment cache')

  // Two accepted guard-stop notices in one batch must each receive exactly one
  // durable surface shadow. They must never re-enter the append publication.
  const pending = newSession('two-guards')
  pending.append([
    ['user/message', guard('2'), { surfaceOp: 'append' }],
    ['user/message', guard('3'), { surfaceOp: 'append' }],
  ])
  assert.equal(await index.repairGuardStopSurface(pending), 2)
  assert.equal(pending.seq, 4)
  assert.deepEqual(pending.surface.nodes, [2, 3])
  assert.equal(pending.deriveMessages().some((entry) =>
    entry.content?.some((block) => typeof block.text === 'string' && block.text.includes('预算已耗尽'))), false)
  assert.equal(await index.repairGuardStopSurface(pending), 0, 'repair is idempotent')
  assert.equal(pending.seq, 4)

  assert.equal(logReads, 0, 'no full-history reads in normal batch feed')
  assert.equal(eventReads, 0, 'no exact-event recovery in bounded normal batch feed')

  // A single hostile burst crossing the 256-event fast-path cap must recover
  // only its 16 evicted events, not scan the whole Session or silently drop
  // repairs. All 272 entries are real accepted RC2 events in ONE append.
  const overflow = newSession('burst-overflow')
  overflowSession = overflow
  const count = 272
  const fullBatch = Array.from({ length: count }, (_, index) => [
    'user/message', guard(String(1000 + index)), { surfaceOp: 'append' },
  ])
  const committed = overflow.append(fullBatch)
  assert.equal(committed.length, count)
  assert.equal(overflow.seq, count)
  assert.equal(await index.repairGuardStopSurface(overflow), count,
    'batch overflow must not lose repair events')
  assert.equal(overflow.seq, count * 2)
  assert.equal(overflow.surface.nodes.length, count)
  assert.equal(await index.repairGuardStopSurface(overflow), 0)
  assert.equal(eventReads, count - 256,
    'overflow recovery must read only evicted exact events')
  assert.equal(logReads, 0, 'large batch must never request a whole-log clone')
  console.log(JSON.stringify({
    ok: true,
    dsh: '0.2.2-rc.2',
    hostSha: expected,
    batchEvents: batch.length,
    finalSurfaceObserved: true,
    shadowedMemberIgnored: true,
    attachmentIsolated: true,
    rejectedBatchHasNoSideEffects: true,
    guardShadows: 2,
    repeatedRepair: 0,
    overflowEvents: 272,
    boundedOverflowReads: eventReads,
    historyReads: logReads,
    eventReads,
  }))
} finally {
  await ctx.fiber.dispose()
}
