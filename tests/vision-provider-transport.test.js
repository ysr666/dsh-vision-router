import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  createVisionProviderTransport,
  currentVisionProviderTransport,
  installVisionProviderTransport,
} from '../lib/vision-provider-transport.js'
import { fetchWithOpenAICompatibility } from '../lib/http-compat.js'
import { callAnthropicCompatible } from '../lib/catalog-corrections.js'

function okOpenAI(text = 'ok') {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function okAnthropic(text = 'ok') {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function requestInit(body = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'vision-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'see' }] }],
      max_tokens: 64,
      ...body,
    }),
  }
}

test('Router-owned OpenAI compatibility bypasses the caller/global fetch once transport is installed', async () => {
  const calls = []
  const original = async (input, init) => {
    calls.push({ source: 'original', input, init })
    return okOpenAI('transport')
  }
  const patched = async () => {
    throw new Error('legacy global fetch patch must not own Router provider HTTP')
  }
  const transport = createVisionProviderTransport({ fetchImpl: original })
  const release = installVisionProviderTransport(transport)
  try {
    const response = await fetchWithOpenAICompatibility(
      patched,
      'https://vision.example/v1/chat/completions',
      requestInit(),
      { active: true, providerName: 'example' },
    )
    assert.equal(response.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].source, 'original')
  } finally {
    release()
  }
  assert.equal(currentVisionProviderTransport(), undefined)
})

test('provider-scoped proxy uses an explicit dispatcher only for configured hosts', async () => {
  const calls = []
  class FakeProxyAgent {
    constructor(url) {
      this.url = url
    }
  }
  let config = {
    proxy: 'http://127.0.0.1:7890',
    proxyHosts: ['api.example.com'],
  }
  const transport = createVisionProviderTransport({
    config: () => config,
    fetchImpl: async (input, init) => {
      calls.push({ input: String(input), init })
      return okOpenAI()
    },
    importUndici: async () => ({ ProxyAgent: FakeProxyAgent }),
  })

  await transport.fetch('https://api.example.com/v1/chat/completions', requestInit())
  await transport.fetch('https://maintenance.example/v1/chat/completions', requestInit())

  assert.equal(calls.length, 2)
  assert.ok(calls[0].init.dispatcher instanceof FakeProxyAgent)
  assert.equal(calls[0].init.dispatcher.url, 'http://127.0.0.1:7890')
  assert.equal(calls[1].init.dispatcher, undefined)

  config = { ...config, proxy: '' }
  await transport.fetch('https://api.example.com/v1/chat/completions', requestInit())
  assert.equal(calls[2].init.dispatcher, undefined, 'live proxy disable must take effect without restart')
})

test('active=false compatibility traffic is not claimed by the Router provider transport', async () => {
  let transportCalls = 0
  let callerCalls = 0
  const transport = createVisionProviderTransport({
    fetchImpl: async () => {
      transportCalls += 1
      return okOpenAI()
    },
  })
  const release = installVisionProviderTransport(transport)
  try {
    await fetchWithOpenAICompatibility(
      async () => {
        callerCalls += 1
        return okOpenAI()
      },
      'https://registry.example/chat/completions',
      requestInit(),
      { active: false },
    )
  } finally {
    release()
  }
  assert.equal(transportCalls, 0)
  assert.equal(callerCalls, 1)
})

test('Anthropic correction/local transport also bypasses ambient global fetch', async () => {
  const calls = []
  const transport = createVisionProviderTransport({
    fetchImpl: async (input, init) => {
      calls.push({ input: String(input), init })
      return okAnthropic('anthropic-transport')
    },
  })
  const release = installVisionProviderTransport(transport)
  try {
    const output = await callAnthropicCompatible(
      { name: 'corrected', baseURL: 'https://api.example', model: 'vision', apiKeyEnv: '' },
      [{ role: 'user', content: [{ type: 'text', text: 'look' }] }],
      { allowKeyless: true },
    )
    assert.equal(output, 'anthropic-transport')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].input, 'https://api.example/v1/messages')
  } finally {
    release()
  }
})

test('transport credential resolver prefers Host credentials and falls back to environment', async () => {
  const previous = process.env.DVR_TEST_PROVIDER_KEY
  process.env.DVR_TEST_PROVIDER_KEY = 'env-secret'
  try {
    const transport = createVisionProviderTransport({
      ctx: {
        get(name) {
          if (name !== 'credentials') return undefined
          return {
            async resolve(ref) {
              return ref === 'HOST_KEY' ? { value: 'host-secret' } : undefined
            },
          }
        },
      },
      fetchImpl: async () => okOpenAI(),
    })
    assert.equal(await transport.resolveCredential('HOST_KEY'), 'host-secret')
    assert.equal(await transport.resolveCredential('DVR_TEST_PROVIDER_KEY'), 'env-secret')
  } finally {
    if (previous === undefined) delete process.env.DVR_TEST_PROVIDER_KEY
    else process.env.DVR_TEST_PROVIDER_KEY = previous
  }
})

test('public entry installs the provider transport before legacy core apply', async () => {
  const source = await readFile(new URL('../lib/public-entry.js', import.meta.url), 'utf8')
  const installAt = source.indexOf('installVisionProviderTransport(transport)')
  const applyAt = source.indexOf('base.apply(runtimeCtx, hardening.config)')
  assert.ok(installAt >= 0)
  assert.ok(applyAt > installAt)
  assert.match(source, /config:\s*\(\) => liveVisionConfig/)
})
