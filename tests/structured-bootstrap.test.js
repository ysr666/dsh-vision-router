import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeStructuredBootstrapResult, structuredBootstrapQuestion, structuredBootstrapMemory } from '../lib/structured-bootstrap.js'
import { resolveVisionOcrEngine } from '../index.js'

test('bootstrap is task-independent and does not default to OCR', () => {
  const prompt = structuredBootstrapQuestion()
  assert.match(prompt, /task-independent visual map/i)
  assert.doesNotMatch(prompt, /User\/task goal:/i)
  assert.match(prompt, /Do NOT recommend vision_ocr merely because text is visible/i)
})

test('bootstrap JSON example stays syntactically clean around mixed_of', () => {
  const prompt = structuredBootstrapQuestion()
  assert.match(prompt, /"mixed_of":\[\],"overview"/)
  assert.doesNotMatch(prompt, /\]\（仅当 visual_kind=mixed/)
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

test('bootstrap visual_kind is strictly enumerated', () => {
  assert.equal(normalizeStructuredBootstrapResult({ visual_kind: 'ui' }).visual_kind, 'ui')
  for (const bad of ['Mixed', 'mixed/ui', 'constructor', '__proto__', 'x'.repeat(10000)]) {
    assert.equal(normalizeStructuredBootstrapResult({ visual_kind: bad }).visual_kind, 'unknown')
  }
  assert.equal(normalizeStructuredBootstrapResult({ visual_kind: null }).visual_kind, 'unknown')
})

test('bootstrap schema carries content_kind and normalizer validates it', () => {
  const prompt = structuredBootstrapQuestion()
  assert.match(prompt, /content_kind/)
  assert.match(prompt, /person\|animal\|plant\|food\|vehicle\|machine\|architecture\|object\|scene\|meme\|unknown/)
  // 合法枚举通过；缺失/非法 → unknown
  assert.equal(normalizeStructuredBootstrapResult({ visual_kind: 'general', content_kind: 'food' }).content_kind, 'food')
  assert.equal(normalizeStructuredBootstrapResult({ visual_kind: 'general', content_kind: 'bogus' }).content_kind, 'unknown')
  assert.equal(normalizeStructuredBootstrapResult({ visual_kind: 'document' }).content_kind, 'unknown')
  assert.equal(normalizeStructuredBootstrapResult({ visual_kind: 'document', content_kind: 'person' }).content_kind, 'person')
})

test('bootstrap schema carries mixed_of and normalizer validates, prioritizes, then caps it', () => {
  const prompt = structuredBootstrapQuestion()
  assert.match(prompt, /mixed_of/)
  assert.deepEqual(
    normalizeStructuredBootstrapResult({ visual_kind: 'mixed', mixed_of: ['document', 'ui'] }).mixed_of,
    ['ui', 'document'],
  )
  assert.deepEqual(
    normalizeStructuredBootstrapResult({ visual_kind: 'mixed', mixed_of: ['ui', 'ui', 'document', 'code'] }).mixed_of,
    ['ui', 'document'],
  )
  // 对抗输出：不能先截断 general/document 再把更高优先级的 ui 丢掉。
  assert.deepEqual(
    normalizeStructuredBootstrapResult({ visual_kind: 'mixed', mixed_of: ['general', 'document', 'ui'] }).mixed_of,
    ['ui', 'document'],
  )
  // 非法/缺失/非 mixed → []
  assert.deepEqual(normalizeStructuredBootstrapResult({ visual_kind: 'mixed', mixed_of: ['bogus'] }).mixed_of, [])
  assert.deepEqual(normalizeStructuredBootstrapResult({ visual_kind: 'mixed' }).mixed_of, [])
  assert.deepEqual(normalizeStructuredBootstrapResult({ visual_kind: 'document', mixed_of: ['ui'] }).mixed_of, [])
})

test('vision_ocr configured default applies only when a call does not force an engine', () => {
  for (const configured of ['auto', 'tesseract', 'vision']) {
    assert.equal(resolveVisionOcrEngine('tesseract', configured), 'tesseract')
    assert.equal(resolveVisionOcrEngine('vision', configured), 'vision')
    assert.equal(resolveVisionOcrEngine(undefined, configured), configured)
    assert.equal(resolveVisionOcrEngine('auto', configured), configured)
    assert.equal(resolveVisionOcrEngine('unknown-engine', configured), configured)
  }
  assert.equal(resolveVisionOcrEngine(undefined, 'invalid'), 'auto')
})
test('runtime removes goal and keeps the public OCR auto contract tool-owned and model-visible', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(index.includes("required: ['goal']"), false)
  assert.equal(index.includes('structuredBootstrapQuestion()'), true)
  assert.equal(index.includes('structuredBootstrapMemory(evidence)'), true)
  assert.equal(index.includes('const engine = resolveVisionOcrEngine(args.engine, current().ocrEngine)'), true)
  assert.equal(index.includes("effectiveArgs = { ...(args ?? {}), engine: 'vision' }"), false)
  assert.equal(index.includes('configured OCR engine policy applies'), true)
  assert.equal(index.includes('Structured 1+x follow-up does not change the selected policy'), true)
  assert.equal(index.includes('resolveVisionOcrEngine(args.engine, structuredFollowup)'), false)
  assert.equal(index.includes('engine=tesseract or engine=vision'), true)
  assert.equal(index.includes('explicit engine=tesseract or engine=vision always wins'), true)
  assert.equal(client.includes('不读取具体任务目标'), true)
  assert.equal(client.includes('OCR 默认引擎'), true)
  assert.equal(client.includes('单次显式 engine=tesseract/vision 始终优先'), true)
})
