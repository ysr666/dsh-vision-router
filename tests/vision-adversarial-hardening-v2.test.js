import { test } from 'node:test'
import assert from 'node:assert/strict'
import { injectClientPresentationBoundary } from '../lib/client-presentation-boundary.js'
import { redactDiagnosticText } from '../lib/diagnostic-redaction.js'
import { htmlHasScriptMarker } from '../lib/html-script-marker.js'
import { injectLiveModelClientPrelude } from '../lib/live-model-client-prelude.js'
import { injectLocalPermissionClientPrelude } from '../lib/local-remote-settings-permission.js'
import { injectRemoteSettingsRiskConfirmationPrelude } from '../lib/remote-settings-risk-confirmation.js'
import { injectSettingsRc8ClientPrelude } from '../lib/settings-client-rc8-lifecycle.js'
import { injectCapabilityBenchmarkClient } from '../lib/vision-capability-benchmark-client.js'
import {
  hardenCapabilityBenchmarkFixture,
  verifyAndStripBenchmarkVisualProof,
  withHardDeadline,
} from '../lib/vision-capability-benchmark-hardening.js'
import {
  createCapabilityBenchmarkManager,
  createExactCapabilityInvoker,
} from '../lib/vision-capability-benchmark-service.js'
import {
  CAPABILITY_BENCHMARK_SUITE_REVISION,
  capabilityBenchmarkFixture,
  capabilityBenchmarkFingerprint,
} from '../lib/vision-capability-benchmark.js'
import { grantManualMeasurementFromUserAction } from '../lib/vision-routing-authority.js'
import { injectVisionRoutingDiagnosticsPrelude } from '../lib/vision-routing-preview-service.js'
import { injectVisionRoutingSettingsPrelude } from '../lib/vision-routing-settings-prelude.js'

const MANUAL_MEASUREMENT_AUTHORITY = grantManualMeasurementFromUserAction('local-ui')

const SCRIPT_INJECTORS = Object.freeze([
  ['presentation boundary', 'data-vision-router-presentation-boundary', injectClientPresentationBoundary],
  ['remote settings risk', 'data-vision-router-remote-settings-risk-confirmation', injectRemoteSettingsRiskConfirmationPrelude],
  ['live models', 'data-vision-router-live-models', injectLiveModelClientPrelude],
  ['rc8 settings lifecycle', 'data-vision-router-settings-rc8-lifecycle', injectSettingsRc8ClientPrelude],
  ['local settings permission', 'data-vision-router-local-settings-permission', injectLocalPermissionClientPrelude],
  ['capability benchmark', 'data-vision-router-capability-benchmark', injectCapabilityBenchmarkClient],
  ['routing settings', 'data-vision-router-routing-settings', injectVisionRoutingSettingsPrelude],
  ['routing diagnostics', 'data-vision-router-routing-diagnostics', injectVisionRoutingDiagnosticsPrelude],
])

function attachmentCtx(settings) {
  return {
    get(name) {
      if (name === 'settings') return { get: () => settings }
      if (name === 'attachments') {
        return { async saveImage() { return { id: 'proof-image' } } }
      }
      return undefined
    },
    llm: {
      listProviders: () => [],
      registration() { return { adapter: { constructor: { name: 'FakeAdapter' } } } },
      async resolveModelInfo() { return { inputModalities: ['text', 'image'] } },
    },
  }
}

function managerFixtures() {
  const local = {
    name: 'local-a', baseURL: 'http://127.0.0.1:11434/v1', model: 'vision-a', apiKeyEnv: '', maxTokens: 512,
  }
  const cloud = {
    name: 'cloud-b', baseURL: 'https://cloud.example.invalid/v1', model: 'vision-b', apiKeyEnv: 'B_KEY', maxTokens: 512,
  }
  const settings = {
    providers: [
      { provider: 'vision-http', model: 'local-a/vision-a', fallbacks: [] },
      { provider: 'vision-http', model: 'cloud-b/vision-b', fallbacks: [] },
    ],
    httpProviders: [cloud],
  }
  const core = {
    DEFAULT_HTTP_PROVIDERS: [],
    adapterAvailable: () => true,
    decideVisionBackendCapability: () => ({ image: true, attemptable: true }),
    localProvidersOf: () => [local],
    httpProvidersOf: () => [cloud],
  }
  return { local, cloud, settings, core }
}

function memoryStore() {
  const map = new Map()
  return {
    async get(key) { return map.get(key) },
    async put(record) { map.set(record.fingerprint, record); return record },
  }
}

