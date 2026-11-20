import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  planAppendOnlyImageEvidence,
  createSessionImageEvidencePlanner,
} from '../lib/stable-image-evidence.js'
import {
  rewriteHistoryImages,
  createWrapperStreamBody,
} from '../lib/core-primitives.js'

const id = 'sha256:synthetic-865-image'
const source = { kind: 'plugin:dsh-vision-router' }
const history = () => [
  {
    id: 'original-user-image',
    role: 'user',
    source: { kind: 'user' },
    content: [{
      type: 'image',
      attachment: { attachmentId: id, name: 'synthetic.png' },
    }],
  },
  { id: 'next-user', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'Continue the conversation' }] },
]

test('issue #865: opt-in marker projection ignores late changes to imageMemory', () => {
  const events = history()
  const memory = new Map()
  const before = rewriteHistoryImages(events, memory, { stable: true }).messages
  memory.set(id, 'New OCR recognized later')
  const after = rewriteHistoryImages(events, memory, { stable: true }).messages
  assert.deepEqual(after, before, 'same original image must not mutate request prefix after OCR')
  assert.match(after[0].content[0].text, /sha256:synthetic-865-image/)
  assert.equal(events[0].content[0].type, 'image', 'original durable image is never changed')
  assert.notDeepEqual(
    rewriteHistoryImages(events, memory).messages,
    rewriteHistoryImages(events, new Map()).messages,
    'legacy behavior remains available only when opted out',
  )
})

test('issue #865: append-only evidence is once-per-version, replayable after cold resume', () => {
  const original = history()
  const memory = new Map([[id, 'first OCR result']])
  const first = planAppendOnlyImageEvidence(original, original, memory, source)
  assert.equal(first.length, 1)
  assert.match(first[0].content[0].text, /first OCR result/)
  assert.match(first[0].content[0].text, /不可信证据/)
  assert.notEqual(first[0].id, original[0].id)
  assert.deepEqual(first[0].source, source)
  assert.equal(planAppendOnlyImageEvidence(original, [...original, ...first], memory, source).length, 0,
    'the same evidence must never be injected repeatedly into subsequent Host steps')
  memory.set(id, 'new verified OCR result')
  const later = planAppendOnlyImageEvidence(original, [...original, ...first], memory, source)
  assert.equal(later.length, 1)
  assert.notEqual(later[0].id, first[0].id, 'new evidence is added, not rewritten in old messages')
  assert.match(first[0].content[0].text, /first OCR result/)
  assert.match(later[0].content[0].text, /new verified OCR result/)
  const restored = [...original, ...first, ...later]
  assert.equal(planAppendOnlyImageEvidence(original, restored, memory, source).length, 0,
    'cold restored durable event history must dedupe without an auxiliary Map of emitted ids')
})

test('issue #865: same attachment and text in separate turns never reuse a user/message ID', () => {
  const first = history()
  const second = [{
    ...first[0],
    id: 'next-turn-reused-image',
  }]
  const memory = new Map([[id, 'same OCR for identical attachment']])
  const a = planAppendOnlyImageEvidence(first, first, memory, source)
  const b = planAppendOnlyImageEvidence(second, second, memory, source)
  assert.equal(a.length, 1)
  assert.equal(b.length, 1)
  assert.notEqual(a[0].id, b[0].id,
    'DSH Session messages must have distinct identities even for repeat uploads')
})

test('issue #865: evidence only originates from attached image and is bounded', () => {
  const nested = [{
    id: 'tool-result',
    role: 'tool',
    content: [{ type: 'tool-result', content: [
      { type: 'image', attachment: { attachmentId: 'sha256:nested-evidence' } },
    ] }],
  }]
  const desc = new Map([
    ['sha256:unrelated', 'secret session 2 data'],
    ['sha256:nested-evidence', 'x'.repeat(5000)],
  ])
  const evidence = planAppendOnlyImageEvidence(nested, nested, desc, source)
  assert.equal(evidence.length, 1)
  assert.ok(!evidence[0].content[0].text.includes('secret session 2 data'))
  assert.ok(evidence[0].content[0].text.length < 2300,
    'a long OCR output must not explode the provider prompt')
  assert.deepEqual(planAppendOnlyImageEvidence(nested, nested, new Map(), source), [])
})

