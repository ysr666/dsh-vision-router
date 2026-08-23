import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyPiAiBridgeWireFacts,
  installPiAiBridgeWireCompat,
  resolvePiAiBridgeWireFacts,
} from '../lib/pi-ai-bridge-wire-compat.js'

function profile({
  provider = 'custom',
  model = 'vision-model',
  baseUrl = 'https://gateway.example/v1',
  maxTokensField = 'max_completion_tokens',
  headers = { 'x-tenant': 'alpha' },
} = {}) {
  return {
    headers,
    piProvider: {
      getModels() {
        return [{
          id: model,
          provider,
          api: 'openai-completions',
          baseUrl,
          ...(maxTokensField === null ? {} : { compat: { maxTokensField } }),
        }]
      },
    },
  }
}

function fakeCtx(profiles) {
  const adapter = {
    config: {
      profiles() {
        return profiles
      },
    },
  }
  return {
    llm: {
      listProviders() {
        return [...profiles.keys()].map((id) => ({ id }))
      },
      registration(provider) {
        if (!profiles.has(provider)) throw new Error('missing provider')
        return { adapter }
      },
    },
    get() {
      return undefined
    },
    effect() {
      return () => {}
    },
  }
}

test('resolves rc1 model-level maxTokensField and route headers by exact endpoint/model', () => {
  const profiles = new Map([
    ['custom', profile()],
  ])
  const facts = resolvePiAiBridgeWireFacts(
    fakeCtx(profiles),
    'https://gateway.example/v1/chat/completions',
    'vision-model',
  )
  assert.deepEqual(facts, {
    provider: 'custom',
    model: 'vision-model',
    maxTokensField: 'max_completion_tokens',
    headers: { 'x-tenant': 'alpha' },
  })
})

test('resolves pi-ai detected Z.ai max_completion_tokens when no explicit compat override exists', () => {
  const profiles = new Map([
    ['zhipu-glm', profile({
      provider: 'zhipu-glm',
      model: 'glm-4.6v',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      maxTokensField: null,
      headers: {},
    })],
  ])
  const facts = resolvePiAiBridgeWireFacts(
    fakeCtx(profiles),
    'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    'glm-4.6v',
  )
  assert.deepEqual(facts, {
    provider: 'zhipu-glm',
    model: 'glm-4.6v',
    maxTokensField: 'max_completion_tokens',
    headers: {},
  })
})

test('keeps pi-ai detected max_tokens vendors unchanged when no explicit override exists', () => {
  const profiles = new Map([
    ['moonshotai-cn', profile({
      provider: 'moonshotai-cn',
      baseUrl: 'https://api.moonshot.cn/v1',
      maxTokensField: null,
      headers: {},
    })],
  ])
  const facts = resolvePiAiBridgeWireFacts(
    fakeCtx(profiles),
    'https://api.moonshot.cn/v1/chat/completions',
    'vision-model',
  )
  assert.equal(facts.maxTokensField, 'max_tokens')
})

test('ambiguous aliases with different wire facts fail closed', () => {
  const profiles = new Map([
    ['a', profile({ provider: 'a', maxTokensField: 'max_tokens' })],
    ['b', profile({ provider: 'b', maxTokensField: 'max_completion_tokens' })],
  ])
  assert.equal(
    resolvePiAiBridgeWireFacts(
      fakeCtx(profiles),
      'https://gateway.example/v1/chat/completions',
      'vision-model',
    ),
    undefined,
  )
})

test('request rewrite uses max_completion_tokens and preserves request-owned headers', () => {
  const init = {
    method: 'POST',
    headers: {
      authorization: 'Bearer real-key',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'vision-model',
      messages: [],
      max_tokens: 4096,
      stream: false,
    }),
  }
  const body = JSON.parse(init.body)
  const patched = applyPiAiBridgeWireFacts(init, body, {
    maxTokensField: 'max_completion_tokens',
    headers: {
      'x-tenant': 'alpha',
      authorization: 'Bearer profile-must-not-overwrite-request',
    },
  })
  const wire = JSON.parse(patched.body)
  assert.equal(wire.max_tokens, undefined)
  assert.equal(wire.max_completion_tokens, 4096)
  const headers = new Headers(patched.headers)
  assert.equal(headers.get('x-tenant'), 'alpha')
  assert.equal(headers.get('authorization'), 'Bearer real-key')
  assert.equal(headers.get('content-type'), 'application/json')
})

test('installed boundary rewrites only the non-streaming image bridge shape', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init })
    return { ok: true }
  }
  const ctx = fakeCtx(new Map([['custom', profile()]]))
  const cleanup = installPiAiBridgeWireCompat(ctx)
  try {
    const imageMessages = [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
        { type: 'text', text: 'describe' },
      ],
    }]
    await globalThis.fetch('https://gateway.example/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'vision-model',
        messages: imageMessages,
        max_tokens: 64,
        stream: false,
      }),
    })
    await globalThis.fetch('https://gateway.example/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'vision-model',
        messages: imageMessages,
        max_tokens: 64,
        stream: true,
      }),
    })

    assert.equal(calls.length, 2)
    const bridged = JSON.parse(calls[0].init.body)
    assert.equal(bridged.max_tokens, undefined)
    assert.equal(bridged.max_completion_tokens, 64)
    assert.equal(new Headers(calls[0].init.headers).get('x-tenant'), 'alpha')

    const streaming = JSON.parse(calls[1].init.body)
    assert.equal(streaming.max_tokens, 64)
    assert.equal(streaming.max_completion_tokens, undefined)
    assert.equal(new Headers(calls[1].init.headers).get('x-tenant'), null)
  } finally {
    cleanup()
    globalThis.fetch = originalFetch
  }
})