function successfulResult(backend) {
  return {
    record: {
      fingerprint: capabilityBenchmarkFingerprint(backend),
      provider: backend.provider,
      model: backend.model,
      measuredAt: Date.now(),
      scores: { ocr: 0.8, general: 0.8 },
      fixtureCount: 3,
      failureCount: 0,
    },
    results: [],
  }
}

test('suite v5 structured fixture keeps evaluator answer tokens out of the model prompt', () => {
  assert.equal(CAPABILITY_BENCHMARK_SUITE_REVISION, 5)
  const fixture = capabilityBenchmarkFixture('structured')
  assert.deepEqual(fixture.expected.tokens, ['STATUS', 'READY', 'Queue', '3 jobs', 'Latency', '820 ms'])
  for (const token of fixture.expected.tokens) {
    assert.equal(fixture.prompt.includes(token), false, `structured prompt leaked evaluator token: ${token}`)
  }
})

test('suite v5 visual proof is benchmark metadata and an explicit sole output-format exception for every direct fixture family', () => {
  for (const intent of ['structured', 'ocr', 'grounding', 'document', 'general']) {
    const fixture = capabilityBenchmarkFixture(intent)
    const hardened = hardenCapabilityBenchmarkFixture(fixture, 'A1B2C3D4')
    assert.match(hardened.svg, /VR-CODE:A1B2C3D4/, `${intent} did not render the proof badge`)
    assert.match(hardened.svg, /<rect x="442" y="8" width="314" height="42"/)
    assert.match(hardened.svg, /<text x="456" y="36" font-family="ui-monospace,[^"]+" font-size="18"/)
    assert.doesNotMatch(hardened.prompt, /A1B2C3D4/, `${intent} leaked the random proof code into the prompt`)
    assert.match(hardened.prompt, /not part of the task content/i, `${intent} did not exclude proof metadata from the task body`)
    assert.match(hardened.prompt, /transcription order, all-visible-text, JSON-only, answer-only, or no-prose/i)
    assert.match(hardened.prompt, /sole exception to those output-format constraints/i)
    assert.match(hardened.prompt, /one final line exactly in the form VR-CODE:<code>/)
  }
  assert.match(capabilityBenchmarkFixture('ocr').prompt, /top-to-bottom order/i)
  assert.match(capabilityBenchmarkFixture('structured').prompt, /ONLY JSON/)
  assert.match(capabilityBenchmarkFixture('document').prompt, /ONLY JSON/)
})

test('script marker detector only accepts an exact attribute on a real script opening tag', () => {
  const marker = 'data-vision-router-marker-test'
  assert.equal(htmlHasScriptMarker(`<script type="text/x-demo > still-quoted" ${marker}></script>`, marker), true)
  assert.equal(htmlHasScriptMarker(`<SCRIPT ${marker}="1"></SCRIPT>`, marker), true)
  assert.equal(htmlHasScriptMarker(`<!-- <script ${marker}></script> -->`, marker), false)
  assert.equal(htmlHasScriptMarker(`<main>${marker}</main>`, marker), false)
  assert.equal(htmlHasScriptMarker(`<script>const decoy = '<script ${marker}>';</script>`, marker), false)
  assert.equal(htmlHasScriptMarker(`<script data-note="${marker}"></script>`, marker), false)
  assert.equal(htmlHasScriptMarker(`<script data-note="x > ${marker}"></script>`, marker), false)
  assert.equal(htmlHasScriptMarker(`<script ${marker}-extra></script>`, marker), false)
})

test('every browser injector ignores marker decoys and is idempotent only on a real script marker', () => {
  for (const [name, marker, inject] of SCRIPT_INJECTORS) {
    const decoys = [
      `<html><head></head><body>${marker}</body></html>`,
      `<html><head><!-- <script ${marker}></script> --></head><body></body></html>`,
      `<html><head><script>window.markerDecoy = '<script ${marker}>';</script></head><body></body></html>`,
      `<html><head><script data-note="${marker}"></script></head><body></body></html>`,
      `<html><head><script data-note="value > ${marker}"></script></head><body></body></html>`,
      `<html><head><script ${marker}-extra></script></head><body></body></html>`,
    ]
    for (const input of decoys) {
      const output = inject(input)
      assert.notEqual(output, input, `${name} treated a marker decoy as an injected script`)
      assert.equal(htmlHasScriptMarker(output, marker), true, `${name} did not inject its real script marker`)
      assert.equal(inject(output), output, `${name} did not become idempotent after real injection`)
    }

    const alreadyInjected = `<html><head><script type="text/x-demo > still-quoted" ${marker}></script></head><body></body></html>`
    assert.equal(inject(alreadyInjected), alreadyInjected, `${name} duplicated a real script marker`)
  }
})

