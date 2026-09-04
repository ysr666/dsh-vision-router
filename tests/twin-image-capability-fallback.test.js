import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextWithAgentRequestRouteAuthority } from '../lib/agent-request-route-authority.js'
import {
  contextWithTwinImageCapabilityFallback,
  isImageInputUnsupportedFailure,
  twinRequestHasImage,
} from '../lib/twin-image-capability-fallback.js'

function imageMessages(id = 'img') {
  return [
    {
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: id } },
        { type: 'text', text: 'what?' },
      ],
    },
  ]
}

function makeHarness(sourceAdapter) {
  const registrations = new Map([['src', { adapter: sourceAdapter }]])
  const llm = {
    registerAdapter(providers, adapter) {
      for (const provider of providers) registrations.set(provider, { adapter })
      return () => {}
    },
    registration(provider) {
      const hit = registrations.get(provider)
      if (!hit) throw new Error(`no adapter ${provider}`)
      return hit
    },
    async *stream(options) {
      const registration = registrations.get(options.provider)
      if (!registration) throw new Error(`no adapter ${options.provider}`)
      yield* registration.adapter.stream(options)
    },
  }
  return { ctx: { llm }, registrations }
}

function makeGeneratedTwin(ctx, sourceProvider = 'src') {
  return {
    async *stream(options) {
      const source = ctx.llm.registration(sourceProvider).adapter
      const info = await source.resolveModel(sourceProvider, options.model)
      const keep = Array.isArray(info.inputModalities) && info.inputModalities.includes('image')
      const messages = keep
        ? options.messages
        : options.messages.map((message) => ({
            ...message,
            content: message.content.map((block) =>
              block.type === 'image' ? { type: 'text', text: '[vision tool marker]' } : block),
          }))
      yield* ctx.llm.stream({ ...options, provider: sourceProvider, messages })
    },
  }
}

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

test('classifier matches explicit image-capability rejection only', () => {
  assert.equal(
    isImageInputUnsupportedFailure(
      new Error(
        'The provided messages contain images, but gguf@q2_k_xl does not support image inputs.',
      ),
    ),
    true,
  )
  assert.equal(isImageInputUnsupportedFailure({ code: 'UNSUPPORTED_CONTENT' }), true)
  assert.equal(
    isImageInputUnsupportedFailure({
      code: 'UNSUPPORTED_CONTENT',
      message: 'unsupported audio block',
    }),
    false,
  )
  assert.equal(isImageInputUnsupportedFailure(new Error('400 max_tokens must be <= 1024')), false)
  assert.equal(isImageInputUnsupportedFailure(new Error('429 rate limited')), false)
})

test('recursive request image detection includes nested tool-result images', () => {
  assert.equal(twinRequestHasImage(imageMessages()), true)
  assert.equal(
    twinRequestHasImage([
      {
        role: 'user',
        content: [{ type: 'tool-result', content: [{ type: 'image' }] }],
      },
    ]),
    true,
  )
  assert.equal(
    twinRequestHasImage([{ role: 'user', content: [{ type: 'text', text: 'x' }] }]),
    false,
  )
})

test('Core-facing authority boundary retries false-positive image metadata through canonical bridge', async () => {
  const seenImages = []
  const source = {
    async resolveModel() {
      return { id: 'm', inputModalities: ['text', 'image'] }
    },
    async *stream(options) {
      const hasImage = twinRequestHasImage(options.messages)
      seenImages.push(hasImage)
      if (hasImage) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message:
                'The provided messages contain images, but gguf@q2_k_xl does not support image inputs.',
              code: 'invalid_value',
            },
          },
        }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const { ctx, registrations } = makeHarness(source)
  const logs = []
  ctx.logger = { warn: (...args) => logs.push(args) }
  const privateCtx = contextWithAgentRequestRouteAuthority(ctx)
  privateCtx.llm.registerAdapter(['src-vision'], makeGeneratedTwin(privateCtx))

  const chunks = await collect(
    registrations.get('src-vision').adapter.stream({ model: 'm', messages: imageMessages() }),
  )

  assert.deepEqual(seenImages, [true, false])
  assert.equal(chunks.some((chunk) => chunk.reason?.kind === 'error'), false)
  assert.equal(
    chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'ok'),
    true,
  )
  assert.equal(logs.length, 1)
})

test('negative runtime proof skips known-bad raw image until source adapter changes', async () => {
  const seenImages = []
  const badSource = {
    async resolveModel() {
      return { id: 'm', inputModalities: ['text', 'image'] }
    },
    async *stream(options) {
      const hasImage = twinRequestHasImage(options.messages)
      seenImages.push(hasImage)
      if (hasImage) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: 'model does not support image inputs' },
          },
        }
      } else {
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    },
  }
  const harness = makeHarness(badSource)
  const privateCtx = contextWithTwinImageCapabilityFallback(harness.ctx)
  privateCtx.llm.registerAdapter(['src-vision'], makeGeneratedTwin(privateCtx))
  const twin = harness.registrations.get('src-vision').adapter

  await collect(twin.stream({ model: 'm', messages: imageMessages('one') }))
  await collect(twin.stream({ model: 'm', messages: imageMessages('two') }))
  assert.deepEqual(seenImages, [true, false, false])

  const newSeen = []
  const goodSource = {
    async resolveModel() {
      return { id: 'm', inputModalities: ['text', 'image'] }
    },
    async *stream(options) {
      newSeen.push(twinRequestHasImage(options.messages))
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  harness.registrations.set('src', { adapter: goodSource })
  await collect(twin.stream({ model: 'm', messages: imageMessages('three') }))
  assert.deepEqual(newSeen, [true], 'adapter replacement must invalidate the negative proof')
})

