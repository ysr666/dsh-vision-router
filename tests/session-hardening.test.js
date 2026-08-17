import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { extractStructuredBootstrapJson } from '../lib/structured-bootstrap.js'
import { openAICompatibleResponseText } from '../index.js'

test('bootstrap JSON parser accepts fenced and prose-wrapped objects', () => {
  const fenced = extractStructuredBootstrapJson('```json\n{"visual_kind":"chat","overview":"x { y }"}\n```')
  assert.equal(fenced.visual_kind, 'chat')
  const prose = extractStructuredBootstrapJson('Here is the result:\n{"visual_kind":"ui","regions":[]}\nDone.')
  assert.equal(prose.visual_kind, 'ui')
})

test('OpenAI-compatible response parser accepts content arrays but never reasoning-only payloads', () => {
  assert.equal(openAICompatibleResponseText({ choices: [{ message: { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] } }] }), 'hello world')
  assert.equal(openAICompatibleResponseText({ choices: [{ text: 'legacy' }] }), 'legacy')
  assert.equal(openAICompatibleResponseText({ choices: [{ message: { content: null, reasoning: 'private reasoning' } }] }), undefined)
})

test('runtime hardening keeps structured state by session id and caps evidence calls', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /structuredBootstrapTurnStateById/)
  assert.match(source, /STRUCTURED_EVIDENCE_BUDGET_EXHAUSTED/)
  assert.match(source, /engine: 'vision-first'/)
  assert.match(source, /STRUCTURED_VISUAL_TERMINAL/)
  assert.doesNotMatch(source, /vision-router-structured-followup-\$\{payload\.turn\}-\$\{Date\.now\(\)\}/)
})

test('long screenshot OCR accepts attachmentIds compatibility alias', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const start = source.indexOf("name: 'vision_long_screenshot_ocr'")
  const end = source.indexOf("deepToolDefs.push", start + 30)
  const segment = source.slice(start, end)
  assert.match(segment, /attachmentIds/)
  assert.match(segment, /imageInput/)
})
