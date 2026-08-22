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

function fixture({ inputModalities, bridgeSupported = true } = {}) {
  let adapterCalls = 0
  let directCalls = 0
  let registered
  const profile = {
    piProvider: {
      getModels() {
        return [{
          id: 'glm-4.6v',
          api: 'openai-completions',
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
          freeFallback: true,
          providers: [{ provider: 'bg', model: 'glm-4.6v', fallbacks: [] }],
        }
      }
      if (namespace === 'llm-pi-ai') {
        return {
          providers: {
            bg: {
              api: 'openai-completions',
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
        ? { api: 'openai-completions', baseURL: 'https://example.invalid/v1' }
        : { api: 'websocket', baseURL: 'wss://example.invalid' }
    },
    isOpenAIHttpBridgeTransport(transport) {
      return transport?.api === 'openai-completions' && /^https?:/.test(String(transport.baseURL))
    },
    async callOpenAICompatible(_provider, messages) {
      directCalls += 1
      assert.equal(messages[0].content.some((block) => block.type === 'image_url'), true)
      return '731'
    },
  }
  const wrapped = contextWithVisionBackendRuntimePolicy(ctx, { core, config: settings.get('vision-router') })
  wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      return collect(wrapped.llm.stream({
        provider: 'bg',
        model: 'glm-4.6v',
        messages: [{
          role: 'user',
          content: [
            { type: 'image', attachment: { attachmentId: 'sha256:test', mediaType: 'image/png' } },
            { type: 'text', text: 'describe' },
          ],
        }],
        maxTokens: 64,
      }))
    },
  })
  return {
    run: () => registered.execute(),
    adapterCalls: () => adapterCalls,
    directCalls: () => directCalls,
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
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === '731'), true)
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
})

test('default cloud attempt reserves the final quarter of a 120s task for fallback', () => {
  assert.equal(adapterAttemptBudgetMs({ timeoutMs: 120000, visionTaskTimeoutMs: 120000, freeFallback: true }, 'bg'), 90000)
  assert.equal(adapterAttemptBudgetMs({ timeoutMs: 120000, visionTaskTimeoutMs: 120000, freeFallback: false }, 'bg'), 120000)
  assert.equal(adapterAttemptBudgetMs({ timeoutMs: 120000, visionTaskTimeoutMs: 120000, freeFallback: true }, 'vision-http'), 120000)
})
