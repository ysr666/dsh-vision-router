import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adapterAttemptBudgetMs,
  contextWithVisionBackendRuntimePolicy,
  hostImageDeliveryFromInfo,
} from '../lib/vision-backend-runtime-policy.js'

function streamText(text = 'adapter') {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

function fixture({ inputModalities, bridgeSupported = true, providerApi = 'openai-completions', messages, localOnlyVision = false, providerTransport } = {}) {
  let adapterCalls = 0
  let directCalls = 0
  let directSessionId
  let directProviderTransport
  let imageReads = 0
  let directMessages
  let registered
  const profile = {
    piProvider: {
      getModels() {
        return [{
          id: 'glm-4.6v',
          api: providerApi,
          baseUrl: 'https://example.invalid/v1',
        }]
      },
    },
  }
  const settings = {
    get(namespace) {
      if (namespace === 'vision-router') {
        return {
          timeoutMs: 120000,
          visionTaskTimeoutMs: 120000,
          localOnlyVision,
          freeFallback: true,
          providers: [{ provider: 'bg', model: 'glm-4.6v', fallbacks: [] }],
        }
      }
      if (namespace === 'llm-pi-ai') {
        return {
          providers: {
            bg: {
              api: providerApi,
              baseURL: 'https://example.invalid/v1',
            },
          },
        }
      }
      return undefined
    },
  }
  const llm = {
    async prepareCall() {
      return inputModalities === undefined ? {} : { inputModalities }
    },
    async resolveModelInfo() {
      return inputModalities === undefined ? {} : { inputModalities }
    },
    registration() {
      return { adapter: { config: { profiles: () => new Map([['bg', profile]]) } } }
    },
    stream() {
      adapterCalls += 1
      return streamText()
    },
  }
  const ctx = {
    llm,
    tools: {
      register(definition) {
        registered = definition
        return () => {}
      },
    },
    get(name) {
      if (name === 'settings') return settings
      if (name === 'attachments') {
        return {
          async readImage() {
            imageReads += 1
            return { data: Buffer.from('png'), mediaType: 'image/png' }
          },
        }
      }
      return undefined
    },
  }
  const core = {
    blocksHaveImage(content) {
      return Array.isArray(content) && content.some((block) => block?.type === 'image')
    },
    decideVisionBackendCapability(info) {
      return {
        image: info?.inputModalities?.includes('image') === true || info?.inputModalities?.includes('text') === true,
        inferred: info?.inputModalities?.includes('image') === true ? false : 'name',
      }
    },
    resolveChannelBridgeTransport() {
      return bridgeSupported
        ? { api: providerApi, baseURL: 'https://example.invalid/v1' }
        : { api: 'websocket', baseURL: 'wss://example.invalid' }
    },
    isOpenAIHttpBridgeTransport(transport) {
      return transport?.api === 'openai-completions' && /^https?:/.test(String(transport.baseURL))
    },
    async callOpenAICompatible(_provider, wireMessages, callOptions) {
      directCalls += 1
      directSessionId = callOptions?.sessionId
      directProviderTransport = callOptions?.providerTransport
      directMessages = wireMessages
      assert.equal(wireMessages[0].content.some((block) => block.type === 'image_url'), true)
      return '731'
    },
  }
  const wrapped = contextWithVisionBackendRuntimePolicy(ctx, { core, config: settings.get('vision-router'), providerTransport })
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      return collect(wrapped.llm.stream({
        provider: 'bg',
        model: 'glm-4.6v',
        messages: messages ?? [{
          role: 'user',
          content: [
            { type: 'image', attachment: { attachmentId: 'sha256:test', mediaType: 'image/png' } },
            { type: 'text', text: 'describe' },
          ],
        }],
        maxTokens: 64,
        sessionId: 'session-410-preflight',
      }))
    },
  })
  return {
    run: () => registered.execute(),
    adapterCalls: () => adapterCalls,
    directCalls: () => directCalls,
    directSessionId: () => directSessionId,
    directProviderTransport: () => directProviderTransport,
    imageReads: () => imageReads,
    directMessages: () => directMessages,
  }
}

test('host image delivery distinguishes native, projected and unknown metadata', () => {
  assert.equal(hostImageDeliveryFromInfo({ inputModalities: ['text', 'image'] }), 'native-image')
  assert.equal(hostImageDeliveryFromInfo({ inputModalities: ['text'] }), 'text-projected')
  assert.equal(hostImageDeliveryFromInfo({}), 'unknown')
  assert.equal(hostImageDeliveryFromInfo(undefined), 'unknown')
})

test('text-projected explicit visual backend uses direct bridge before adapter dispatch', async () => {
  const f = fixture({ inputModalities: ['text'] })
  const chunks = await f.run()
  assert.equal(f.adapterCalls(), 0)
  assert.equal(f.directCalls(), 1)
  assert.equal(f.directSessionId(), 'session-410-preflight')
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === '731'), true)
})

test('text-projected direct bridge preserves the explicit provider transport', async () => {
  const providerTransport = { fetch() { throw new Error('not called by this unit seam') } }
  const f = fixture({ inputModalities: ['text'], providerTransport })
  await f.run()
  assert.equal(f.directProviderTransport(), providerTransport)
})

test('local-only policy blocks adapter and preflight bridge before any remote image delivery', async () => {
  const f = fixture({ inputModalities: ['text'], localOnlyVision: true })
  const chunks = await f.run()
  assert.equal(f.adapterCalls(), 0)
  assert.equal(f.directCalls(), 0)
  assert.equal(f.imageReads(), 0)
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  assert.equal(finish?.reason?.kind, 'error')
  assert.equal(finish?.reason?.failure?.code, 'VISION_LOCAL_ONLY_POLICY')
})

