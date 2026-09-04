import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  contextWithTwinImageCapabilityFallback,
  isImageInputUnsupportedFailure,
  twinRequestHasImage,
} from '../lib/twin-image-capability-fallback.js'

function sourceAdapter() {
  return {
    async resolveModel() {
      return { id: 'm', inputModalities: ['text', 'image'] }
    },
    async *stream() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

function imageMessages() {
  return [
    {
      role: 'user',
      content: [{ type: 'image', attachment: { attachmentId: 'img' } }],
    },
  ]
}

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

test('live custom main wrapper route is never mistaken for a generated twin', () => {
  const registrations = new Map([['src', { adapter: sourceAdapter() }]])
  const settings = {
    get(namespace) {
      return namespace === 'vision-router' ? { wrapperRoute: 'src-vision' } : undefined
    },
  }
  const ctx = {
    get(service) {
      return service === 'settings' ? settings : undefined
    },
    llm: {
      registerAdapter(providers, adapter) {
        for (const provider of providers) registrations.set(provider, { adapter })
        return () => {}
      },
      registration(provider) {
        const hit = registrations.get(provider)
        if (!hit) throw new Error(`no adapter ${provider}`)
        return hit
      },
    },
  }

  const wrapped = contextWithTwinImageCapabilityFallback(ctx)
  const mainWrapper = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  wrapped.llm.registerAdapter(['src-vision'], mainWrapper)

  assert.equal(
    registrations.get('src-vision').adapter,
    mainWrapper,
    'the live Settings wrapperRoute is a distinct product route, not a generated source twin',
  )
})

test('generated twin registered before its settings-backed source still gains runtime fallback', async () => {
  const registrations = new Map()
  const seenImages = []
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
      const hit = registrations.get(options.provider)
      if (!hit) throw new Error(`no adapter ${options.provider}`)
      yield* hit.adapter.stream(options)
    },
  }
  const ctx = { llm }
  const wrapped = contextWithTwinImageCapabilityFallback(ctx)

  const generatedTwin = {
    async *stream(options) {
      const source = wrapped.llm.registration('src').adapter
      const info = await source.resolveModel('src', options.model)
      const keep = Array.isArray(info.inputModalities) && info.inputModalities.includes('image')
      const messages = keep
        ? options.messages
        : options.messages.map((message) => ({
            ...message,
            content: message.content.map((block) =>
              block.type === 'image' ? { type: 'text', text: '[vision tool marker]' } : block),
          }))
      yield* wrapped.llm.stream({ ...options, provider: 'src', messages })
    },
  }

  // Core explicitly supports this lifecycle: wrappedProviders may create the
  // twin before a settings-backed source adapter has mounted.
  wrapped.llm.registerAdapter(['src-vision'], generatedTwin)
  assert.equal(registrations.has('src'), false)

  wrapped.llm.registerAdapter(['src'], {
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
        return
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })

  const chunks = await collect(
    registrations.get('src-vision').adapter.stream({ model: 'm', messages: imageMessages() }),
  )
  assert.deepEqual(seenImages, [true, false])
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('specific nested capability code wins even under a generic outer error code', () => {
  assert.equal(
    isImageInputUnsupportedFailure({
      code: 'invalid_value',
      error: { code: 'UNSUPPORTED_IMAGE_INPUT' },
    }),
    true,
  )
})
