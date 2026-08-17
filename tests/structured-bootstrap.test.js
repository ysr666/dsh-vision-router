import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  normalizeStructuredBootstrapResult,
  structuredBootstrapQuestion,
  structuredBootstrapMemory,
} from '../lib/structured-bootstrap.js'

test('bootstrap prompt owns a dedicated universal schema', () => {
  const prompt = structuredBootstrapQuestion('总结聊天记录并区分发言人')
  assert.match(prompt, /pass 1 of a required 1\+x vision workflow/i)
  assert.match(prompt, /Do NOT ask the text agent to choose/i)
  assert.match(prompt, /visual_kind/i)
  assert.match(prompt, /recommended_followups/i)
  assert.match(prompt, /总结聊天记录并区分发言人/)
  assert.match(prompt, /at least one concrete follow-up/i)
  assert.match(prompt, /untrusted evidence/i)
})

test('bootstrap normalizer returns stable dedicated keys and a required follow-up', () => {
  const result = normalizeStructuredBootstrapResult({
    visual_kind: 'ui',
    overview: 'settings screen',
    regions: [{ id: 'r1', location: 'center', role: 'settings', content: 'toggles' }],
    visible_text: [{ region_id: 'r1', text: 'Save', uncertain: false }],
    entities: [{ id: 'e1', type: 'button', label: 'Save', region_id: 'r1', state: 'enabled' }],
    relationships: [],
    uncertainties: [],
    recommended_followups: [{ tool: 'vision_detect', target: 'controls', reason: 'verify controls' }],
  })
  assert.deepEqual(Object.keys(result), [
    'visual_kind', 'overview', 'regions', 'visible_text', 'entities',
    'relationships', 'uncertainties', 'recommended_followups',
  ])
  assert.equal(result.visual_kind, 'ui')
  assert.equal(result.recommended_followups[0].tool, 'vision_detect')
})

test('bootstrap normalizer rescues old generic describe JSON but no longer depends on it', () => {
  const result = normalizeStructuredBootstrapResult({
    summary: 'old schema',
    layout: [{ region: 'top', content: 'toolbar' }],
    entities: [{ type: 'button', label: 'Save' }],
    text: 'Save',
  })
  assert.equal(result.overview, 'old schema')
  assert.equal(result.regions[0].location, 'top')
  assert.equal(result.visible_text[0].text, 'Save')
  assert.ok(result.recommended_followups.length >= 1)
})

test('bootstrap memory is compact, task-tagged and bounded', () => {
  const memory = structuredBootstrapMemory('定位报错', 'x'.repeat(100), 32)
  assert.match(memory, /结构化预识别/)
  assert.match(memory, /任务=定位报错/)
  assert.match(memory, /…$/)
  assert.ok(memory.length < 100)
})

test('runtime requires pass 1 then at least one follow-up evidence call', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(index.includes('structuredVisionBootstrap: z.boolean().default(false)'), true)
  assert.equal(index.includes("name: 'vision_bootstrap'"), true)
  assert.equal(index.includes('normalizeStructuredBootstrapResult(parsed, raw)'), true)
  assert.equal(index.includes('json: false'), true)
  assert.equal(index.includes('followupCompleted: false'), true)
  assert.equal(index.includes('structuredFollowupEvidenceTools.has(def.name)'), true)
  assert.equal(index.includes('state.followupCompleted = true'), true)
  assert.equal(index.includes('x 必须 >= 1'), true)
  assert.equal(index.includes('recommended_followups'), true)
  assert.equal(client.includes('这是 1+x（x≥1）'), true)
  assert.equal(client.includes('This is 1+x with x>=1'), true)
})
