import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CAPABILITY_BENCHMARK_CLIENT } from '../lib/vision-capability-benchmark-client.js'

test('Host text-only metadata stays advisory while opted-in background work remains eligible', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /backgroundExcluded\(body,candidate\.key\)/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /benchmarkable!==true\|\|candidate\.imageCapability==='text-only'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /Host标记仅文本/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /等待实际后台测评验证/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /仅作提示/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /force=candidate\.imageCapability==='text-only'/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /后台不自动测/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /强制验证图片能力/)
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
