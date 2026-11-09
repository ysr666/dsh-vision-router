import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  providersOf,
  httpProvidersOf,
  orderedHttpProviders,
  localOllamaProvidersOf,
  localLmStudioProvidersOf,
  localOnlyVisionEnabled,
  isLoopbackVisionBaseURL,
} from '../index.js'
import { configuredVisionAdapterModels } from '../lib/replay-delegation.js'
import { configuredVisionPairs } from '../lib/vision-routing-evidence.js'
import { createVisionRouterRemoteSettingsHandler } from '../lib/remote-settings-bridge.js'

const cloudHttp = {
  name: 'cloud',
  baseURL: 'https://vision.example/v1',
  model: 'remote-vlm',
  apiKeyEnv: 'CLOUD_KEY',
}
const localHttp = {
  name: 'local-http',
  baseURL: 'http://127.0.0.2:9000/v1',
  model: 'local-vlm',
  apiKeyEnv: '',
}

test('local-only policy recognizes only loopback HTTP endpoints', () => {
  assert.equal(localOnlyVisionEnabled({ localOnlyVision: true }), true)
  assert.equal(isLoopbackVisionBaseURL('http://localhost:11434/v1'), true)
  assert.equal(isLoopbackVisionBaseURL('http://127.9.8.7:1234/v1'), true)
  assert.equal(isLoopbackVisionBaseURL('http://[::1]:1234/v1'), true)
  assert.equal(isLoopbackVisionBaseURL('http://192.168.1.2:1234/v1'), false)
  assert.equal(isLoopbackVisionBaseURL('https://vision.example/v1'), false)
})

test('local-only policy blocks cloud/native rows and OVH even when free-cloud-first is enabled', () => {
  const config = {
    localOnlyVision: true,
    freeFallback: true,
    freeCloudFirst: true,
    providers: [
      { provider: 'openrouter', model: 'cloud-vlm', fallbacks: [] },
      { provider: 'vision-http', model: 'cloud/remote-vlm', fallbacks: ['local-http/local-vlm'] },
    ],
    httpProviders: [cloudHttp, localHttp],
  }
  assert.deepEqual(providersOf(config), [{ provider: 'vision-http', model: 'local-http/local-vlm' }])
  assert.deepEqual(httpProvidersOf(config), [localHttp])
  assert.deepEqual(orderedHttpProviders(config, true), [localHttp])
  assert.equal(orderedHttpProviders(config, true).some((p) => /ovh/i.test(p.name)), false)
  assert.equal(configuredVisionAdapterModels(config).size, 0)
  assert.deepEqual(configuredVisionPairs(config), [])
})

test('local-only policy rejects mispointed local backend cards', () => {
  const ollama = localOllamaProvidersOf({
    localOnlyVision: true,
    localOllama: { enabled: true, baseURL: 'http://10.0.0.8:11434/v1', model: 'qwen-vl' },
  })
  const lmStudio = localLmStudioProvidersOf({
    localOnlyVision: true,
    localLmStudio: { enabled: true, baseURL: 'https://remote.example/v1', model: 'vlm' },
  })
  assert.deepEqual(ollama, [])
  assert.deepEqual(lmStudio, [])
})

test('local-only privacy control remains an effective runtime restriction but can be edited after remote risk acknowledgement', async () => {
  let revision = 0
  const value = { allowRemoteSettings: true, localOnlyVision: true }
  const user = { allowRemoteSettings: true }
  const handler = createVisionRouterRemoteSettingsHandler({
    writable: true,
    describe() {
      return [{ ns: 'vision-router', value: structuredClone(value), user: structuredClone(user), revision }]
    },
    async mutate(ns, ops, expectedRevision) {
      assert.equal(ns, 'vision-router')
      assert.equal(expectedRevision, revision)
      value.localOnlyVision = ops[0].value
      user.localOnlyVision = ops[0].value
      revision += 1
    },
  })
  assert.equal((await handler('describe', {})).value.view.value.localOnlyVision, true)
  const result = await handler('mutate', {
    ops: [{ op: 'set', path: ['localOnlyVision'], value: false }], expectedRevision: revision,
  })
  assert.equal(result.ok, true)
  assert.equal(value.localOnlyVision, false)
  assert.equal(result.value.view.value.localOnlyVision, false)
  assert.equal(localOnlyVisionEnabled(value), false)
})

test('Settings UI exposes the productized local-only control and disables OVH while active', async () => {
  const source = await readFile(new URL('../lib/settings-ia-client-prelude.js', import.meta.url), 'utf8')
  assert.match(source, /localOnlyVision/)
  assert.match(source, /Local-only vision/)
  assert.match(source, /runtime-blocked while Local-only vision is enabled/)
  assert.match(source, /Remote changes also affect the Host image-data flow/)
  assert.match(source, /Result text may still go to a cloud chat model/)
  assert.match(source, /Results may still go to a cloud chat model/)
  assert.match(source, /Vision result destination/)
})

test('direct HTTP fallback loops re-check local-only policy immediately before execution', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  const guards = source.match(/localOnlyVisionEnabled\(current\(\)\) && !isLoopbackVisionBaseURL\(provider\?\.baseURL\)/g) ?? []
  assert.equal(guards.length, 2)
})
