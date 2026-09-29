import test from 'node:test'
import assert from 'node:assert/strict'
import { installPiAiBridgeWireCompat } from '../lib/pi-ai-bridge-wire-compat.js'
import { installLegacyGlobalProxyBoundary, streamWithLegacyGlobalProxyScope } from '../lib/legacy-global-proxy-boundary.js'
import { runWithVisionSessionAffinity } from '../lib/session-affinity-runtime.js'
import { installRuntimeI18nBoundary } from '../lib/runtime-i18n-boundary.js'

const endpoint = 'https://opencode.ai/zen/go/v1/chat/completions'
const pair = { provider: 'host-vision', model: 'vision-model' }

function pipeline() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  let underlying = globalThis.fetch
  let assignments = 0
  let depth = 0
  let enabled = true
  const compose = (stamp) => (input, init) => {
    // Bound the original recursion deterministically, without a network call
    // or depending on the engine's maximum stack size/error formatting.
    if (++depth > 8) { --depth; throw new Error('accessor fetch cycle') }
    try {
      const headers = new Headers(init?.headers)
      if (stamp) headers.set('x-host-pipeline', 'preserved')
      return underlying(input, { ...init, headers })
    } finally { --depth }
  }
  let fetch = compose(enabled)
  const descriptor = {
    configurable: true, enumerable: previous?.enumerable ?? true,
    get: () => fetch,
    set(next) { assignments++; underlying = next; fetch = compose(enabled) },
  }
  Object.defineProperty(globalThis, 'fetch', descriptor)
  return { descriptor, assignments: () => assignments,
    setEnabled(value) { enabled = value; fetch = compose(enabled) },
  }
}

function fixture(t, { proxy = '' } = {}) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  const calls = []
  const agents = []
  const disposers = []
  let config = { proxy, proxyHosts: ['opencode.ai'], providers: [pair] }
  let imports = 0
  const hostDispatcher = { dispatch: () => 'host-dispatcher' }
  class ProxyAgent {
    constructor(url) { this.url = url; this.closed = false; agents.push(this) }
    dispatch() { return this }
    async close() { this.closed = true }
  }
  const hostFetch = async (input, init) => {
    calls.push({ input, init, headers: new Headers(init?.headers) })
    return new Response('host-result')
  }
  Object.defineProperty(globalThis, 'fetch', { configurable: true, enumerable: true, writable: true, value: hostFetch })
  const profiles = new Map([[pair.provider, {
    headers: { 'x-route': 'tenant-a', authorization: 'profile-value' },
    piProvider: { getModels: () => [{
      id: pair.model, api: 'openai-completions', provider: pair.provider,
      baseUrl: 'https://opencode.ai/zen/go/v1', compat: { maxTokensField: 'max_completion_tokens' },
    }] },
  }]])
  const ctx = {
    llm: {
      listProviders: () => [{ id: pair.provider }],
      registration: () => ({ adapter: { config: { profiles: () => profiles } } }),
    },
    get: () => ({ get: () => config }),
    effect: () => {},
  }
  const install = (mode) => {
    if (mode !== 'proxy') disposers.push(installPiAiBridgeWireCompat(ctx))
    if (mode !== 'wire') disposers.push(installLegacyGlobalProxyBoundary(ctx, config, {
      importUndici: async () => { imports++; return { ProxyAgent, getGlobalDispatcher: () => hostDispatcher } },
    }))
  }
  t.after(async () => {
    try { for (const dispose of disposers.toReversed()) dispose() }
    finally { Object.defineProperty(globalThis, 'fetch', saved) }
    await new Promise((resolve) => setImmediate(resolve))
  })
  return { calls, agents, disposers, hostFetch, install, imports: () => imports,
    setConfig: (extra) => { config = { ...config, ...extra } } }
}

const imageInit = () => ({
  method: 'POST', headers: { authorization: 'request-value' },
  body: JSON.stringify({ model: pair.model, stream: false, max_tokens: 64,
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }],
  }),
})

async function scopedFetch(init = imageInit()) {
  const values = []
  const stream = streamWithLegacyGlobalProxyScope(pair.provider, pair.model, () => ({
    async *[Symbol.asyncIterator]() {
      yield await runWithVisionSessionAffinity('session-test', () => globalThis.fetch(endpoint, init))
    },
  }))
  for await (const response of stream) values.push(await response.text())
  return values
}

