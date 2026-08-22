import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCapabilityBenchmarkManager } from '../lib/vision-capability-benchmark-service.js'

test('registered DeepSeek adapter is benchmarkable without exposing a synthetic route URL to the browser', async () => {
  const config = {
    providers: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', fallbacks: [] }],
  }
  const ctx = {
    get(name) {
      if (name === 'settings') {
        return {
          get(namespace) {
            if (namespace === 'vision-router') return config
            if (namespace === 'llm-pi-ai') return { providers: {} }
            return undefined
          },
        }
      }
      return undefined
    },
    llm: {
      listProviders: () => [],
      registration(provider) {
        assert.equal(provider, 'deepseek-official')
        return { adapter: { constructor: { name: 'DeepSeekAdapter' } } }
      },
      async resolveModelInfo(provider, model) {
        assert.equal(provider, 'deepseek-official')
        assert.equal(model, 'deepseek-v4-flash')
        return { inputModalities: ['text', 'image'] }
      },
    },
  }
  const core = {
    adapterAvailable: () => true,
    decideVisionBackendCapability: () => ({ image: true, attemptable: true }),
    localProvidersOf: () => [],
    httpProvidersOf: () => [],
  }
  const manager = createCapabilityBenchmarkManager(ctx, config, core, {
    store: { async get() { return undefined }, async put(record) { return record } },
  })

  const snapshot = await manager.snapshot()
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.candidates.length, 1)
  const candidate = snapshot.candidates[0]
  assert.equal(candidate.provider, 'deepseek-official')
  assert.equal(candidate.model, 'deepseek-v4-flash')
  assert.equal(candidate.benchmarkable, true)
  assert.equal(candidate.evidenceScope, 'adapter-route')
  assert.match(candidate.fingerprint, /^ep2_[0-9a-f]{32}$/)
  assert.equal(Object.prototype.hasOwnProperty.call(candidate, 'endpoint'), false)
})
