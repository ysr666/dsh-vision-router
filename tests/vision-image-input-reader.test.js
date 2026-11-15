import assert from 'node:assert/strict'
import test from 'node:test'
import { createVisionImageInputReader } from '../lib/vision-image-input-reader.js'

const bytes = Buffer.from('89504e470d0a1a0a0000000000000000', 'hex')
const id = 'sha256:' + 'a'.repeat(64)
const ref = { attachmentId: id, mediaType: 'image/png' }
const throwIfAborted = (signal) => { if (signal?.aborted) throw signal.reason ?? new Error('aborted') }

test('authorized attachment reader forwards cancellation to Host and returns canonical bytes', async () => {
  const seen = []
  const ctx = { get(name) {
    if (name !== 'attachments') return undefined
    return { async readImage(attachment, signal) {
      seen.push([attachment, signal])
      return { ref: attachment, data: bytes }
    } }
  } }
  const reader = createVisionImageInputReader(ctx, async () => ref, throwIfAborted)
  const controller = new AbortController()
  const got = await reader({ signal: controller.signal, agent: { session: { id: 'one' } } }, id)
  assert.deepEqual(got.bytes, bytes)
  assert.equal(got.mediaType, 'image/png')
  assert.equal(seen.length, 1)
  assert.equal(seen[0][0], ref)
  assert.equal(seen[0][1], controller.signal)
})

test('legacy attachmentIds force Session lookup, not filesystem path fallback', async () => {
  let usedFs = false
  const ctx = { get(name) {
    if (name === 'fs') return { async resolve() { usedFs = true; throw new Error('unexpected filesystem access') } }
    if (name === 'attachments') return { async readImage(input) {
      assert.equal(input, ref)
      return { ref: input, data: bytes }
    } }
    return undefined
  } }
  const reader = createVisionImageInputReader(ctx, async () => ref, throwIfAborted)
  const got = await reader({ agent: { session: {} } }, 'legacy-id', new Map([['legacy-id', ref]]), true)
  assert.equal(got.mediaType, 'image/png')
  assert.equal(usedFs, false)
})

test('unknown session-owned image fails closed before Host reads', async () => {
  let touched = false
  const ctx = { get(name) {
    if (name === 'attachments') return { async readImage() { touched = true; return { ref, data: bytes } } }
    return undefined
  } }
  const reader = createVisionImageInputReader(ctx, async () => undefined, throwIfAborted)
  await assert.rejects(reader({ agent: { session: {} } }, id), /unknown attachment id/)
  assert.equal(touched, false)
})

test('a late Session resolution after cancellation cannot trigger attachment IO', async () => {
  let finish
  let touched = false
  const ctx = { get(name) {
    if (name === 'attachments') return { async readImage() { touched = true; return { ref, data: bytes } } }
    return undefined
  } }
  const reader = createVisionImageInputReader(ctx, () => new Promise((resolve) => { finish = resolve }), throwIfAborted)
  const controller = new AbortController()
  const pending = reader({ signal: controller.signal, agent: { session: {} } }, id)
  controller.abort(new Error('cancel before resolution finishes'))
  finish(ref)
  await assert.rejects(pending, /cancel before resolution finishes/)
  assert.equal(touched, false)
})
