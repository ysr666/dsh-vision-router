import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeStructuredBootstrapResult, structuredBootstrapQuestion, structuredBootstrapMemory } from '../lib/structured-bootstrap.js'

test('bootstrap is task-independent and does not default to OCR', () => {
  const prompt = structuredBootstrapQuestion()
  assert.match(prompt, /task-independent visual map/i)
  assert.doesNotMatch(prompt, /User\/task goal:/i)
  assert.match(prompt, /Do NOT recommend vision_ocr merely because text is visible/i)
})

test('fallback follow-up avoids OCR unless explicitly recommended', () => {
  const chat = normalizeStructuredBootstrapResult({ visual_kind: 'chat', overview: 'chat', visible_text: [{ region_id: 'r1', text: '你好', uncertain: false }] })
  assert.equal(chat.recommended_followups[0].tool, 'vision_describe')
  const ui = normalizeStructuredBootstrapResult({ visual_kind: 'ui', overview: 'app' })
  assert.equal(ui.recommended_followups[0].tool, 'vision_detect')
})

test('bootstrap memory has no task/goal tag', () => {
  const memory = structuredBootstrapMemory('x'.repeat(100), 32)
  assert.match(memory, /结构化预识别/)
  assert.doesNotMatch(memory, /任务=/)
})

test('runtime removes goal and makes structured OCR vision-first', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(index.includes("required: ['goal']"), false)
  assert.equal(index.includes('structuredBootstrapQuestion()'), true)
  assert.equal(index.includes('structuredBootstrapMemory(evidence)'), true)
  assert.equal(index.includes("def.name === 'vision_ocr'"), true)
  assert.equal(index.includes("effectiveArgs = { ...(args ?? {}), engine: 'vision' }"), true)
  assert.equal(client.includes('不读取具体任务目标'), true)
  assert.equal(client.includes('自动模式会优先使用视觉模型'), true)
})
