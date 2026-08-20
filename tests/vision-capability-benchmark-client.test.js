import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPABILITY_BENCHMARK_CLIENT,
  injectCapabilityBenchmarkClient,
} from '../lib/vision-capability-benchmark-client.js'

test('capability benchmark client injects once into the document head', () => {
  const html = '<!doctype html><html><head><title>DSH</title></head><body></body></html>'
  const once = injectCapabilityBenchmarkClient(html)
  assert.match(once, /data-vision-router-capability-benchmark/)
  assert.equal(injectCapabilityBenchmarkClient(once), once)
})

test('client is scoped to the actual Vision Router model chain and never mutates settings', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /var CHAIN_ROOT = '#vr-vision-backend-chain'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /var ROW_SELECTOR = CHAIN_ROOT \+ ' \.vr-chain-row'/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /settings\.mutate/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /allowRemoteSettings/)
})

test('UI exposes quick/full queue actions plus stop/cancel and server polling', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /快速测试/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /完整测试/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /取消排队/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /停止测试/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /method:\s*'DELETE'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /setTimeout\(function\(\)\{[\s\S]*refreshAll\(true\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.state === 'queued'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.state === 'running'/)
})

test('progress shows completed/total, current intent and elapsed time', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.completed/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.total/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.currentIntent/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.elapsedMs/)
})

test('scores render in a fixed order with freshness and confidence instead of sorting by score', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /var SCORE_ORDER = \['structured', 'ocr', 'document', 'grounding', 'general'\]/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /SCORE_ORDER\.forEach/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /entries\.sort/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /中置信度/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /已陈旧/)
})

test('cloud benchmark warns about request count/cost and text-only model uses explicit force verification', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /可能产生API费用/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /Quick ≈3 requests; full ≈6 requests/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /DSH标记为仅文本/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /强制验证/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /force:\s*force === true/)
})

test('completed full benchmark can surface bounded grounding diagnostics without exposing endpoint secrets', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /定位详情/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /groundingDiagnostic/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /candidate\.measured && candidate\.measured\.groundingDiagnostic/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /groundingDiagnostic \? groundingDiagnosticText\(groundingDiagnostic\) : measuredText/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /parse=/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /candidateSpaces=/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /window\.alert\(groundingDiagnosticText/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /apiKeyEnv/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /endpointCredentialRef/)
})

test('incomplete selection removes benchmark controls and observer ignores unrelated streaming mutations', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /function completeSelection\(selected\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /removeControl\(row\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /function nodeTouchesChain\(node\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /node\.closest\(CHAIN_ROOT\)/)
})