test('issue #865: 120k-character replay prefix keeps zero historical mutations after late OCR', () => {
  const longHistory = [history()[0]]
  for (let i = 0; i < 600; i++) {
    longHistory.push({
      id: 'historic-' + i,
      role: i % 2 === 0 ? 'assistant' : 'user',
      content: [{ type: 'text', text: 'stable-history-' + i + ':' + 'x'.repeat(200) }],
    })
  }
  const beforeMemory = new Map()
  const afterMemory = new Map([[id, 'OCR result learned in a later turn']])
  const oldBefore = rewriteHistoryImages(longHistory, beforeMemory).messages
  const oldAfter = rewriteHistoryImages(longHistory, afterMemory).messages
  const stableBefore = rewriteHistoryImages(longHistory, beforeMemory, { stable: true }).messages
  const stableAfter = rewriteHistoryImages(longHistory, afterMemory, { stable: true }).messages
  const changedCount = (a, b) => a.reduce((n, msg, i) =>
    n + Number(JSON.stringify(msg) !== JSON.stringify(b[i])), 0)
  const legacyChanges = changedCount(oldBefore, oldAfter)
  const stableChanges = changedCount(stableBefore, stableAfter)
  assert.ok(JSON.stringify(stableBefore).length > 120_000,
    'exercise a realistically long synthetic replay prefix, not a toy 2-turn chat')
  assert.equal(legacyChanges, 1, 'legacy behavior mutates an older image occurrence')
  assert.equal(stableChanges, 0, 'append-only behavior must mutate zero old messages')
  assert.equal(JSON.stringify(stableBefore), JSON.stringify(stableAfter),
    'full JSON prefix remains identical after a late image-memory write')
  // 1→0 rewritten historic messages is a synthetic cache-prefix metric,
  // NOT a prediction of real DeepSeek cache hit ratio or billed tokens.
})

test('issue #865: delayed OCR tool evidence appends without rewriting the earlier image prefix', () => {
  const original = history()
  const empty = new Map()
  const before = rewriteHistoryImages(original, empty, { stable: true }).messages
  const oldPrefix = JSON.stringify(before)
  const lateToolResult = {
    id: 'late-ocr-tool-result',
    role: 'tool',
    source: { kind: 'tool' },
    content: [{
      type: 'tool-result',
      toolCallId: 'ocr-call-1',
      content: [{ type: 'text', text: 'OCR result from a later vision_ocr call: DSH_865_LATE_TEXT' }],
    }],
  }
  empty.set(id, 'new summary written after the first image was admitted')
  const after = rewriteHistoryImages([...original, lateToolResult], empty, { stable: true }).messages
  assert.equal(JSON.stringify(after.slice(0, original.length)), oldPrefix,
    'all previously admitted messages must serialize identically after delayed OCR')
  assert.match(JSON.stringify(after.at(-1)), /DSH_865_LATE_TEXT/,
    'the already durable tool result must remain visible as appended evidence')
  assert.equal(original[0].content[0].type, 'image')
  // The delayed tool result is already an append-only model-facing event.
  // No duplicate copy should be planned when the new inbox has no image.
  assert.deepEqual(planAppendOnlyImageEvidence(
    [lateToolResult], [lateToolResult], empty, source,
  ), [])
})

test('issue #865: nested tool-result images stay fixed after OCR memory changes', () => {
  const nested = [{
    id: 'read-image-tool-result',
    role: 'tool',
    source: { kind: 'tool' },
    content: [{ type: 'tool-result', toolCallId: 'read-call-1', content: [
      { type: 'text', text: 'result metadata' },
      { type: 'image', attachment: { attachmentId: id, name: 'rendered-output.png' } },
    ] }],
  }]
  const memory = new Map()
  const before = rewriteHistoryImages(nested, memory, { stable: true }).messages
  memory.set(id, 'delayed interpretation')
  const after = rewriteHistoryImages(nested, memory, { stable: true }).messages
  assert.deepEqual(after, before)
  assert.match(JSON.stringify(after), /result metadata/,
    'nested tool-result metadata must survive image sanitization')
  assert.match(JSON.stringify(after), /sha256:synthetic-865-image/)
})

