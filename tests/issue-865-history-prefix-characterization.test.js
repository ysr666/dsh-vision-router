import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rewriteHistoryImages, createWrapperStreamBody } from '../lib/core-primitives.js'

const ATTACHMENT = 'sha256:issue865-synthetic-image'
const imageHistory = () => [
  { role: 'system', id: 'system', content: [{ type: 'text', text: 'stable system' }] },
  { role: 'user', id: 'old-image', content: [
    { type: 'text', text: 'What is this image?' },
    { type: 'image', attachment: { attachmentId: ATTACHMENT, name: 'synthetic.png' } },
  ] },
  { role: 'assistant', id: 'old-answer', content: [{ type: 'text', text: 'Let me check.' }] },
  { role: 'user', id: 'new-user', content: [{ type: 'text', text: 'Continue discussing the old result.' }] },
]

test('issue #865 characterization: adding vision memory rewrites an earlier model-facing user message', () => {
  const history = imageHistory()
  const memory = new Map()
  const first = rewriteHistoryImages(history, memory).messages
  const firstImage = first[1].content[1].text
  assert.match(firstImage, /sha256:issue865-synthetic-image/)
  assert.equal(history[1].content[1].type, 'image', 'durable original remains untouched')

  memory.set(ATTACHMENT, 'Synthetic OCR/vision result loaded after the first request')
  const second = rewriteHistoryImages(history, memory).messages
  const changedImage = second[1].content[1].text
  assert.notEqual(changedImage, firstImage,
    'CHARACTERIZATION: the old image occurrence changes after a later memory update')
  assert.match(changedImage, /Synthetic OCR\/vision result/)
  assert.deepEqual(second[0], first[0])
  assert.equal(second[1].id, first[1].id, 'same durable message identity, different projected content')
  assert.equal(history[1].content[1].type, 'image', 'durable history still is not mutated')
})

test('issue #865 characterization: generated text twin repeats the same early-history change', async () => {
  const requests = []
  const memory = new Map()
  const adapter = createWrapperStreamBody({
    llm: {
      async *stream(options) {
        requests.push(options)
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }, {
    imageMemory: memory,
    delegateProvider: 'synthetic-text-model',
    preserveImageInput: false,
  })
  const history = imageHistory()
  const run = async () => {
    for await (const _ of adapter.stream({
      provider: 'synthetic-text-model-vision',
      model: 'text-only',
      sessionId: 'synthetic-session',
      messages: history,
    })) {}
    return requests.at(-1).messages[1].content[1].text
  }
  const before = await run()
  memory.set(ATTACHMENT, 'Second-pass OCR evidence')
  const after = await run()
  assert.notEqual(before, after, 'CHARACTERIZATION: source wire prefix drifts after cached vision result')
  assert.match(after, /Second-pass OCR evidence/)
})
