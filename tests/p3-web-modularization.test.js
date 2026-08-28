import test from 'node:test'
import assert from 'node:assert/strict'

import {
  installVisionSettingsWebBoundary,
  installVisionWebIntegration,
} from '../lib/web/index.js'
import {
  createVisionProductStateSnapshot,
  projectVisionProductCandidate,
} from '../lib/web/product-state.js'
import {
  installVisionDiagnosticsPanel,
  VISION_PRODUCT_STATE_PATH,
} from '../lib/web/diagnostics-panel.js'

test('P3-C web composition preserves the legacy installer order and context identity', () => {
  const ctx = { marker: 'same-context' }
  const logger = { info() {} }
  const calls = []
  const installer = (name) => (value, arg) => {
    assert.equal(value, ctx)
    calls.push([name, arg])
    return value
  }
  const overrides = {
    settingsController: installer('settings-controller'),
    remoteSettings: installer('remote-settings'),
    modelPresentation: installer('model-presentation'),
    onboarding: installer('onboarding'),
    modelControls: installer('model-controls'),
    routingSection: installer('routing-section'),
    benchmarkPanel: installer('benchmark-panel'),
    diagnosticsPanel: installer('diagnostics-panel'),
  }

  assert.equal(installVisionSettingsWebBoundary(ctx, logger, overrides), ctx)
  assert.equal(installVisionWebIntegration(ctx, { installers: overrides, marker: 1 }), ctx)

  assert.deepEqual(calls.map(([name]) => name), [
    'settings-controller',
    'remote-settings',
    'model-presentation',
    'onboarding',
    'model-controls',
    'routing-section',
    'benchmark-panel',
    'diagnostics-panel',
  ])
  assert.equal(calls[1][1], logger)
  assert.equal(calls.at(-1)[1].marker, 1)
})

test('Host product projection owns benchmark, authority, health and capability semantics without leaking transport facts', async () => {
  const live = {
    routingMode: 'auto',
    routingPreference: 'balanced',
    backgroundBenchmarking: 'all',
    providers: [{ provider: 'vision-http', model: 'local-ollama/qwen-vl' }],
  }
  const ctx = {
    get(name) {
      if (name === 'settings') return { get: (namespace) => namespace === 'vision-router' ? live : undefined }
      return undefined
    },
  }
  const core = {
    localProvidersOf() {
      return [{
        name: 'local-ollama',
        model: 'qwen-vl',
        baseURL: 'http://127.0.0.1:11434/v1',
        apiKeyEnv: 'SECRET_REF_THAT_MUST_NOT_LEAK',
      }]
    },
    httpProvidersOf() { return [] },
    DEFAULT_HTTP_PROVIDERS: [],
  }
  const store = {
    async get() {
      return {
        scores: { ocr: 0.91 },
        measuredAt: 1_780_000_000_000,
      }
    },
  }

  const snapshot = await createVisionProductStateSnapshot({
    ctx,
    config: {},
    core,
    store,
    healthForCandidate: async () => ({ circuitOpen: true, rateLimited: true, reason: 'rate-limit', until: 123 }),
  })

  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.routingMode, 'auto')
  assert.equal(snapshot.currentAuthority.autoSelectionAuthorized, true)
  assert.equal(snapshot.currentAuthority.backgroundMeasurementActive, true)
  assert.equal(snapshot.candidates.length, 1)
  const candidate = snapshot.candidates[0]
  assert.equal(candidate.canBenchmark, true)
  assert.equal(candidate.benchmarkReason, null)
  assert.equal(candidate.healthClass, 'rate-limited')
  assert.equal(candidate.capabilityState, 'measured')
  assert.equal(candidate.backgroundEligible, true)
  assert.equal(Object.hasOwn(candidate, 'endpoint'), false)
  assert.equal(Object.hasOwn(candidate, 'endpointFingerprint'), false)
  assert.equal(Object.hasOwn(candidate, 'endpointCredentialRef'), false)
  assert.equal(JSON.stringify(snapshot).includes('SECRET_REF_THAT_MUST_NOT_LEAK'), false)
})

test('product projection gives deterministic reasons for unavailable and policy-excluded states', () => {
  const authority = {
    execution: 'ordered',
    autoSelectionAuthorized: false,
    backgroundMeasurement: 'local-free',
    backgroundMeasurementAuthorized: true,
    backgroundMeasurementActive: false,
  }
  const projected = projectVisionProductCandidate({
    key: 'cloud/model',
    provider: 'cloud',
    model: 'model',
    benchmarkable: false,
  }, undefined, authority)

  assert.equal(projected.canBenchmark, false)
  assert.equal(projected.benchmarkReason, 'stable-benchmark-identity-unavailable')
  assert.equal(projected.routingMode, 'ordered')
  assert.equal(projected.healthClass, 'unknown')
  assert.equal(projected.capabilityState, 'unavailable')
  assert.equal(projected.backgroundEligible, false)
  assert.equal(projected.backgroundReason, 'background-measurement-not-active')
})

function responseCapture() {
  const out = { status: undefined, headers: {}, body: undefined }
  return {
    out,
    setHeader(name, value) { out.headers[name.toLowerCase()] = value },
    writeHead(status, headers) { out.status = status; Object.assign(out.headers, headers) },
    end(body) { out.body = body },
  }
}

test('structured product-state endpoint is GET-only and redacts internal snapshot failures', async () => {
  let route
  const webCtx = {
    webServer: {
      register(value) { route = value; return () => {} },
    },
    effect(fn) { return fn() },
  }
  const ctx = {
    inject(deps, fn) {
      assert.deepEqual(deps, ['webServer'])
      fn(webCtx)
    },
  }

  installVisionDiagnosticsPanel(ctx, { snapshot: async () => ({ ok: true, candidates: [] }) })
  assert.equal(route.path, VISION_PRODUCT_STATE_PATH)

  const ok = responseCapture()
  await route.handler({ method: 'GET' }, ok)
  assert.equal(ok.out.status, 200)
  assert.deepEqual(JSON.parse(ok.out.body), { ok: true, candidates: [] })

  const denied = responseCapture()
  await route.handler({ method: 'POST' }, denied)
  assert.equal(denied.out.status, 405)
  assert.equal(denied.out.headers.allow, 'GET')

  installVisionDiagnosticsPanel(ctx, { snapshot: async () => { throw new Error('api-key=secret-value') } })
  const failed = responseCapture()
  await route.handler({ method: 'GET' }, failed)
  assert.equal(failed.out.status, 503)
  assert.deepEqual(JSON.parse(failed.out.body), {
    ok: false,
    code: 'VISION_PRODUCT_STATE_UNAVAILABLE',
  })
  assert.equal(String(failed.out.body).includes('secret-value'), false)
})