test('offloaded-only history is text-visible and never activates the preflight image bridge', async () => {
  const f = fixture({
    inputModalities: ['text'],
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          offloaded: true,
          attachment: { attachmentId: 'sha256:old-only', mediaType: 'image/png' },
        },
        { type: 'text', text: 'continue' },
      ],
    }],
  })
  await f.run()
  assert.equal(f.adapterCalls(), 1)
  assert.equal(f.directCalls(), 0)
  assert.equal(f.imageReads(), 0)
})

test('preflight bridge sends retained images but only text placeholders for offloaded history', async () => {
  const f = fixture({
    inputModalities: ['text'],
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          offloaded: true,
          attachment: { attachmentId: 'sha256:old-mixed', mediaType: 'image/png' },
        },
        {
          type: 'image',
          attachment: { attachmentId: 'sha256:retained-mixed', mediaType: 'image/png' },
        },
      ],
    }],
  })
  await f.run()
  assert.equal(f.adapterCalls(), 0)
  assert.equal(f.directCalls(), 1)
  assert.equal(f.imageReads(), 1)
  const content = f.directMessages()[0].content
  assert.equal(content.filter((block) => block.type === 'image_url').length, 1)
  assert.equal(content.filter((block) => block.type === 'text').length, 1)
  assert.match(content.find((block) => block.type === 'text').text, /image omitted to fit request image limits/)
})

test('native image metadata stays adapter-first', async () => {
  const f = fixture({ inputModalities: ['text', 'image'] })
  await f.run()
  assert.equal(f.adapterCalls(), 1)
  assert.equal(f.directCalls(), 0)
})

test('unknown image metadata stays adapter-first', async () => {
  const f = fixture({ inputModalities: undefined })
  await f.run()
  assert.equal(f.adapterCalls(), 1)
  assert.equal(f.directCalls(), 0)
})

test('known text projection without a safe bridge never sends the SHA-only request to adapter', async () => {
  const f = fixture({ inputModalities: ['text'], bridgeSupported: false })
  const chunks = await f.run()
  assert.equal(f.adapterCalls(), 0)
  assert.equal(f.directCalls(), 0)
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  assert.equal(finish?.reason?.kind, 'error')
  assert.equal(finish?.reason?.failure?.code, 'VISION_IMAGE_DELIVERY_UNAVAILABLE')
  assert.match(finish?.reason?.failure?.message, /strips image pixels before the registered adapter/)
  assert.match(finish?.reason?.failure?.message, /Settings > Models > provider > Customized settings > Model options > Input types/)
  assert.match(finish?.reason?.failure?.message, /input: \[text, image\]/)
  assert.match(finish?.reason?.failure?.message, /inputModalities: \[text, image\]/)
  assert.match(finish?.reason?.failure?.message, /HTTP OpenAI Chat Completions/)
  assert.equal(f.imageReads(), 0, 'must not read image bytes without a safe pixel transport')
})

test('Responses API without Host image declaration fails closed, corrected declaration uses registered adapter', async () => {
  const misdeclared = fixture({ inputModalities: ['text'], providerApi: 'openai-responses' })
  const blocked = await misdeclared.run()
  assert.equal(misdeclared.adapterCalls(), 0, 'text-only projected pixels must never be sent as fake image evidence')
  assert.equal(misdeclared.directCalls(), 0, 'Responses API must not masquerade as Chat Completions bridge')
  assert.equal(misdeclared.imageReads(), 0)
  assert.equal(blocked.find((chunk) => chunk.type === 'finish')?.reason?.failure?.code, 'VISION_IMAGE_DELIVERY_UNAVAILABLE')

  const corrected = fixture({ inputModalities: ['text', 'image'], providerApi: 'openai-responses' })
  const streamed = await corrected.run()
  assert.equal(corrected.adapterCalls(), 1, 'corrected Host modality must restore native adapter dispatch')
  assert.equal(corrected.directCalls(), 0)
  assert.equal(streamed.find((chunk) => chunk.type === 'finish')?.reason?.kind, 'stop')
})

test('default cloud attempt reserves the final quarter of a 120s task for fallback', () => {
  assert.equal(adapterAttemptBudgetMs({ timeoutMs: 120000, visionTaskTimeoutMs: 120000, freeFallback: true }, 'bg'), 90000)
  assert.equal(adapterAttemptBudgetMs({ timeoutMs: 120000, visionTaskTimeoutMs: 120000, freeFallback: false }, 'bg'), 120000)
  assert.equal(adapterAttemptBudgetMs({ timeoutMs: 120000, visionTaskTimeoutMs: 120000, freeFallback: true }, 'vision-http'), 120000)
})

test('backend runtime policy cache expires with the owning Cordis generation', () => {
  let cleanup
  const ctx = {
    effect(factory) { cleanup = factory() },
  }
  const first = contextWithVisionBackendRuntimePolicy(ctx, { config: { marker: 'first' } })
  assert.equal(contextWithVisionBackendRuntimePolicy(ctx, { config: { marker: 'same-generation' } }), first)
  cleanup()
  const second = contextWithVisionBackendRuntimePolicy(ctx, { config: { marker: 'second' } })
  assert.notEqual(second, first)
})

test('backend runtime policy cache never pins generation-owned options after effect failure', () => {
  const ctx = {
    effect() { throw new Error('inactive fiber') },
  }
  const first = contextWithVisionBackendRuntimePolicy(ctx, { config: { marker: 'first' } })
  const second = contextWithVisionBackendRuntimePolicy(ctx, { config: { marker: 'second' } })
  assert.notEqual(second, first)
})
