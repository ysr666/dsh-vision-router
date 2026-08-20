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

test('main settings row stays compact with one benchmark entry point', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /data-vr-capability-primary/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /text\('测评', 'Test'\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /text\('实测能力 · ', 'Measured · '\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /text\('尚未测评', 'Not tested yet'\)/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /data-vr-capability-action/)
})

test('running and queued jobs temporarily replace benchmark button with stop/cancel', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.state === 'queued'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.state === 'running'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /text\('停止', 'Stop'\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /text\('取消', 'Cancel'\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /method:\s*'DELETE'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.completed/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.total/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.currentIntent/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.elapsedMs/)
})

test('benchmark modal contains quick/full choices instead of exposing them on the main row', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /data-vr-capability-modal/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /模型测评/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /快速重测/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /完整重测/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /约3次请求 · OCR与通用视觉 · 低置信度/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /约6次请求 · 包含结构、文档与定位 · 中置信度/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /data\.modalAction/)
})

test('scores render in fixed order while latency/freshness/confidence stay secondary', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /var SCORE_ORDER = \['structured', 'ocr', 'document', 'grounding', 'general'\]/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /SCORE_ORDER\.forEach/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /entries\.sort/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /function measuredMetaText/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /中置信度/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /已陈旧/)
})

test('cloud cost and text-only force verification live inside the benchmark modal', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /云端测评会发送生成的测试图片/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /强制验证图片能力/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /DSH当前将此模型标记为仅文本/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /force:\s*force === true/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /window\.confirm/)
})

test('grounding diagnostics render in-app with developer details and no native alert', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /function appendDiagnosticDetails/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /定位能力/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /开发者信息/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /parse=/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /candidateSpaces=/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /window\.alert/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /apiKeyEnv/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /endpointCredentialRef/)
})

test('legacy full profile exposes one-request grounding repair only inside modal', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /hasGroundingScore/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /诊断定位/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /enqueue\(row, control, 'grounding', false\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /只发送1次定位测试/)
})

test('incomplete selection removes benchmark controls and observer ignores unrelated streaming mutations', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /function completeSelection\(selected\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /removeControl\(row\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /function nodeTouchesChain\(node\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /node\.closest\(CHAIN_ROOT\)/)
})
