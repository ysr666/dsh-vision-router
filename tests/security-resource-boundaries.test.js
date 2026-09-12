import test from 'node:test'
import assert from 'node:assert/strict'

import {
  WEB_ROUTE_REMOTE_CAPABILITY,
  installLocalMutationRouteBoundary,
  isLocalMutationRoute,
  webRouteRemoteCapability,
} from '../lib/web-capability-boundary.js'
import {
  MAX_RUNTIME_COMPLEX_FIELD_BYTES,
  MAX_RUNTIME_EXTRA_VISION_MODELS,
  MAX_RUNTIME_GUIDANCE_CHARS,
  MAX_RUNTIME_WRAPPED_MODELS_PER_PROVIDER,
  MAX_RUNTIME_WRAPPED_PROVIDER_ROWS,
  normalizeRuntimeVisionConfig,
  runtimeConfigFieldBudgetError,
} from '../lib/runtime-config-normalizer.js'
import {
  REMOTE_SETTINGS_PERMISSION,
  createVisionRouterRemoteSettingsHandler,
} from '../lib/remote-settings-bridge.js'

function responseRecorder() {
  const state = { status: undefined, body: '' }
  return {
    state,
    response: {
      writeHead(status) {
        state.status = status
        return this
      },
      setHeader() {},
      removeHeader() {},
      end(body = '') {
        state.body += body == null ? '' : String(body)
        return this
      },
    },
  }
}

