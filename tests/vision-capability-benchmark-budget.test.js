import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createExactCapabilityInvoker } from '../lib/vision-capability-benchmark-service.js'

const SERVICE_URL = new URL('../lib/vision-capability-benchmark-service.js', import.meta.url)

function fixture() {
  return { id: 'budget-fixture', intent: 'general', svg: '<svg/>', prompt: 'answer briefly' }
}

function visualProofHarness() {
  let challenge = ''
  return {
    renderFixture: async (value) => {
      challenge = value.visualProofChallenge
      return Buffer.from('png')
    },
    prove(text = 'ok') {
      assert.match(challenge, /^[A-Z0-9-]{6,32}$/)
      return `${text}\nVR-CODE:${challenge}`
    },
  }
}

function adapterCtx(onCall, prove) {
  return {
    get(name) {
      if (name === 'attachments') {
        return {
          async saveImage() {
            return { id: 'benchmark-image', mediaType: 'image/png' }
          },
        }
      }
      return undefined
    },
    llm: {
      stream(options) {
        onCall(options)
        return (async function* () {
          yield { text: prove('ok') }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
}

test('default Full deadline exceeds six per-fixture deadlines instead of timing out by construction', async () => {
  const source = await readFile(SERVICE_URL, 'utf8')
  const run = source.match(/const DEFAULT_RUN_TIMEOUT_MS = (\d+) \* 60 \* 1000/)
  const fixtureTimeout = source.match(/const DEFAULT_FIXTURE_TIMEOUT_MS = (\d+) \* 1000/)
  assert.ok(run)
  assert.ok(fixtureTimeout)
  const runMs = Number(run[1]) * 60 * 1000
  const fixtureMs = Number(fixtureTimeout[1]) * 1000
  assert.ok(runMs > 6 * fixtureMs, `Full deadline ${runMs}ms must exceed six fixture deadlines (${6 * fixtureMs}ms)`)
})

test('HTTP-direct Benchmark caps completion output at 512 tokens', async () => {
  const calls = []
  const proof = visualProofHarness()
  const backend = {
    name: 'cloud',
    model: 'vision-model',
    baseURL: 'https://example.test/v1',
    apiKeyEnv: '',
    maxTokens: 4096,
  }
  const core = {
    localProvidersOf: () => [],
    httpProvidersOf: () => [backend],
    callOpenAICompatible: async (_provider, _messages, options) => {
      calls.push(options)
      return proof.prove('ok')
    },
  }
  const invoke = createExactCapabilityInvoker({}, core, {
    provider: 'vision-http',
    model: 'cloud/vision-model',
  }, { httpProviders: [backend] }, {
    renderFixture: proof.renderFixture,
  })

  await invoke({
    backend: { fingerprint: 'ep2_test' },
    fixture: fixture(),
    exactBackend: true,
    allowFallback: false,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].maxTokens, 512)
})

test('DSH-adapter Benchmark caps completion output at 512 tokens', async () => {
  const calls = []
  const proof = visualProofHarness()
  const ctx = adapterCtx((options) => calls.push(options), proof.prove)
  const core = {
    localProvidersOf: () => [],
    httpProvidersOf: () => [],
  }
  const invoke = createExactCapabilityInvoker(ctx, core, {
    provider: 'adapter-x',
    model: 'vision-model',
    evidenceScope: 'adapter-route',
  }, {}, {
    renderFixture: proof.renderFixture,
  })

  await invoke({
    backend: { fingerprint: 'ep2_test' },
    fixture: fixture(),
    exactBackend: true,
    allowFallback: false,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].maxTokens, 512)
})
