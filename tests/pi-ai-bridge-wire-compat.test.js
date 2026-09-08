import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyPiAiBridgeWireFacts,
  applyScopedOpenCodeSessionAffinity,
  installPiAiBridgeWireCompat,
  resolvePiAiBridgeWireFacts,
} from '../lib/pi-ai-bridge-wire-compat.js'
import { currentVisionSessionAffinityId, runWithVisionSessionAffinity, streamWithVisionSessionAffinity } from '../lib/session-affinity-runtime.js'

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

test('does not infer vendor token semantics from a lookalike URL hostname', () => {
  const profiles = new Map([
    ['custom', profile({
      provider: 'custom',
      baseUrl: 'https://gateway.ai.cloudflare.com.attacker.invalid/v1',
      maxTokensField: null,
      headers: {},
    })],
  ])
  const facts = resolvePiAiBridgeWireFacts(
    fakeCtx(profiles),
    'https://gateway.ai.cloudflare.com.attacker.invalid/v1/chat/completions',
    'vision-model',
  )
  assert.equal(facts.maxTokensField, 'max_completion_tokens')
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


test('scoped Host traffic receives x-opencode-session only on the official Go endpoint', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers ?? {}) })
    return new Response('ok', { status: 200 })
  }
  const cleanup = installPiAiBridgeWireCompat(fakeCtx(new Map()))
  try {
    await runWithVisionSessionAffinity('session-host-wire', async () => {
      await globalThis.fetch('https://opencode.ai/zen/go/v1/responses', {
        method: 'POST', headers: { 'x-client-request-id': 'generic-only' }, body: '{}',
      })
      await globalThis.fetch('https://example.com/zen/go/v1/responses', {
        method: 'POST', body: '{}',
      })
      await globalThis.fetch('https://opencode.ai/zen/go/v1/models', {
        method: 'GET',
      })
    })
    await globalThis.fetch('https://opencode.ai/zen/go/v1/responses', {
      method: 'POST', body: '{}',
    })
    assert.equal(calls.length, 4)
    assert.equal(calls[0].headers.get('x-opencode-session'), 'session-host-wire')
    assert.equal(calls[0].headers.get('x-client-request-id'), 'generic-only')
    assert.equal(calls[1].headers.get('x-opencode-session'), null)
    assert.equal(calls[2].headers.get('x-opencode-session'), null, 'non-inference Go requests stay untouched')
    assert.equal(calls[3].headers.get('x-opencode-session'), null)
  } finally {
    cleanup()
    globalThis.fetch = originalFetch
  }
})

test('scoped Go compatibility never overwrites an upstream-native header', async () => {
  const originalFetch = globalThis.fetch
  let captured
  globalThis.fetch = async (_input, init) => {
    captured = new Headers(init?.headers ?? {})
    return new Response('ok', { status: 200 })
  }
  const cleanup = installPiAiBridgeWireCompat(fakeCtx(new Map()))
  try {
    await runWithVisionSessionAffinity('plugin-session', () =>
      globalThis.fetch('https://opencode.ai/zen/go/v1/messages', {
        method: 'POST',
        headers: { 'x-opencode-session': 'upstream-native' },
        body: '{}',
      }))
    assert.equal(captured.get('x-opencode-session'), 'upstream-native')
  } finally {
    cleanup()
    globalThis.fetch = originalFetch
  }
})

test('invalid scoped Go identity fails before network instead of becoming a Fetch ByteString error', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; return new Response('unexpected') }
  const cleanup = installPiAiBridgeWireCompat(fakeCtx(new Map()))
  try {
    await assert.rejects(
      runWithVisionSessionAffinity('会话-123', () =>
        globalThis.fetch('https://opencode.ai/zen/go/v1/chat/completions', { method: 'POST', body: '{}' })),
      (error) => error?.code === 'OPENCODE_SESSION_INVALID',
    )
    assert.equal(calls, 0)
  } finally {
    cleanup()
    globalThis.fetch = originalFetch
  }
})

test('lazy concurrent streams keep per-request affinity isolated', async () => {
  const originalFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers ?? {})
    await new Promise((resolve) => setTimeout(resolve, headers.get('x-opencode-session') === 'session-a' ? 8 : 1))
    seen.push(headers.get('x-opencode-session'))
    return new Response('ok', { status: 200 })
  }
  const cleanup = installPiAiBridgeWireCompat(fakeCtx(new Map()))
  const makeStream = (sessionId) => streamWithVisionSessionAffinity(sessionId, () => ({
    async *[Symbol.asyncIterator]() {
      await globalThis.fetch('https://opencode.ai/zen/go/v1/responses', { method: 'POST', body: '{}' })
      yield sessionId
    },
  }))
  try {
    const drain = async (stream) => { for await (const _ of stream) {} }
    await Promise.all([drain(makeStream('session-a')), drain(makeStream('session-b'))])
    assert.deepEqual(new Set(seen), new Set(['session-a', 'session-b']))
  } finally {
    cleanup()
    globalThis.fetch = originalFetch
  }
})

test('pure scoped projection accepts Request headers and preserves native authority', () => {
  const request = new Request('https://opencode.ai/zen/go/v1/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer key' },
  })
  const projected = applyScopedOpenCodeSessionAffinity(request, { headers: { 'x-extra': '1' } }, 'session-request')
  const headers = new Headers(projected.headers)
  assert.equal(headers.get('authorization'), 'Bearer key')
  assert.equal(headers.get('x-extra'), '1')
  assert.equal(headers.get('x-opencode-session'), 'session-request')
})


test('affinity scope retires when async work outlives the owned call', async () => {
  let late
  await runWithVisionSessionAffinity('session-retired', async () => {
    late = new Promise((resolve) => {
      setTimeout(() => resolve(currentVisionSessionAffinityId()), 10)
    })
  })
  assert.equal(await late, undefined)
})

test('returning an unstarted scoped stream never starts upstream work', async () => {
  let starts = 0
  const stream = streamWithVisionSessionAffinity('session-cancelled', () => {
    starts += 1
    return { async *[Symbol.asyncIterator]() { yield 'unexpected' } }
  })
  const iterator = stream[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.return('done'), { done: true, value: 'done' })
  assert.equal(starts, 0)
})
