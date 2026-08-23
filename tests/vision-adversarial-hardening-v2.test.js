import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactDiagnosticText } from '../lib/diagnostic-redaction.js'
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
  capabilityBenchmarkFixture,
  capabilityBenchmarkFingerprint,
} from '../lib/vision-capability-benchmark.js'

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
  const started = Date.now()
  await assert.rejects(
    withHardDeadline(new Promise(() => {}), 25, 'hung benchmark'),
    (error) => error?.name === 'TimeoutError' && error?.code === 'CAPABILITY_BENCHMARK_TIMEOUT',
  )
  assert.ok(Date.now() - started < 1000)
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

  await manager.enqueue('vision-http/local-a/vision-a', 'quick')
  for (let i = 0; i < 200; i += 1) {
    const queued = await manager.enqueue('http:cloud-b/vision-b', 'quick')
    assert.equal((await manager.cancel(queued.job.id)).cancelled, true)
  }
  const mid = await manager.snapshot()
  assert.equal(mid.jobs.filter((job) => job.state === 'running').length, 1)
  assert.ok(mid.jobs.filter((job) => job.state === 'cancelled').length <= 64)
  assert.ok(mid.jobs.length <= 65)

  releaseRunning()
  await manager.waitForIdle()
})
