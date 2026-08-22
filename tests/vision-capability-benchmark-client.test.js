import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPABILITY_BENCHMARK_CLIENT,
  injectCapabilityBenchmarkClient,
} from '../lib/vision-capability-benchmark-client.js'
import {
  EXACT_VISION_TEST_CLIENT,
  injectExactVisionTestClient,
} from '../lib/vision-backend-smoke-test-client.js'

test('capability benchmark client injects once into the document head', () => {
  const html = '<!doctype html><html><head><title>DSH</title></head><body></body></html>'
  const once = injectCapabilityBenchmarkClient(html)
  assert.match(once, /data-vision-router-capability-benchmark/)
  assert.equal(injectCapabilityBenchmarkClient(once), once)
})

test('smoke test and benchmark remain two distinct settings actions in either injection order', () => {
  const html = '<!doctype html><html><head><title>DSH</title></head><body></body></html>'
  const smokeThenBenchmark = injectCapabilityBenchmarkClient(injectExactVisionTestClient(html))
  const benchmarkThenSmoke = injectExactVisionTestClient(injectCapabilityBenchmarkClient(html))

  for (const composed of [smokeThenBenchmark, benchmarkThenSmoke]) {
    assert.match(composed, /data-vision-router-exact-vision-test/)
    assert.match(composed, /data-vision-router-capability-benchmark/)
  }

  assert.match(EXACT_VISION_TEST_CLIENT, /快速自检 · 1次请求/)
  assert.match(EXACT_VISION_TEST_CLIENT, /text\('测试识图','Test vision'\)/)
  assert.match(EXACT_VISION_TEST_CLIENT, /control\.style\.order='1'/)
  assert.doesNotMatch(EXACT_VISION_TEST_CLIENT, /v2OwnsCapabilityTesting|removeExactTestControls/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /text\('测评','Benchmark'\)/)
})

test('client is scoped to the actual Vision Router model chain and never mutates settings', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /var CHAIN_ROOT = '#vr-vision-backend-chain'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /var ROW_SELECTOR = CHAIN_ROOT \+ ' \.vr-chain-row'/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /settings\.mutate/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /allowRemoteSettings/)
})

test('main settings row stays compact with one benchmark entry point', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /data-vr-capability-primary/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /text\('测评','Benchmark'\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /部分测评/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /完整测评/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /尚未测评 · 自动选择不会推断此模型能力/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /data-vr-capability-action/)
})

test('running and queued jobs temporarily replace benchmark button with stop/cancel', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.state === 'queued'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.state === 'running'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /text\('停止','Stop'\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /text\('取消','Cancel'\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /method:'DELETE'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.completed/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.total/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.currentIntent/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /job\.elapsedMs/)
})

test('benchmark product vocabulary is coverage-based and has no confidence or stale tier', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /function coverageOf/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /function coverageKindText/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /约3次请求 · 覆盖 OCR 和通用/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /约6次请求 · 覆盖结构化、OCR、文档、定位、通用/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /低置信度|中置信度|low confidence|medium confidence/i)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /confidence/i)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /已陈旧|已过期|stale|expired/i)
})

test('measurement timestamps are provenance and benchmark latency is explicitly historical', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /function axisMeasuredAt/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /measured\.measuredAtByAxis/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /function ageText/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /测评耗时是当次Benchmark观测/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /不代表当前速度，也不用于Speed\/综合排序/)
})

test('benchmark modal renders five fixed axes with score benchmark latency and measurement time', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /var SCORE_ORDER = \['structured', 'ocr', 'document', 'grounding', 'general'\]/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /latencies=measured\.benchmarkMedianLatencyMs\|\|\{\}/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /text\('测评耗时','Benchmark latency'\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /SCORE_ORDER\.forEach/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /— 未测/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /seconds\(latency\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /axisStateText\(measured,axis\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /text\('测评时间','Measured'\)/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /text\('新鲜度','Freshness'\)/)
})

test('cloud cost and text-only force verification live inside the benchmark modal', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /云端测评会发送生成的测试图片/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /强制验证图片能力/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /DSH当前将此模型标记为仅文本/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /force:force===true/)
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
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /hasGrounding/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /诊断定位/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /enqueue\(row,control,'grounding',false\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /只发送1次定位测试/)
})

test('incomplete selection removes benchmark controls and observer ignores unrelated streaming mutations', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /function completeSelection/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /removeControl\(row\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /function nodeTouchesChain/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /node\.closest&&node\.closest\(CHAIN_ROOT\)/)
})