test('issue #865: text-only wrapper stops changing historical image text under stable mode', async () => {
  const requests = []
  const memory = new Map()
  const wrapper = createWrapperStreamBody({
    llm: {
      async *stream(options) {
        requests.push(options)
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }, {
    imageMemory: memory,
    delegateProvider: 'synthetic-text-provider',
    preserveImageInput: false,
    stableImageHistory: true,
  })
  const original = history()
  async function request() {
    for await (const _ of wrapper.stream({
      provider: 'synthetic-text-provider-vision',
      model: 'text-only',
      sessionId: 's-865',
      messages: original,
    })) {}
    return requests.at(-1).messages[0].content[0].text
  }
  const before = await request()
  memory.set(id, 'new knowledge from vision_describe')
  const after = await request()
  assert.equal(after, before, 'historical image marker remains identical after description memory write')
  const evidence = planAppendOnlyImageEvidence(original, original, memory, source)
  assert.equal(evidence.length, 1, 'new knowledge remains available as independent evidence')
  assert.match(evidence[0].content[0].text, /new knowledge from vision_describe/)
})


test('issue #865: memory-only late descriptions append on text continuation, once committed', () => {
  const planner = createSessionImageEvidencePlanner()
  const original = history()[0]
  const events = [{ type: 'user/message', data: original }]
  let scans = 0
  const session = { snapshotEvents() { scans++; return events } }
  const memory = new Map()
  const continuation = [{ id: 'current-text-inbox', role: 'user', content: [{ type: 'text', text: 'continue' }] }]
  assert.deepEqual(planner.plan(session, [original], [original], memory, source), [])
  memory.set(id, 'OCR arrived asynchronously after the image inbox was committed')
  const newEvidence = planner.plan(session, continuation, continuation, memory, source)
  assert.equal(newEvidence.length, 1, 'late evidence must not depend on re-claiming the original image')
  assert.match(newEvidence[0].content[0].text, /asynchronously/)
  // Planning a user/message is not a commit. An aborted Host admission must
  // retry instead of silently dropping that version of evidence.
  assert.deepEqual(planner.plan(session, continuation, continuation, memory, source), newEvidence)
  const committed = { type: 'user/message', data: newEvidence[0] }
  events.push(committed)
  planner.onSessionEvent(session, committed)
  assert.deepEqual(planner.plan(session, continuation, continuation, memory, source), [])
  assert.equal(scans, 1, 'the durable log must only be inspected once per Session')
  const oldPrefix = JSON.stringify(rewriteHistoryImages([original], memory, { stable: true }).messages)
  memory.set(id, 'Newer OCR result on a later turn')
  const later = planner.plan(session, continuation, continuation, memory, source)
  assert.equal(later.length, 1)
  assert.notEqual(later[0].id, newEvidence[0].id)
  assert.equal(JSON.stringify(rewriteHistoryImages([original], memory, { stable: true }).messages), oldPrefix)
  assert.equal(original.content[0].type, 'image')
})

test('issue #865: cold resume reads committed image identity and evidence once', () => {
  const original = history()[0]
  const memory = new Map([[id, 'already persisted']])
  const first = planAppendOnlyImageEvidence([original], [original], memory, source)[0]
  const events = [
    { type: 'user/message', data: original },
    { type: 'user/message', data: first },
  ]
  let scans = 0
  const session = { snapshotEvents() { scans++; return events } }
  const planner = createSessionImageEvidencePlanner()
  const text = [{ id: 'continued-after-restart', role: 'user', content: [{ type: 'text', text: 'hello' }] }]
  assert.deepEqual(planner.plan(session, text, text, memory, source), [],
    'restart must not duplicate an already persisted evidence ID')
  memory.set(id, 'new memory-only content after cold resume')
  const evidence = planner.plan(session, text, text, memory, source)
  assert.equal(evidence.length, 1)
  assert.notEqual(evidence[0].id, first.id)
  assert.equal(scans, 1)
})

test('issue #865: late memory may not escape the owning Session or image provenance bound', () => {
  const planner = createSessionImageEvidencePlanner()
  const original = history()[0]
  const ownSession = { snapshotEvents() { return [{ type: 'user/message', data: original }] } }
  const foreignSession = { snapshotEvents() { return [] } }
  const memory = new Map([[id, 'PRIVATE_SESSION_A_CONTENT']])
  const text = [{ id: 'text-only', role: 'user', content: [{ type: 'text', text: 'test' }] }]
  assert.deepEqual(planner.plan(foreignSession, text, text, memory, source), [],
    'same attachment ID in a foreign memory does not confer authorization')
  assert.equal(planner.plan(ownSession, text, text, memory, source).length, 1)
  const forged = new Map([['sha256:unseen-other', 'unrelated secret']])
  assert.deepEqual(planner.plan(ownSession, text, text, forged, source), [])
  // A bounded tracker must evict old occurrences instead of accumulating an
  // unlimited list of historical attachments or scanning all messages/turn.
  const many = Array.from({ length: 70 }, (_, i) => ({
    id: 'mass-image-' + i, role: 'user',
    content: [{ type: 'image', attachment: { attachmentId: 'sha256:mass-' + i } }],
  }))
  const limitedSession = { snapshotEvents() { return [] } }
  planner.plan(limitedSession, many, many, new Map(), source)
  assert.deepEqual(planner.plan(limitedSession, text, text,
    new Map([['sha256:mass-0', 'evicted result']]), source), [])
  const newest = planner.plan(limitedSession, text, text,
    new Map([['sha256:mass-69', 'most recent result']]), source)
  assert.equal(newest.length, 1)
})


test('issue #865: legacy Session V3 source and V4 source both dedupe persisted evidence', () => {
  const original = history()[0]
  const memory = new Map([[id, 'persisted V3 image evidence']])
  const evidence = planAppendOnlyImageEvidence([original], [original], memory, source)[0]
  const legacy = { ...evidence, source: { kind: 'plugin', plugin: 'dsh-vision-router' } }
  const text = [{ id: 'later', role: 'user', content: [{ type: 'text', text: 'resume' }] }]
  const v3 = { snapshotEvents() { return [
    { type: 'user/message', data: original },
    { type: 'user/message', data: legacy },
  ] } }
  assert.deepEqual(createSessionImageEvidencePlanner().plan(
    v3, text, text, memory, legacy.source,
  ), [], 'legacy Session V3 evidence must not be appended again')
  const v4 = { snapshotEvents() { return [
    { type: 'user/message', data: original },
    { type: 'user/message', data: evidence },
  ] } }
  assert.deepEqual(createSessionImageEvidencePlanner().plan(
    v4, text, text, memory, source,
  ), [], 'current Session V4 evidence must not be appended again')
})


test('issue #865: fifth image does not starve after four evidence messages commit', () => {
  const planner = createSessionImageEvidencePlanner()
  const session = { snapshotEvents() { return [] } }
  const images = Array.from({ length: 5 }, (_, i) => ({
    id: 'five-original-' + i, role: 'user',
    content: [{ type: 'image', attachment: { attachmentId: 'sha256:five-' + i } }],
  }))
  const descriptions = new Map(images.map((message, i) =>
    ['sha256:five-' + i, 'OCR-' + i]))
  const first = planner.plan(session, images, images, descriptions, source)
  assert.equal(first.length, 4, 'Host step budget limits new evidence to four')
  for (const message of first) planner.onSessionEvent(session, { type: 'user/message', data: message })
  const current = [{ id: 'later-text', role: 'user', content: [{ type: 'text', text: 'continue' }] }]
  const second = planner.plan(session, current, current, descriptions, source)
  assert.equal(second.length, 1, 'fifth eligible image must be reached after previous four commit')
  assert.match(second[0].content[0].text, /OCR-0/)
  assert.equal(new Set([...first, ...second].map(message => message.id)).size, 5)
  planner.onSessionEvent(session, { type: 'user/message', data: second[0] })
  assert.deepEqual(planner.plan(session, current, current, descriptions, source), [])
})