test('unrelated provider failures are not retried', async () => {
  let calls = 0
  const source = {
    async resolveModel() {
      return { id: 'm', inputModalities: ['text', 'image'] }
    },
    async *stream() {
      calls += 1
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: '400 max_tokens must be <= 1024' } },
      }
    },
  }
  const harness = makeHarness(source)
  const privateCtx = contextWithTwinImageCapabilityFallback(harness.ctx)
  privateCtx.llm.registerAdapter(['src-vision'], makeGeneratedTwin(privateCtx))

  const chunks = await collect(
    harness.registrations
      .get('src-vision')
      .adapter.stream({ model: 'm', messages: imageMessages() }),
  )
  assert.equal(calls, 1)
  assert.equal(chunks.at(-1).reason.kind, 'error')
})

test('failure after committed model output never retries or duplicates output', async () => {
  let calls = 0
  const source = {
    async resolveModel() {
      return { id: 'm', inputModalities: ['text', 'image'] }
    },
    async *stream() {
      calls += 1
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'model does not support image inputs' },
        },
      }
    },
  }
  const harness = makeHarness(source)
  const privateCtx = contextWithTwinImageCapabilityFallback(harness.ctx)
  privateCtx.llm.registerAdapter(['src-vision'], makeGeneratedTwin(privateCtx))

  const chunks = await collect(
    harness.registrations
      .get('src-vision')
      .adapter.stream({ model: 'm', messages: imageMessages() }),
  )
  assert.equal(calls, 1)
  assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').length, 1)
  assert.equal(chunks.at(-1).reason.kind, 'error')
})

test('thrown image rejection before output retries once', async () => {
  const seenImages = []
  const source = {
    async resolveModel() {
      return { id: 'm', inputModalities: ['text', 'image'] }
    },
    async *stream(options) {
      const hasImage = twinRequestHasImage(options.messages)
      seenImages.push(hasImage)
      if (hasImage) throw new Error('adapter does not support image content')
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const harness = makeHarness(source)
  const privateCtx = contextWithTwinImageCapabilityFallback(harness.ctx)
  privateCtx.llm.registerAdapter(['src-vision'], makeGeneratedTwin(privateCtx))

  await collect(
    harness.registrations
      .get('src-vision')
      .adapter.stream({ model: 'm', messages: imageMessages() }),
  )
  assert.deepEqual(seenImages, [true, false])
})

test('caller cancellation never triggers a fallback retry', async () => {
  let calls = 0
  const controller = new AbortController()
  const source = {
    async resolveModel() {
      return { id: 'm', inputModalities: ['text', 'image'] }
    },
    async *stream() {
      calls += 1
      controller.abort()
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'model does not support image inputs' },
        },
      }
    },
  }
  const harness = makeHarness(source)
  const privateCtx = contextWithTwinImageCapabilityFallback(harness.ctx)
  privateCtx.llm.registerAdapter(['src-vision'], makeGeneratedTwin(privateCtx))

  const chunks = await collect(
    harness.registrations.get('src-vision').adapter.stream({
      model: 'm',
      messages: imageMessages(),
      signal: controller.signal,
    }),
  )
  assert.equal(calls, 1)
  assert.equal(chunks.at(-1).reason.kind, 'error')
})

test('provisional usage from a rejected pre-validation attempt is not published', async () => {
  let attempt = 0
  const source = {
    async resolveModel() {
      return { id: 'm', inputModalities: ['text', 'image'] }
    },
    async *stream(options) {
      attempt += 1
      const hasImage = twinRequestHasImage(options.messages)
      yield { type: 'usage', inputTokens: hasImage ? 999 : 10 }
      if (hasImage) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: 'model does not support image inputs' },
          },
        }
        return
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const harness = makeHarness(source)
  const privateCtx = contextWithTwinImageCapabilityFallback(harness.ctx)
  privateCtx.llm.registerAdapter(['src-vision'], makeGeneratedTwin(privateCtx))

  const chunks = await collect(
    harness.registrations
      .get('src-vision')
      .adapter.stream({ model: 'm', messages: imageMessages() }),
  )
  assert.equal(attempt, 2)
  assert.deepEqual(
    chunks.filter((chunk) => chunk.type === 'usage').map((chunk) => chunk.inputTokens),
    [10],
  )
})

test('configured main wrapper route is excluded from generated-twin interception', () => {
  const source = {
    async resolveModel() {
      return { id: 'm', inputModalities: ['text', 'image'] }
    },
    async *stream() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const harness = makeHarness(source)
  const privateCtx = contextWithTwinImageCapabilityFallback(harness.ctx, {
    wrapperRoute: 'deepseek-vision',
  })
  const main = makeGeneratedTwin(privateCtx)
  privateCtx.llm.registerAdapter(['deepseek-vision'], main)
  assert.equal(harness.registrations.get('deepseek-vision').adapter, main)
})