test('scored benchmark fixture hides a per-run visual proof challenge from the prompt', () => {
  const fixture = capabilityBenchmarkFixture('general')
  const hardened = hardenCapabilityBenchmarkFixture(fixture, 'A1B2C3D4')
  assert.match(hardened.svg, /VR-CODE:A1B2C3D4/)
  assert.doesNotMatch(hardened.prompt, /A1B2C3D4/)
  assert.match(hardened.prompt, /VR-CODE:<code>/)
  assert.equal(
    verifyAndStripBenchmarkVisualProof('3 shapes: circle, square, triangle\nVR-CODE:A1B2C3D4', 'A1B2C3D4'),
    '3 shapes: circle, square, triangle',
  )
  assert.equal(
    verifyAndStripBenchmarkVisualProof('{"title":"Order Summary"}\nVR-CODE:A1B2C3D4', 'A1B2C3D4'),
    '{"title":"Order Summary"}',
  )
  assert.throws(
    () => verifyAndStripBenchmarkVisualProof('3 shapes: circle, square, triangle', 'A1B2C3D4'),
    (error) => error?.code === 'CAPABILITY_BENCHMARK_VISUAL_PROOF_FAILED',
  )
})

test('image-blind provider cannot turn a memorized static benchmark answer into capability evidence', async () => {
  const provider = {
    name: 'blind', baseURL: 'https://blind.example.invalid/v1', model: 'vision', apiKeyEnv: '', maxTokens: 512,
  }
  const fixture = capabilityBenchmarkFixture('general')
  const invoke = createExactCapabilityInvoker(attachmentCtx({ httpProviders: [provider] }), {
    localProvidersOf: () => [],
    httpProvidersOf: () => [provider],
  }, {
    provider: 'vision-http', model: 'blind/vision', endpoint: provider.baseURL,
  }, { httpProviders: [provider] }, {
    renderFixture: async () => Buffer.from('png'),
    // Perfect static answer, but this fake provider never inspected the image
    // and therefore cannot know the random proof badge.
    callDirect: async () => '3 shapes: circle, square, triangle',
  })
  const backend = {
    provider: 'vision-http', model: 'blind/vision', endpoint: provider.baseURL,
    config: { api: 'openai-completions' },
  }
  backend.fingerprint = capabilityBenchmarkFingerprint(backend)
  await assert.rejects(
    invoke({ backend, fixture, exactBackend: true, allowFallback: false }),
    (error) => error?.code === 'CAPABILITY_BENCHMARK_VISUAL_PROOF_FAILED',
  )
})

test('hard deadline rejects a non-cooperative promise that ignores AbortSignal', async () => {
  await assert.rejects(
    withHardDeadline(new Promise(() => {}), 25, 'hung benchmark'),
    (error) => error?.name === 'TimeoutError' && error?.code === 'CAPABILITY_BENCHMARK_TIMEOUT',
  )
})

test('diagnostic redaction removes bearer keys, sk keys, credentials and sensitive URL query values', () => {
  const secret = 'SECRET-SHOULD-NOT-LEAK-123456'
  const value = redactDiagnosticText(
    `Authorization: Bearer ${secret} api_key=${secret} ` +
    `https://user:${secret}@example.test/v1?token=${secret}&safe=ok sk-proj-${secret}`,
    1000,
  )
  assert.doesNotMatch(value, new RegExp(secret, 'g'))
  assert.match(value, /\[redacted\]/i)
  assert.match(value, /safe=ok/)
})

test('repeated queued cancel churn keeps benchmark job history bounded', async () => {
  const { settings, core } = managerFixtures()
  let releaseRunning
  const gate = new Promise((resolve) => { releaseRunning = resolve })
  let calls = 0
  const manager = createCapabilityBenchmarkManager(attachmentCtx(settings), settings, core, {
    store: memoryStore(),
    runBenchmark: async ({ backend }) => {
      calls += 1
      if (calls === 1) await gate
      return successfulResult(backend)
    },
  })

  await manager.enqueue('vision-http/local-a/vision-a', 'quick', false, MANUAL_MEASUREMENT_AUTHORITY)
  for (let i = 0; i < 200; i += 1) {
    const queued = await manager.enqueue('http:cloud-b/vision-b', 'quick', false, MANUAL_MEASUREMENT_AUTHORITY)
    assert.equal((await manager.cancel(queued.job.id)).cancelled, true)
  }
  const mid = await manager.snapshot()
  assert.equal(mid.jobs.filter((job) => job.state === 'running').length, 1)
  assert.ok(mid.jobs.filter((job) => job.state === 'cancelled').length <= 64)
  assert.ok(mid.jobs.length <= 65)

  releaseRunning()
  await manager.waitForIdle()
})
