import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPABILITY_BENCHMARK_CLIENT,
  injectCapabilityBenchmarkClient,
} from '../lib/vision-capability-benchmark-client.js'

test('capability benchmark client injects once into the document head', () => {
  const html = '<!doctype html><html><head><title>DSH</title></head><body></body></html>'
  const once = injectCapabilityBenchmarkClient(html)
  const twice = injectCapabilityBenchmarkClient(once)
  assert.match(once, /data-vision-router-capability-benchmark/)
  assert.equal(twice, once)
  assert.ok(once.indexOf('data-vision-router-capability-benchmark') < once.indexOf('<title>DSH</title>'))
})

test('capability benchmark client is scoped to Vision Router chain rows and exact benchmark endpoint', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /\/_dsh\/vision-router\/capability-benchmark/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /\.vr-chain-row/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /method:\s*'POST'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /JSON\.stringify\(\{ key: candidate\.key \}\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /测试能力/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /Test capabilities/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /fallback is disabled/)
})

test('capability benchmark client never mutates Vision Router settings', () => {
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /settings\.mutate/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /allowRemoteSettings/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /settings\/document-updated/)
})
