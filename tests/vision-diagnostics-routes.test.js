import test from 'node:test'
import assert from 'node:assert/strict'
import {
  installVisionDiagnosticsRoutes,
  VISION_MODEL_CAPABILITIES_PATH,
  VISION_TEST_CONNECTION_PATH,
} from '../lib/vision-diagnostics-routes.js'

function responseCapture() {
  const out = { status: undefined, headers: {}, body: undefined }
  return {
    out,
    setHeader(name, value) { out.headers[String(name).toLowerCase()] = value },
    writeHead(status, headers = {}) {
      out.status = status
      for (const [name, value] of Object.entries(headers)) out.headers[String(name).toLowerCase()] = value
    },
    end(body) { out.body = body },
  }
}

function jsonFetchResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body) },
  }
}

function install(overrides = {}) {
  const routes = new Map()
  const llm = overrides.llm ?? {
    registration() { throw new Error('missing adapter') },
    async resolveModelInfo() { throw new Error('missing model') },
  }
  const webCtx = {
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {}
      },
    },
    effect(factory) { return factory() },
  }
  const ctx = {
    llm,
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['webServer'])
      callback(webCtx)
    },
  }

  installVisionDiagnosticsRoutes(ctx, {
    connection: {
      candidatePairs: () => [],
      localBackends: () => [],
      httpBackends: () => [],
      resolveCapability: async () => ({ attemptable: true }),
      httpRoute: 'vision-http',
      ...overrides.connection,
    },
    capabilities: {
      collect: async () => ({}),
      builtinFallback: [],
      ...overrides.capabilities,
    },
    ownership: {
      hostOwnsOfficialDeepSeek: false,
      stealthConfigured: false,
      ...overrides.ownership,
    },
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  })

  return { routes, llm }
}

test('diagnostics owner registers both exact GET-only routes', async () => {
  const { routes } = install()
  assert.deepEqual([...routes.keys()].sort(), [
    VISION_MODEL_CAPABILITIES_PATH,
    VISION_TEST_CONNECTION_PATH,
  ].sort())

  for (const route of routes.values()) {
    assert.equal(route.kind, 'exact')
    const res = responseCapture()
    await route.handler({ method: 'POST' }, res)
    assert.equal(res.out.status, 405)
    assert.equal(res.out.headers.allow, 'GET')
  }
})

test('connection diagnostics probe configured local backends before Host metadata fallback', async () => {
  const fetches = []
  let metadataCalls = 0
  const { routes } = install({
    llm: {
      registration() { return {} },
      async resolveModelInfo() { metadataCalls += 1; return {} },
    },
    connection: {
      candidatePairs: () => [{ provider: 'native', model: 'cloud-model' }],
      localBackends: () => [{
        name: 'local-ollama',
        model: 'qwen-vl',
        baseURL: 'http://127.0.0.1:11434/v1',
      }],
      resolveCapability: async () => ({ attemptable: true }),
    },
    ownership: { hostOwnsOfficialDeepSeek: true, stealthConfigured: true },
    fetchImpl: async (url) => {
      fetches.push(String(url))
      return jsonFetchResponse({ data: [{ id: 'qwen-vl' }] })
    },
  })

  const res = responseCapture()
  await routes.get(VISION_TEST_CONNECTION_PATH).handler({ method: 'GET' }, res)
  const body = JSON.parse(res.out.body)
  assert.equal(res.out.status, 200)
  assert.deepEqual(fetches, ['http://127.0.0.1:11434/v1/models'])
  assert.equal(metadataCalls, 0)
  assert.equal(body.endpoint, 'http://127.0.0.1:11434/v1')
  assert.equal(body.models, 1)
  assert.deepEqual(body.stealth, {
    configured: true,
    active: false,
    hostOwned: true,
  })
})

test('connection diagnostics fall back to Host model metadata without network traffic', async () => {
  const metadata = []
  const { routes } = install({
    llm: {
      registration(provider) {
        if (provider === 'deepseek-official') throw new Error('official route unavailable')
        return {}
      },
      async resolveModelInfo(provider, model) {
        metadata.push([provider, model])
        return { id: model }
      },
    },
    connection: {
      candidatePairs: () => [{ provider: 'native-vision', model: 'vision-1' }],
      resolveCapability: async () => ({ attemptable: true }),
    },
    ownership: { hostOwnsOfficialDeepSeek: true, stealthConfigured: false },
    fetchImpl: async () => { throw new Error('network must not run') },
  })

  const res = responseCapture()
  await routes.get(VISION_TEST_CONNECTION_PATH).handler({ method: 'GET' }, res)
  const body = JSON.parse(res.out.body)
  assert.equal(res.out.status, 200)
  assert.deepEqual(metadata, [['native-vision', 'vision-1']])
  assert.match(body.detail, /native-vision\/vision-1 metadata resolved/)
  assert.deepEqual(body.stealth, {
    configured: false,
    active: false,
    reason: 'host-owned-official-unavailable',
    hostOwned: true,
  })
})

test('model capability diagnostics publish the supplied bounded product snapshot', async () => {
  const { routes } = install({
    capabilities: {
      collect: async () => ({
        native: { 'vision-1': { image: true, attemptable: true } },
      }),
      builtinFallback: [{ id: 'ovh/model', model: 'model' }],
    },
  })

  const res = responseCapture()
  await routes.get(VISION_MODEL_CAPABILITIES_PATH).handler({ method: 'GET' }, res)
  assert.equal(res.out.status, 200)
  assert.deepEqual(JSON.parse(res.out.body), {
    capabilities: {
      native: { 'vision-1': { image: true, attemptable: true } },
    },
    builtinFallback: [{ id: 'ovh/model', model: 'model' }],
    anonymousRpmPerModel: 2,
  })
})

test('model capability diagnostics contain collector failures', async () => {
  const { routes } = install({
    capabilities: {
      collect: async () => { throw new Error('catalog unavailable') },
    },
  })

  const res = responseCapture()
  await routes.get(VISION_MODEL_CAPABILITIES_PATH).handler({ method: 'GET' }, res)
  assert.equal(res.out.status, 500)
  assert.deepEqual(JSON.parse(res.out.body), {
    capabilities: {},
    error: 'catalog unavailable',
  })
})
