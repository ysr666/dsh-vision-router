import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderedHttpProviders, DEFAULT_HTTP_PROVIDERS } from '../index.js'

// freeCloudFirst：云端免费优先链（纯顺序变化，默认关）。
// 开时：内置 OVH 免费 5 模型在前（按内置表大→小稳定序），付费端点在后兜底。

const PAID = [
  { name: 'zhipu', baseURL: 'https://api.zhipu.test/v1', model: 'glm-4.6v', apiKeyEnv: 'ZHIPU_KEY' },
  { name: 'openrouter', baseURL: 'https://openrouter.test/v1', model: 'qwen2.5-vl', apiKeyEnv: 'OPENROUTER_KEY' },
]

test('freeCloudFirst: built-in free tier comes first, paid providers fall back behind it', () => {
  const config = { httpProviders: PAID }
  const ordered = orderedHttpProviders(config, true)
  const free = ordered.slice(0, DEFAULT_HTTP_PROVIDERS.length)
  const rest = ordered.slice(DEFAULT_HTTP_PROVIDERS.length)
  // Free tier first, exactly the built-in five, in the built-in order.
  assert.deepEqual(
    free.map((p) => `${p.name}/${p.model}`),
    DEFAULT_HTTP_PROVIDERS.map((p) => `${p.name}/${p.model}`),
  )
  assert.deepEqual(
    rest.map((p) => `${p.name}/${p.model}`),
    PAID.map((p) => `${p.name}/${p.model}`),
  )
  assert.equal(rest.every((p) => p.apiKeyEnv !== ''), true)
})

test('freeCloudFirst: manual OVH rows without a key join the free tier', () => {
  const manual = [
    { name: 'ovh', baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', model: 'Qwen3.5-397B-A17B', apiKeyEnv: '' },
  ]
  const ordered = orderedHttpProviders({ httpProviders: manual }, true)
  const ids = ordered.map((p) => `${p.name}/${p.model}`)
  // The manual free row appears once, inside the free block (dedupe by the
  // built-in table keeps a single entry), and nothing paid precedes it.
  assert.equal(ids.filter((id) => id === 'ovh/Qwen3.5-397B-A17B').length, 1)
  assert.equal(ids[0], 'ovh/Qwen3.5-397B-A17B')
})

test('freeCloudFirst: ordering is stable for the cache key (same config, same list)', () => {
  const config = { httpProviders: PAID }
  const a = orderedHttpProviders(config, true)
  const b = orderedHttpProviders(config, true)
  assert.deepEqual(a, b)
})

test('freeCloudFirst: paid rows with a key never shadow the built-in free entry', () => {
  // The free tier and the configured tier are built independently and deduped
  // by identity (endpoint/baseURL + model + credential): a keyed OVH row keeps
  // the built-in keyless entry first (the anonymous free flagship is still
  // tried) and rides behind it as a paid fallback.
  const paidOvh = [
    { name: 'ovh', baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', model: 'Qwen3.5-397B-A17B', apiKeyEnv: 'OVH_KEY' },
  ]
  const ordered = orderedHttpProviders({ httpProviders: paidOvh }, true)
  const ids = ordered.map((p) => `${p.name}/${p.model}`)
  assert.deepEqual(ids, [
    'ovh/Qwen3.5-397B-A17B',
    'ovh/Qwen2.5-VL-72B-Instruct',
    'ovh/Qwen3.6-27B',
    'ovh/Mistral-Small-3.2-24B-Instruct-2506',
    'ovh/Qwen3.5-9B',
    'ovh/Qwen3.5-397B-A17B',
  ])
  assert.equal(ordered[0].apiKeyEnv, '')
  assert.equal(ordered[5].apiKeyEnv, 'OVH_KEY')
})

test('freeCloudFirst: keyed row does not suppress the free tier when it matches a built-in model', () => {
  // Regression guard for the maintainer review: with a keyed OVH row present,
  // the free tier must stay complete (all five built-in keyless models) and
  // the keyed row must come after, never instead of, the keyless entry.
  const paidOvh = [
    { name: 'ovh', baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', model: 'Qwen3.5-397B-A17B', apiKeyEnv: 'OVH_KEY' },
    { name: 'zhipu', baseURL: 'https://api.zhipu.test/v1', model: 'glm-4.6v', apiKeyEnv: 'ZHIPU_KEY' },
  ]
  const ordered = orderedHttpProviders({ httpProviders: paidOvh }, true)
  const freeBlock = ordered.slice(0, DEFAULT_HTTP_PROVIDERS.length)
  assert.deepEqual(
    freeBlock.map((p) => `${p.name}/${p.model}`),
    DEFAULT_HTTP_PROVIDERS.map((p) => `${p.name}/${p.model}`),
  )
  assert.equal(freeBlock.every((p) => p.apiKeyEnv === ''), true)
  assert.equal(ordered[DEFAULT_HTTP_PROVIDERS.length].apiKeyEnv, 'OVH_KEY')
})
