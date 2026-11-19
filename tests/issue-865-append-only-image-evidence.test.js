import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  planAppendOnlyImageEvidence,
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
