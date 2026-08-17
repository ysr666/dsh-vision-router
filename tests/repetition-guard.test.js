import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectRepetitionLoop,
  assertNoRepetitionLoop,
  REPETITION_LOOP_MARKER,
} from '../lib/repetition-guard.js'
import { classifyVisionFailure, VISION_FAILURE_KINDS } from '../lib/vision-resilience.js'

test('detects the real-world alternating router loop', () => {
  const garbage = '網絡路由器 互聯網 互聯網 路由器 互聯網 路由器 路由器 互聯網 '.repeat(12)
  const loop = detectRepetitionLoop(garbage)
  assert.ok(loop)
  assert.equal(loop.looped, true)
  assert.ok(['exact-period', 'consecutive-run', 'token-density'].includes(loop.mode))
  assert.ok(loop.coveredChars >= 0.5 * loop.totalChars)
})

test('detects a clean consecutive run loop', () => {
  const loop = detectRepetitionLoop('华为数据中心设备型号：华为数据中心'.repeat(30))
  assert.ok(loop)
  assert.equal(loop.mode, 'exact-period')
  assert.equal(loop.repetitions, 30)
})

test('detects the Huawei datacenter OCR loop shape', () => {
  const garbage = Array.from({ length: 200 }, () => '數據中心設備型號：華爲數據中心').join(' ')
  const loop = detectRepetitionLoop(garbage)
  assert.ok(loop)
})

test('leaves normal prose alone', () => {
  const prose = '图片里是 DeepSeek Harness 的插件设置页，包含识图模型列表、内置 OVH 免费模型兜底说明，以及添加备用识图模型的按钮。整体布局为上下结构。'
  assert.equal(detectRepetitionLoop(prose), undefined)
})

test('leaves structured JSON alone', () => {
  const json = JSON.stringify({
    visual_kind: 'ui',
    overview: 'A settings page listing vision models with fallback notes.',
    regions: [{ id: 'r1', location: 'top', role: 'content', content: 'model list' }],
    visible_text: [{ region_id: 'r1', text: '识图模型', uncertain: false }],
  })
  assert.equal(detectRepetitionLoop(json), undefined)
})

test('does not flag short legit repetition like laughter', () => {
  assert.equal(detectRepetitionLoop('哈哈哈哈哈哈'), undefined)
  assert.equal(detectRepetitionLoop('好的好的好的'), undefined)
})

test('does not flag a document that merely mentions one word often', () => {
  const text = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行：路由器配置项 ${i + 1} 的说明文字。`).join('')
  assert.equal(detectRepetitionLoop(text), undefined)
})

test('assertNoRepetitionLoop throws a classifiable error on loops', () => {
  const garbage = '互聯網 路由器 '.repeat(25)
  let thrown
  try {
    assertNoRepetitionLoop(garbage, 'openrouter/openai/gpt-5.6-sol')
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown)
  assert.match(thrown.message, new RegExp(REPETITION_LOOP_MARKER))
  assert.match(thrown.message, /openrouter\/openai\/gpt-5\.6-sol/)
  const classification = classifyVisionFailure(thrown)
  assert.equal(classification.kind, VISION_FAILURE_KINDS.REPETITION)
})

test('assertNoRepetitionLoop passes healthy output through silently', () => {
  assert.doesNotThrow(() => assertNoRepetitionLoop('这是正常的识图结果。', 'any/backend'))
})
