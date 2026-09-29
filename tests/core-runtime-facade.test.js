import test from 'node:test'
import assert from 'node:assert/strict'

import { createCoreRuntimeFacade } from '../lib/core-runtime-facade.js'

test('core runtime facade injects provider transport without mutating caller options or core exports', async () => {
  const seen = []
  const transport = { fetch() {} }
  const Config = {}
  const core = {
    Config,
    marker: 'core',
    async callOpenAICompatible(provider, messages, options) {
      seen.push(['openai', provider, messages, options])
      return 'openai'
    },
    async callLocalBackend(provider, messages, options) {
      seen.push(['local', provider, messages, options])
      return 'local'
    },
    apply(ctx, config, runtime) {
      seen.push(['apply', ctx, config, runtime])
      return 'applied'
    },
  }
  const facade = createCoreRuntimeFacade(core, { providerTransport: transport })
  const options = { signal: 'signal' }
  const runtime = { sessionVision: 'session' }

  assert.equal(await facade.callOpenAICompatible('p', ['m'], options), 'openai')
  assert.equal(await facade.callLocalBackend('p', ['m'], options), 'local')
  assert.equal(facade.apply('ctx', 'config', runtime), 'applied')
  assert.deepEqual(options, { signal: 'signal' })
  assert.deepEqual(runtime, { sessionVision: 'session' })
  assert.equal(facade.Config, Config)
  assert.equal(facade.marker, 'core')
  assert.equal(Object.hasOwn(core, 'providerTransport'), false)
  assert.equal(seen[0][3].transport, transport)
  assert.equal(seen[1][3].transport, transport)
  assert.equal(seen[2][3].providerTransport, transport)
  assert.equal(seen[2][3].sessionVision, 'session')
})

test('core runtime facade keeps direct callers transport-free when no runtime owner is supplied', async () => {
  let seenOptions
  const core = {
    async callOpenAICompatible(_provider, _messages, options) {
      seenOptions = options
      return 'ok'
    },
  }
  const facade = createCoreRuntimeFacade(core)
  await facade.callOpenAICompatible('p', [], { maxTokens: 1 })
  assert.deepEqual(seenOptions, { maxTokens: 1 })
})
