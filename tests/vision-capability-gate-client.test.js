import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CAPABILITY_BENCHMARK_CLIENT } from '../lib/vision-capability-benchmark-client.js'
import { VISION_EXACT_CHECK_CLIENT } from '../lib/vision-exact-check-client.js'

test('capability UI distinguishes measured text-only from visual proof failure', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /measured-text-only/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /实测仅文本 · 图片请求被模型拒绝 · 后台不再自动测/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /'visual-proof': \['视觉验证未通过'/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /vision-router:capability-updated/)
})

test('exact image check exposes measured text-only and refreshes capability status', () => {
  assert.match(VISION_EXACT_CHECK_CLIENT, /VISION_CHECK_UNSUPPORTED_IMAGE/)
  assert.match(VISION_EXACT_CHECK_CLIENT, /实测仅文本 · 图片请求被模型拒绝/)
  assert.match(VISION_EXACT_CHECK_CLIENT, /不写入Auto能力分数/)
  assert.match(VISION_EXACT_CHECK_CLIENT, /vision-router:capability-updated/)
})
