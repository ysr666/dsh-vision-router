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

test('capability benchmark client is scoped only to the actual Vision Router model chain', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /\/_dsh\/vision-router\/capability-benchmark/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /var CHAIN_ROOT = '#vr-vision-backend-chain'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /var ROW_SELECTOR = CHAIN_ROOT \+ ' \.vr-chain-row'/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /document\.querySelectorAll\('\.vr-chain-row'\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /method:\s*'POST'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /JSON\.stringify\(\{ key: candidate\.key \}\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /测试能力/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /Test capabilities/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /fallback is disabled/)
})

test('incomplete provider/model selection removes the benchmark control instead of showing a dead button', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /function completeSelection\(selected\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /selected\.model !== MANUAL_MODEL_ID/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /if \(!completeSelection\(selected\)\) \{\s*removeControl\(row\);\s*return;/)
})

test('capability result occupies a second flex line and does not squeeze provider/model selectors', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /row\.style\.flexWrap = 'wrap'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /control\.style\.flex = '1 0 100%'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /control\.style\.width = '100%'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /control\.appendChild\(status\);\s*control\.appendChild\(button\)/)
})

test('capability UI observer ignores unrelated streaming DOM mutations', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /function nodeTouchesChain\(node\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /node\.matches\(CHAIN_ROOT\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /node\.matches\(ROW_SELECTOR\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /node\.closest\(CHAIN_ROOT\)/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /new MutationObserver\(function\(\)\{ scheduleScan\(false\); \}\)/)
})

test('capability benchmark client never mutates Vision Router settings', () => {
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /settings\.mutate/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /allowRemoteSettings/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /settings\/document-updated/)
})