for (const mode of ['wire', 'proxy', 'both']) {
  for (const order of ['pipeline-first', 'dvr-first']) {
    test(`${mode}: ${order} composes with accessor and preserves Host traffic after unload`, async (t) => {
      const f = fixture(t)
      let p
      if (order === 'pipeline-first') p = pipeline()
      f.install(mode)
      if (order === 'dvr-first') p = pipeline()
      assert.equal(await (await globalThis.fetch(endpoint, { method: 'GET' })).text(), 'host-result')
      assert.equal(f.calls.length, 1)
      assert.equal(f.calls[0].headers.get('x-host-pipeline'), 'preserved')
      assert.equal(f.calls[0].init.dispatcher, undefined)
      assert.equal(f.imports(), 0, 'blank proxy must not acquire private transport')
      for (const dispose of f.disposers) dispose() // Deliberately not LIFO.
      assert.equal(await (await globalThis.fetch(endpoint, { method: 'GET' })).text(), 'host-result')
      assert.equal(f.calls.length, 2)
      assert.equal(f.calls[1].headers.get('x-host-pipeline'), 'preserved')
      assert.equal(p.assignments(), 0, 'install/unload must never recapture a wrapper via the foreign setter')
      assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'fetch'), p.descriptor)
    })
  }
}

for (const order of ['pipeline-first', 'dvr-first']) {
  test(`${order}: explicit proxy and pi-ai/OpenCode wire rules remain scoped`, async (t) => {
    const f = fixture(t, { proxy: 'http://127.0.0.1:7890' })
    if (order === 'pipeline-first') pipeline()
    f.install('both')
    if (order === 'dvr-first') pipeline()
    await Promise.all([
      scopedFetch(),
      globalThis.fetch(endpoint, { method: 'POST', body: '{"stream":true}' }),
    ])
    assert.equal(f.calls.length, 2)
    const visual = f.calls.find((call) => call.headers.get('x-opencode-session') === 'session-test')
    const host = f.calls.find((call) => call !== visual)
    assert.ok(visual)
    assert.equal(visual.headers.get('x-route'), 'tenant-a')
    assert.equal(visual.headers.get('authorization'), 'request-value')
    assert.equal(visual.headers.get('x-host-pipeline'), 'preserved')
    assert.equal(JSON.parse(visual.init.body).max_completion_tokens, 64)
    assert.equal(Object.hasOwn(JSON.parse(visual.init.body), 'max_tokens'), false)
    assert.equal(visual.init.dispatcher.dispatch({ origin: 'https://opencode.ai' }, {}), f.agents[0])
    assert.equal(visual.init.dispatcher.dispatch({ origin: 'https://other.example' }, {}), 'host-dispatcher')
    assert.equal(host.init.dispatcher, undefined)
    assert.equal(host.headers.get('x-opencode-session'), null)
    assert.equal(host.headers.get('x-route'), null)
    assert.equal(f.imports(), 1)

    const native = imageInit()
    native.headers['x-opencode-session'] = 'upstream-native'
    await scopedFetch(native)
    assert.equal(f.calls.at(-1).headers.get('x-opencode-session'), 'upstream-native')
    f.setConfig({ proxy: '' })
    await scopedFetch()
    assert.equal(f.calls.at(-1).init.dispatcher, undefined, 'live proxy clearing must keep Host egress')
    assert.equal(f.imports(), 1)

    for (const dispose of f.disposers) dispose()
    await scopedFetch()
    const after = f.calls.at(-1)
    assert.equal(after.init.dispatcher, undefined)
    assert.equal(after.headers.get('x-opencode-session'), null)
    assert.equal(after.headers.get('x-route'), null)
    assert.equal(JSON.parse(after.init.body).max_tokens, 64)
    assert.equal(after.headers.get('x-host-pipeline'), 'preserved')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.agents[0].closed, true)
  })
}

