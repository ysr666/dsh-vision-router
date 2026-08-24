import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CAPABILITY_BENCHMARK_CLIENT } from '../lib/vision-capability-benchmark-client.js'

test('background UI excludes Host-declared text-only models from unattended eligibility', () => {
  assert.match(
    CAPABILITY_BENCHMARK_CLIENT,
    /candidate\.imageCapability==='text-only'\)return false/,
  )
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /backgroundExcluded/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /Host标记仅文本/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /后台不自动测/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /可手动测试识图\/强制验证/)
})

test('background UI shows live progress and elapsed time for unattended measurement', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /background\.completed/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /background\.total/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /background\.elapsedMs/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /后台自动/)
})

test('background UI distinguishes transient retry from non-retryable failure', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /deferred\.retryable===true/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /后台测评暂缓/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /稍后自动重试/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /后台测评停止/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /不再自动重试/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /模型暂不可用/)
})

test('background UI retains idempotent DOM writes and bounded polling cadence', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /if\(n\.textContent!==next\)n\.textContent=next/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /if\(b\.textContent!==nextLabel\)b\.textContent=nextLabel/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /if\(manualActive\(body\)\|\|\(bg&&bg\.running\)\)return 1000/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /if\(backgroundPending\(body\)\)return 3000/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /nodeTouchesChain/)
})