function registerRoute(path, method = 'GET') {
  let route
  let calls = 0
  const disposers = []
  const webServer = {
    register(value) {
      route = value
      return () => { route = undefined }
    },
  }
  const connection = { requestRejection: () => undefined }
  const root = {
    get(name) {
      if (name === 'connection') return connection
      if (name === 'webServer') return webServer
      return undefined
    },
    effect(setup) {
      const dispose = setup()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    inject(_deps, callback) {
      return callback({
        webServer,
        get: root.get.bind(root),
        effect: root.effect.bind(root),
      })
    },
  }

  const wrapped = installLocalMutationRouteBoundary(root)
  wrapped.inject(['webServer'], (ctx) => ctx.webServer.register({
    kind: 'exact',
    path,
    handler(req, res) {
      calls += 1
      assert.equal(req.method, method)
      res.writeHead(200)
      res.end('ok')
    },
  }))

  return {
    route: () => route,
    calls: () => calls,
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
}

function request({ remoteAddress, host, method = 'GET' }) {
  return {
    method,
    headers: { host },
    socket: { remoteAddress },
  }
}

test('web route capability policy classifies side-effecting GET without changing legacy mutation semantics', () => {
  assert.equal(
    webRouteRemoteCapability('/_dsh/vision-router/test-connection', 'GET'),
    WEB_ROUTE_REMOTE_CAPABILITY.LOCAL_ONLY,
  )
  assert.equal(isLocalMutationRoute('/_dsh/vision-router/test-connection', 'GET'), false)
  assert.equal(
    webRouteRemoteCapability('/_dsh/vision-router/self-update', 'POST'),
    WEB_ROUTE_REMOTE_CAPABILITY.LOCAL_ONLY,
  )
  assert.equal(isLocalMutationRoute('/_dsh/vision-router/self-update', 'POST'), true)
  assert.equal(
    webRouteRemoteCapability('/_dsh/vision-router/logs', 'GET'),
    WEB_ROUTE_REMOTE_CAPABILITY.REDACT_REMOTE,
  )
  assert.equal(
    webRouteRemoteCapability('/_dsh/vision-router/live-models', 'GET'),
    WEB_ROUTE_REMOTE_CAPABILITY.ALLOW_REMOTE,
  )
  assert.equal(
    webRouteRemoteCapability('/_dsh/vision-router/capability-runtime', 'GET'),
    WEB_ROUTE_REMOTE_CAPABILITY.ALLOW_REMOTE,
  )
  assert.equal(
    webRouteRemoteCapability('/_dsh/vision-router/capability-runtime', 'POST'),
    WEB_ROUTE_REMOTE_CAPABILITY.LOCAL_ONLY,
  )
  assert.equal(
    webRouteRemoteCapability('/_dsh/vision-router/product-state', 'GET'),
    WEB_ROUTE_REMOTE_CAPABILITY.LOCAL_ONLY,
    'undeclared DVR routes must fail closed',
  )
})

test('authenticated test-connection requires both loopback peer and local Host', () => {
  const mounted = registerRoute('/_dsh/vision-router/test-connection')
  try {
    for (const sample of [
      { remoteAddress: '127.0.0.1', host: 'router.example.com', expected: 403 },
      { remoteAddress: '192.168.1.20', host: 'localhost:3000', expected: 403 },
      { remoteAddress: '127.0.0.1', host: 'localhost:3000', expected: 200 },
    ]) {
      const { response, state } = responseRecorder()
      mounted.route().handler(request(sample), response)
      assert.equal(state.status, sample.expected, JSON.stringify(sample))
    }
    assert.equal(mounted.calls(), 1, 'only the genuinely local request may reach the probe handler')
  } finally {
    mounted.dispose()
  }
})

test('runtime normalization bounds complex model lists without broadening malformed wrapper scope', () => {
  const raw = {
    extraVisionModels: Array.from({ length: MAX_RUNTIME_EXTRA_VISION_MODELS + 5000 }, (_, index) => `vision-${index}`),
    wrappedProviders: Array.from({ length: MAX_RUNTIME_WRAPPED_PROVIDER_ROWS + 100 }, (_, row) => ({
      provider: `provider-${row}`,
      models: Array.from({ length: MAX_RUNTIME_WRAPPED_MODELS_PER_PROVIDER + 100 }, (_, model) => `model-${row}-${model}`),
    })),
  }
  raw.wrappedProviders.unshift({ provider: 'malformed', models: { not: 'an array' } })

  raw.wrappedProviders[1].padding = 'legacy-ignored-field'
  raw.providers = [{ provider: 'p', model: 'm', fallbacks: [], padding: 'legacy-ignored-field' }]

  const normalized = normalizeRuntimeVisionConfig(raw)
  assert.equal(normalized.extraVisionModels.length, MAX_RUNTIME_EXTRA_VISION_MODELS)
  assert.equal(normalized.extraVisionModels[0], 'vision-0')
  assert.ok(normalized.wrappedProviders.length <= MAX_RUNTIME_WRAPPED_PROVIDER_ROWS)
  assert.equal(normalized.wrappedProviders.some((entry) => entry.provider === 'malformed'), false)
  assert.ok(normalized.wrappedProviders.every((entry) => entry.models.length <= MAX_RUNTIME_WRAPPED_MODELS_PER_PROVIDER))
  assert.equal(Object.hasOwn(normalized.wrappedProviders[0], 'padding'), false)
  assert.deepEqual(normalized.providers, [{ provider: 'p', model: 'm', fallbacks: [] }])

  const explicitAll = normalizeRuntimeVisionConfig({
    wrappedProviders: [{ provider: 'intentional-all', models: [] }],
  })
  assert.deepEqual(explicitAll.wrappedProviders, [{ provider: 'intentional-all', models: [] }])
})

test('resource budget helper rejects count, identifier and UTF-8 byte amplification at admission time', () => {
  assert.match(
    runtimeConfigFieldBudgetError(
      'extraVisionModels',
      Array.from({ length: MAX_RUNTIME_EXTRA_VISION_MODELS + 1 }, (_, index) => `model-${index}`),
    ),
    /at most/,
  )
  assert.match(
    runtimeConfigFieldBudgetError('wrappedProviders', [{
      provider: 'p',
      models: Array.from({ length: MAX_RUNTIME_WRAPPED_MODELS_PER_PROVIDER + 1 }, (_, index) => `m-${index}`),
    }]),
    /at most/,
  )

  const unicode = '界'.repeat(512)
  const byteAmplified = Array.from({ length: MAX_RUNTIME_EXTRA_VISION_MODELS }, (_, index) => `${unicode.slice(0, 508)}${String(index).padStart(4, '0')}`)
  assert.ok(Buffer.byteLength(byteAmplified.join(''), 'utf8') > MAX_RUNTIME_COMPLEX_FIELD_BYTES)
  assert.match(runtimeConfigFieldBudgetError('extraVisionModels', byteAmplified), /byte runtime budget/)
})

function remoteSettingsFixture() {
  const value = {
    [REMOTE_SETTINGS_PERMISSION]: true,
    extraVisionModels: [],
    wrappedProviders: [],
    providers: [],
    guidanceOverrides: [],
    textProvider: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    routing: false,
  }
  const calls = []
  const settings = {
    writable: true,
    describe() {
      return [{
        ns: 'vision-router',
        value: structuredClone(value),
        base: structuredClone(value),
        user: structuredClone(value),
        revision: 4,
        applies: 'live',
      }]
    },
    async mutate(ns, ops, revision) {
      calls.push([ns, structuredClone(ops), revision])
      const op = ops[0]
      if (op.op === 'set') value[op.path[0]] = structuredClone(op.value)
      else delete value[op.path[0]]
    },
  }
  return { settings, calls }
}


test('remote admission rejects whole-value amplification and unknown nested payloads', async () => {
  for (const [field, value, expected] of [
    ['wrappedProviders', [{ provider: 'p', models: ['m'], padding: 'x'.repeat(5 * 1024 * 1024) }], /remote settings strings|admission budget|only provider and models/],
    ['providers', [{ provider: 'p', model: 'm', fallbacks: [], padding: 'x'.repeat(1_000) }], /only provider, model and fallbacks/],
    ['guidanceOverrides', [{ kind: 'document', text: 'x'.repeat(MAX_RUNTIME_GUIDANCE_CHARS + 1) }], /guidanceOverrides text/],
    ['textProvider', { provider: 'p', model: 'm', padding: 'x' }, /textProvider may contain only/],
  ]) {
    const fixture = remoteSettingsFixture()
    const result = await createVisionRouterRemoteSettingsHandler(fixture.settings)('mutate', {
      expectedRevision: 4,
      ops: [{ op: 'set', path: [field], value }],
    })
    assert.equal(result.ok, false, field)
    assert.match(result.error.message, expected, field)
    assert.equal(fixture.calls.length, 0, `${field} must fail before settings.mutate`)
  }
})

test('remote bridge rejects oversized complex settings before settings.mutate while accepting bounded values', async () => {
  const oversized = remoteSettingsFixture()
  const oversizedHandler = createVisionRouterRemoteSettingsHandler(oversized.settings)
  const denied = await oversizedHandler('mutate', {
    expectedRevision: 4,
    ops: [{
      op: 'set',
      path: ['extraVisionModels'],
      value: Array.from({ length: MAX_RUNTIME_EXTRA_VISION_MODELS + 1 }, (_, index) => `model-${index}`),
    }],
  })
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'bad-request')
  assert.equal(oversized.calls.length, 0)

  const bounded = remoteSettingsFixture()
  const boundedHandler = createVisionRouterRemoteSettingsHandler(bounded.settings)
  const accepted = await boundedHandler('mutate', {
    expectedRevision: 4,
    ops: [{
      op: 'set',
      path: ['wrappedProviders'],
      value: Array.from({ length: MAX_RUNTIME_WRAPPED_PROVIDER_ROWS }, (_, index) => ({
        provider: `provider-${index}`,
        models: [`model-${index}`],
      })),
    }],
  })
  assert.equal(accepted.ok, true)
  assert.equal(bounded.calls.length, 1)
})
