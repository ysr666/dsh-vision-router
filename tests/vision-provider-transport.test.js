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
import { effectiveProxyUrlForUndici } from '../lib/proxy-url-compat.js'
import { isVisionProxyDispatcher } from '../lib/proxy-routing.js'

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

const defaultFakeHostDispatcher = Object.freeze({
  dispatch() { return 'host' },
})

function fakeUndiciModule(ProxyAgent, fallbackDispatcher = defaultFakeHostDispatcher) {
  if (typeof ProxyAgent.prototype.dispatch !== 'function') {
    Object.defineProperty(ProxyAgent.prototype, 'dispatch', {
      configurable: true,
      value() { return this },
    })
  }
  return {
    ProxyAgent,
    getGlobalDispatcher: () => fallbackDispatcher,
  }
}

function selectedDispatcher(dispatcher, input) {
  if (!dispatcher || typeof dispatcher.dispatch !== 'function') return dispatcher
  const origin = new URL(String(input)).origin
  return dispatcher.dispatch({ origin }, {})
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

test('blank plugin proxy inherits the ambient Host dispatcher without importing ProxyAgent', async () => {
  const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = await import('undici')
  const previous = getGlobalDispatcher()
  const hostDispatcher = new MockAgent()
  hostDispatcher.disableNetConnect()
  hostDispatcher
    .get('https://host-proxy-proof.invalid')
    .intercept({ path: '/proof', method: 'GET' })
    .reply(200, 'HOST-DISPATCHER')
  setGlobalDispatcher(hostDispatcher)
  let imports = 0
  try {
    // createVisionProviderTransport captured globalThis.fetch when the module was
    // imported, before this test installed the Host dispatcher. A successful
    // interception therefore proves the captured fetch resolves ambient Host
    // dispatcher state at request time rather than freezing a direct route.
    const transport = createVisionProviderTransport({
      config: { proxy: '', proxyHosts: ['host-proxy-proof.invalid'] },
      importUndici: async () => {
        imports += 1
        throw new Error('blank plugin proxy must not import ProxyAgent')
      },
    })
    const response = await transport.fetch('https://host-proxy-proof.invalid/proof')
    assert.equal(await response.text(), 'HOST-DISPATCHER')
    assert.equal(imports, 0)
  } finally {
    setGlobalDispatcher(previous)
    await hostDispatcher.close()
  }
})

test('Host-first production path does not import the Host proxy package or duplicate its route decision', async () => {
  const files = await Promise.all([
    readFile(new URL('../lib/vision-provider-transport.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/public-entry.js', import.meta.url), 'utf8'),
    readFile(new URL('../index.js', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ])
  for (const source of files) {
    assert.doesNotMatch(source, /@deepseek-ai\/dsh-http-proxy/)
    assert.doesNotMatch(source, /proxyRouteFor\s*\(/)
  }
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
    importUndici: async () => fakeUndiciModule(FakeProxyAgent),
  })

  await transport.fetch('https://api.example.com/v1/chat/completions', requestInit())
  await transport.fetch('https://maintenance.example/v1/chat/completions', requestInit())

  assert.equal(calls.length, 2)
  const firstProxyDispatcher = selectedDispatcher(calls[0].init.dispatcher, calls[0].input)
  assert.ok(firstProxyDispatcher instanceof FakeProxyAgent)
  assert.equal(firstProxyDispatcher.url, 'http://127.0.0.1:7890')
  assert.equal(calls[1].init.dispatcher, undefined)

  config = { ...config, proxy: '' }
  await transport.fetch('https://api.example.com/v1/chat/completions', requestInit())
  assert.equal(calls[2].init.dispatcher, undefined, 'live proxy disable must take effect without restart')
})

test('redirect hops outside proxyHosts return to the inherited Host dispatcher', async () => {
  const { MockAgent } = await import('undici')
  const proxyPath = new MockAgent()
  const hostPath = new MockAgent()
  proxyPath.disableNetConnect()
  hostPath.disableNetConnect()
  proxyPath
    .get('https://api.example.com')
    .intercept({ path: '/start', method: 'GET' })
    .reply(302, '', { headers: { location: 'https://cdn.example.net/final' } })
  hostPath
    .get('https://cdn.example.net')
    .intercept({ path: '/final', method: 'GET' })
    .reply(200, 'HOST-FINAL')

  let proxyDispatches = 0
  class FakeProxyAgent {
    constructor(url) { this.url = url }
    dispatch(options, handler) {
      proxyDispatches += 1
      return proxyPath.dispatch(options, handler)
    }
    async close() {}
  }
  const transport = createVisionProviderTransport({
    config: { proxy: 'http://proxy.test:8080', proxyHosts: ['api.example.com'] },
    fetchImpl: globalThis.fetch.bind(globalThis),
    importUndici: async () => fakeUndiciModule(FakeProxyAgent, hostPath),
  })

  try {
    const response = await transport.fetch('https://api.example.com/start')
    assert.equal(await response.text(), 'HOST-FINAL')
    assert.equal(proxyDispatches, 1, 'only the admitted first hop may use the DVR proxy')
  } finally {
    await transport.dispose()
    await proxyPath.close()
    await hostPath.close()
  }
})

test('initial non-matching host remains fully Host-owned across a later redirect into proxyHosts', async () => {
  const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = await import('undici')
  const previous = getGlobalDispatcher()
  const hostPath = new MockAgent()
  hostPath.disableNetConnect()
  hostPath
    .get('https://entry.example')
    .intercept({ path: '/start', method: 'GET' })
    .reply(302, '', { headers: { location: 'https://api.example.com/final' } })
  hostPath
    .get('https://api.example.com')
    .intercept({ path: '/final', method: 'GET' })
    .reply(200, 'HOST-ONLY')
  setGlobalDispatcher(hostPath)
  let imports = 0
  const transport = createVisionProviderTransport({
    config: { proxy: 'http://proxy.test:8080', proxyHosts: ['api.example.com'] },
    importUndici: async () => {
      imports += 1
      throw new Error('initial non-matching admission must not load DVR Undici')
    },
  })

  try {
    const response = await transport.fetch('https://entry.example/start')
    assert.equal(await response.text(), 'HOST-ONLY')
    assert.equal(imports, 0, 'first-hop admission preserves the #149 no-Undici boundary')
  } finally {
    await transport.dispose()
    setGlobalDispatcher(previous)
    await hostPath.close()
  }
})

test('per-hop selector fails closed to fallback when dispatcher origin is malformed', async () => {
  const routed = []
  const fallback = {
    dispatch(options) {
      routed.push({ owner: 'fallback', origin: String(options.origin) })
      return 'fallback'
    },
  }
  class FakeProxyAgent {
    dispatch(options) {
      routed.push({ owner: 'proxy', origin: String(options.origin) })
      return 'proxy'
    }
    async close() {}
  }
  const transport = createVisionProviderTransport({
    config: { proxy: 'http://proxy.test:8080', proxyHosts: ['api.example.com'] },
    fetchImpl: async (_input, init) => {
      assert.equal(init.dispatcher.dispatch({ origin: 'not a valid origin' }, {}), 'fallback')
      return okOpenAI()
    },
    importUndici: async () => fakeUndiciModule(FakeProxyAgent, fallback),
  })

  try {
    await transport.fetch('https://api.example.com/start')
    assert.deepEqual(routed, [{ owner: 'fallback', origin: 'not a valid origin' }])
  } finally {
    await transport.dispose()
  }
})

test('per-hop selector preserves an explicit caller dispatcher for non-matching redirects', async () => {
  const routed = []
  const callerDispatcher = {
    dispatch(options) {
      routed.push({ owner: 'caller', origin: String(options.origin) })
      return 'caller'
    },
  }
  class FakeProxyAgent {
    constructor(url) { this.url = url }
    dispatch(options) {
      routed.push({ owner: 'proxy', origin: String(options.origin) })
      return 'proxy'
    }
    async close() {}
  }
  const transport = createVisionProviderTransport({
    config: { proxy: 'http://proxy.test:8080', proxyHosts: ['api.example.com'] },
    fetchImpl: async (_input, init) => {
      assert.equal(init.dispatcher.dispatch({ origin: 'https://api.example.com' }, {}), 'proxy')
      assert.equal(init.dispatcher.dispatch({ origin: 'https://cdn.example.net' }, {}), 'caller')
      return okOpenAI()
    },
    importUndici: async () => fakeUndiciModule(FakeProxyAgent),
  })

  try {
    await transport.fetch('https://api.example.com/start', { dispatcher: callerDispatcher })
    assert.deepEqual(routed, [
      { owner: 'proxy', origin: 'https://api.example.com' },
      { owner: 'caller', origin: 'https://cdn.example.net' },
    ])
  } finally {
    await transport.dispose()
  }
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

test('public entry installs provider transport before runtime and scoped Host proxy boundary after runtime', async () => {
  const source = await readFile(new URL('../lib/public-entry.js', import.meta.url), 'utf8')
  const installAt = source.indexOf('installVisionProviderTransport(transport)')
  const applyAt = source.indexOf('base.apply(runtimeCtx, hardening.config)')
  const legacyBoundaryAt = source.indexOf('installLegacyGlobalProxyBoundary(runtimeCtx, hardening.config)')
  assert.ok(installAt >= 0)
  assert.ok(applyAt > installAt)
  assert.ok(legacyBoundaryAt > applyAt, 'Host-owned compatibility observer must wrap the completed runtime fetch chain')
  assert.match(source, /config:\s*\(\) => liveVisionConfig/)
  assert.match(source, /releaseTransportRegistry\(\)/)
  assert.match(source, /void transport\.dispose\(\)/)
})


test('proxy compatibility projection changes only the historical socks5h scheme', () => {
  assert.equal(
    effectiveProxyUrlForUndici('socks5h://127.0.0.1:7890'),
    'socks5://127.0.0.1:7890',
  )
  assert.equal(
    effectiveProxyUrlForUndici('SOCKS5H://user:pass@[::1]:7890/path?q=1#x'),
    'socks5://user:pass@[::1]:7890/path?q=1#x',
  )
  assert.equal(
    effectiveProxyUrlForUndici('  socks5h://127.0.0.1:7890'),
    '  socks5://127.0.0.1:7890',
  )
  for (const value of [
    'http://127.0.0.1:7890',
    'https://proxy.example:8443',
    'socks://127.0.0.1:7890',
    'socks5://127.0.0.1:7890',
    'socks4://127.0.0.1:7890',
    'ftp://proxy.example',
    'not-a-url',
  ]) {
    assert.equal(effectiveProxyUrlForUndici(value), value)
  }
})

test('legacy socks5h settings are projected only for admitted proxy hosts and share effective dispatcher identity', async () => {
  const calls = []
  const constructed = []
  let imports = 0
  class FakeProxyAgent {
    constructor(url) {
      this.url = url
      constructed.push(url)
    }
  }
  let config = {
    proxy: 'socks5h://user:pass@[::1]:7890',
    proxyHosts: ['api.example.com'],
  }
  const transport = createVisionProviderTransport({
    config: () => config,
    fetchImpl: async (input, init) => {
      calls.push({ input: String(input), init })
      return okOpenAI()
    },
    importUndici: async () => {
      imports += 1
      return fakeUndiciModule(FakeProxyAgent)
    },
  })

  await transport.fetch('https://maintenance.example/v1/chat/completions', requestInit())
  assert.equal(imports, 0, 'non-matching hosts must preserve the #149 no-Undici path')
  assert.equal(calls[0].init.dispatcher, undefined)

  await transport.fetch('https://api.example.com/v1/chat/completions', requestInit())
  assert.equal(imports, 1)
  assert.deepEqual(constructed, ['socks5://user:pass@[::1]:7890'])
  const firstDispatcher = selectedDispatcher(calls[1].init.dispatcher, calls[1].input)

  config = { ...config, proxy: 'socks5://user:pass@[::1]:7890' }
  await transport.fetch('https://api.example.com/v1/chat/completions', requestInit())
  assert.equal(imports, 1, 'canonical-equivalent settings must reuse the cached dispatcher')
  assert.equal(selectedDispatcher(calls[2].init.dispatcher, calls[2].input), firstDispatcher)
})

test('proxy host admission canonicalizes case, whitespace, trailing dot and IDNA without broadening suffixes', async () => {
  const calls = []
  class FakeProxyAgent { constructor(url) { this.url = url } }
  const transport = createVisionProviderTransport({
    config: {
      proxy: 'http://127.0.0.1:7890',
      proxyHosts: [' API.EXAMPLE.COM ', 'BÜCHER.DE'],
    },
    fetchImpl: async (input, init) => { calls.push({ input: String(input), init }); return okOpenAI() },
    importUndici: async () => fakeUndiciModule(FakeProxyAgent),
  })

  await transport.fetch('https://api.example.com./v1/chat/completions', requestInit())
  await transport.fetch('https://bücher.de/v1/chat/completions', requestInit())
  await transport.fetch('https://api.example.com.evil.test/v1/chat/completions', requestInit())

  assert.equal(isVisionProxyDispatcher(selectedDispatcher(calls[0].init.dispatcher, calls[0].input)), true)
  assert.equal(isVisionProxyDispatcher(selectedDispatcher(calls[1].init.dispatcher, calls[1].input)), true)
  assert.equal(calls[2].init.dispatcher, undefined)
  assert.equal(transport.proxyDecision('https://API.EXAMPLE.COM./x').proxied, true)
})

test('dispatcher cache cleanup is promise-identity safe across an A-B-A proxy race', async () => {
  const imports = []
  class FakeProxyAgent { constructor(url) { this.url = url } }
  let config = { proxy: 'http://proxy-a.test:8080', proxyHosts: ['api.example.com'] }
  const transport = createVisionProviderTransport({
    config: () => config,
    fetchImpl: async (input, init) => selectedDispatcher(init.dispatcher, input),
    importUndici: () => new Promise((resolve, reject) => imports.push({ resolve, reject })),
  })

  const firstA = transport.fetch('https://api.example.com/a')
  config = { ...config, proxy: 'http://proxy-b.test:8080' }
  const requestB = transport.fetch('https://api.example.com/b')
  config = { ...config, proxy: 'http://proxy-a.test:8080' }
  const secondA = transport.fetch('https://api.example.com/a2')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(imports.length, 3)

  imports[0].reject(new Error('stale A failed'))
  await assert.rejects(firstA, /stale A failed/)

  const reusedA = transport.fetch('https://api.example.com/a3')
  assert.equal(imports.length, 3, 'stale A rejection must not evict the newer A promise')

  imports[2].resolve(fakeUndiciModule(FakeProxyAgent))
  const [a2, a3] = await Promise.all([secondA, reusedA])
  assert.equal(a2, a3)
  assert.equal(a2.url, 'http://proxy-a.test:8080')

  imports[1].resolve(fakeUndiciModule(FakeProxyAgent))
  const b = await requestB
  assert.equal(b.url, 'http://proxy-b.test:8080')
})

test('hot proxy replacement retires the old dispatcher only after its in-flight request releases the lease', async () => {
  const agents = []
  let releaseA
  let enteredA
  const enteredAPromise = new Promise((resolve) => { enteredA = resolve })
  const aBarrier = new Promise((resolve) => { releaseA = resolve })
  class FakeProxyAgent {
    constructor(url) {
      this.url = url
      this.closed = 0
      agents.push(this)
    }
    async close() { this.closed += 1 }
  }
  let config = { proxy: 'http://proxy-a.test:8080', proxyHosts: ['api.example.com'] }
  const transport = createVisionProviderTransport({
    config: () => config,
    fetchImpl: async (input, init) => {
      if (String(input).endsWith('/a')) {
        enteredA()
        await aBarrier
      }
      return selectedDispatcher(init.dispatcher, input) ?? 'direct'
    },
    importUndici: async () => fakeUndiciModule(FakeProxyAgent),
  })

  const requestA = transport.fetch('https://api.example.com/a')
  await enteredAPromise
  assert.equal(agents.length, 1)
  assert.equal(agents[0].closed, 0)

  config = { ...config, proxy: 'http://proxy-b.test:8080' }
  const dispatcherB = await transport.fetch('https://api.example.com/b')
  assert.equal(agents.length, 2)
  assert.equal(dispatcherB, agents[1])
  assert.equal(agents[0].closed, 0, 'replacement must not close a dispatcher that still owns an in-flight request')

  releaseA()
  assert.equal(await requestA, agents[0])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(agents[0].closed, 1)
  assert.equal(agents[1].closed, 0)

  await transport.dispose()
  assert.equal(agents[1].closed, 1)
})

test('clearing the live proxy retires an idle cached dispatcher without importing a replacement', async () => {
  const agents = []
  let imports = 0
  class FakeProxyAgent {
    constructor(url) {
      this.url = url
      this.closed = 0
      agents.push(this)
    }
    async close() { this.closed += 1 }
  }
  let config = { proxy: 'http://proxy-a.test:8080', proxyHosts: ['api.example.com'] }
  const calls = []
  const transport = createVisionProviderTransport({
    config: () => config,
    fetchImpl: async (input, init) => { calls.push(selectedDispatcher(init.dispatcher, input)); return okOpenAI() },
    importUndici: async () => { imports += 1; return fakeUndiciModule(FakeProxyAgent) },
  })

  await transport.fetch('https://api.example.com/first')
  assert.equal(imports, 1)
  config = { ...config, proxy: '' }
  await transport.fetch('https://api.example.com/direct')
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(imports, 1, 'clearing proxy must preserve the no-new-Undici path')
  assert.equal(calls[1], undefined)
  assert.equal(agents[0].closed, 1)
  await transport.dispose()
})

test('dispose during pending ProxyAgent construction lets the admitted request finish and closes the late dispatcher', async () => {
  let resolveImport
  const importGate = new Promise((resolve) => { resolveImport = resolve })
  const calls = []
  class FakeProxyAgent {
    constructor(url) {
      this.url = url
      this.closed = 0
    }
    async close() { this.closed += 1 }
  }
  const transport = createVisionProviderTransport({
    config: { proxy: 'http://proxy-a.test:8080', proxyHosts: ['api.example.com'] },
    fetchImpl: async (input, init) => { calls.push(selectedDispatcher(init.dispatcher, input)); return okOpenAI() },
    importUndici: () => importGate,
  })
  const release = installVisionProviderTransport(transport)
  const request = transport.fetch('https://api.example.com/pending')
  release()
  const disposal = transport.dispose()

  resolveImport(fakeUndiciModule(FakeProxyAgent))
  await request
  await disposal
  assert.equal(calls.length, 1)
  assert.ok(calls[0] instanceof FakeProxyAgent)
  assert.equal(calls[0].closed, 1)

  await transport.fetch('https://api.example.com/after-dispose')
  assert.equal(calls[1], undefined, 'a stale released transport must not keep injecting the plugin proxy')
})

test('synchronous Undici loader failure does not poison lifecycle disposal or a later retry', async () => {
  let attempts = 0
  class FakeProxyAgent {
    constructor(url) { this.url = url; this.closed = 0 }
    async close() { this.closed += 1 }
  }
  const transport = createVisionProviderTransport({
    config: { proxy: 'http://proxy-a.test:8080', proxyHosts: ['api.example.com'] },
    fetchImpl: async (input, init) => selectedDispatcher(init.dispatcher, input),
    importUndici: () => {
      attempts += 1
      if (attempts === 1) throw new Error('sync loader failed')
      return fakeUndiciModule(FakeProxyAgent)
    },
  })

  await assert.rejects(transport.fetch('https://api.example.com/one'), /sync loader failed/)
  const dispatcher = await transport.fetch('https://api.example.com/two')
  assert.ok(dispatcher instanceof FakeProxyAgent)
  assert.equal(attempts, 2)
  await transport.dispose()
  assert.equal(dispatcher.closed, 1)
})

test('settings copy recommends native socks5 while documenting legacy socks5h compatibility', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /或 socks5:\/\/127\.0\.0\.1:10808；兼容旧配置 socks5h:\/\//)
  assert.match(source, /or socks5:\/\/127\.0\.0\.1:10808; legacy socks5h:\/\/ values are supported/)
  assert.doesNotMatch(source, /或 socks5h:\/\/127\.0\.0\.1:10808/)
  assert.doesNotMatch(source, /or socks5h:\/\/127\.0\.0\.1:10808/)
})
