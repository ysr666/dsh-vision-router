import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CAPABILITY_BENCHMARK_CLIENT } from '../lib/vision-capability-benchmark-client.js'

test('Host text-only metadata stays advisory while Host presentation owns background eligibility', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /function presentationBackground\(candidate\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /background\.state==='awaiting-verification'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /background\.state==='declared-text-only'/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /function backgroundExcluded\(/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /function backgroundEligible\(/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /benchmarkable!==true\|\|candidate\.imageCapability==='text-only'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /Host标记仅文本/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /等待实际后台测评验证/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /仅作提示/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /force=candidate\.imageCapability==='text-only'/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /后台不自动测/)
  assert.doesNotMatch(CAPABILITY_BENCHMARK_CLIENT, /强制验证图片能力/)
})

test('background UI shows Host-projected live progress and elapsed time for unattended measurement', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /background\.state==='running'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /var run=background\.running\|\|\{\}/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /run\.completed/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /run\.total/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /run\.elapsedMs/)
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

test('background UI retains idempotent DOM writes and Host-driven bounded polling cadence', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /if\(n\.textContent!==next\)n\.textContent=next/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /if\(b\.textContent!==nextLabel\)b\.textContent=nextLabel/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /function backgroundRunning\(body\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /presentationBackground\(candidate\)/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /if\(manualActive\(body\)\|\|backgroundRunning\(body\)\)return 1000/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /if\(backgroundPending\(body\)\)return 3000/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /nodeTouchesChain/)
})