test('later Host fetch replacement stays authoritative across cleanup', async (t) => {
  const f = fixture(t)
  pipeline()
  f.install('both')
  let calls = 0
  const replacement = async () => { calls++; return new Response('new-host') }
  globalThis.fetch = replacement
  assert.equal(await (await globalThis.fetch(endpoint)).text(), 'new-host')
  for (const dispose of f.disposers) dispose()
  assert.equal(globalThis.fetch, replacement)
  assert.equal(await (await globalThis.fetch(endpoint)).text(), 'new-host')
  assert.equal(calls, 2)
  assert.equal(f.calls.length, 0)
})

test('scoped affinity validation still rejects before network with an accessor pipeline', async (t) => {
  const f = fixture(t)
  pipeline()
  f.install('both')
  await assert.rejects(runWithVisionSessionAffinity('unsafe\nidentity', () => globalThis.fetch(endpoint, imageInit())),
    (error) => error.code === 'OPENCODE_SESSION_INVALID')
  assert.equal(f.calls.length, 0)
})

for (const order of ['pipeline-first', 'dvr-first']) {
  test(`${order}: Host middleware replacement and removal are observed live`, async (t) => {
    const f = fixture(t)
    let p
    if (order === 'pipeline-first') p = pipeline()
    f.install('both')
    if (order === 'dvr-first') p = pipeline()
    await scopedFetch()
    assert.equal(f.calls.at(-1).headers.get('x-host-pipeline'), 'preserved')
    p.setEnabled(false)
    await scopedFetch()
    assert.equal(f.calls.at(-1).headers.get('x-host-pipeline'), null, 'removed middleware must not survive in a captured closure')
    assert.equal(f.calls.at(-1).headers.get('x-opencode-session'), 'session-test')
    p.setEnabled(true)
    await scopedFetch()
    assert.equal(f.calls.at(-1).headers.get('x-host-pipeline'), 'preserved')
    for (const dispose of f.disposers.toReversed()) dispose()
    p.setEnabled(false)
    await scopedFetch()
    assert.equal(f.calls.at(-1).headers.get('x-host-pipeline'), null)
    assert.equal(f.calls.at(-1).headers.get('x-opencode-session'), null)
    assert.equal(p.assignments(), 0)
  })
}


test('runtime i18n prompt boundary composes with accessor fetch without setter recursion', async (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  const calls = []
  const cleanups = []
  const hostFetch = async (input, init) => {
    calls.push({ input, init, headers: new Headers(init?.headers) })
    return new Response('host-result')
  }
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: hostFetch,
  })
  const p = pipeline()
  const settings = {
    get(namespace) {
      if (namespace === 'locale') return { preference: 'en' }
      if (namespace === 'vision-router') return { tool: true, autoActivateOnImage: true }
      return undefined
    },
  }
  const ctx = {
    tools: { register() { return () => {} } },
    llm: {},
    get(name) { return name === 'settings' ? settings : undefined },
    effect(setup) {
      const cleanup = setup()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
  }
  t.after(() => {
    try { for (const cleanup of cleanups.toReversed()) cleanup() }
    finally { Object.defineProperty(globalThis, 'fetch', saved) }
  })

  installRuntimeI18nBoundary(ctx, {})
  assert.equal(p.assignments(), 0, 'i18n install must not write through a foreign fetch setter')

  const ordinary = await globalThis.fetch(endpoint, { method: 'GET' })
  assert.equal(await ordinary.text(), 'host-result')
  assert.equal(calls.at(-1).headers.get('x-host-pipeline'), 'preserved')

  const body = JSON.stringify({
    prompt: '请详细描述这张图片的内容：主要元素、文字（照抄原文）、布局与细节。',
  })
  const localized = await globalThis.fetch(endpoint, { method: 'POST', body })
  assert.equal(await localized.text(), 'host-result')
  assert.equal(calls.at(-1).headers.get('x-host-pipeline'), 'preserved')
  assert.notEqual(calls.at(-1).init.body, body, 'model-facing legacy prompt should still be localized')
  assert.doesNotMatch(calls.at(-1).init.body, /请详细描述这张图片/)

  p.setEnabled(false)
  await globalThis.fetch(endpoint, { method: 'GET' })
  assert.equal(calls.at(-1).headers.get('x-host-pipeline'), null, 'live Host middleware removal must remain visible')

  for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
  assert.equal(p.assignments(), 0, 'i18n cleanup must not write through a foreign fetch setter')
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'fetch'), p.descriptor)
})
