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

test('one running benchmark disables every capability button and uses server runningKey after reload', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /var activeRunKey = ''/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /function runningKeyOf\(body\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /function syncRunningControls\(key\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /button\.disabled = state === 'running' \|\| !!activeRunKey/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /syncRunningControls\(runningKeyOf\(body\)\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /另一个识图模型正在测试，请等待完成/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /Another vision model is being tested; wait for it to finish/)
})

test('all-fixture failure is rendered as no evidence rather than a fake zero-score profile', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /CAPABILITY_BENCHMARK_NO_USABLE_EVIDENCE/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /未获得有效能力数据；该模型未接受测试图片或所有测试调用失败/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /No usable capability evidence; the model rejected test images or every test call failed/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /status\.title = detail \|\| message \|\| ''/)
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
