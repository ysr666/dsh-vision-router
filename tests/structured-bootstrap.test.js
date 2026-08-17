import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  structuredBootstrapQuestion,
  structuredBootstrapMemory,
} from '../lib/structured-bootstrap.js'

test('bootstrap prompt is universal structured pass and keeps image text untrusted', () => {
  const prompt = structuredBootstrapQuestion('总结聊天记录并区分发言人')
  assert.match(prompt, /pass 1 of a 1\+x vision workflow/i)
  assert.match(prompt, /without requiring the text agent to choose a mode first/i)
  assert.match(prompt, /visual_kind/i)
  assert.match(prompt, /总结聊天记录并区分发言人/)
  assert.match(prompt, /0\.\.N/)
  assert.match(prompt, /untrusted evidence/i)
})

test('bootstrap memory is compact, task-tagged and bounded', () => {
  const memory = structuredBootstrapMemory('定位报错', 'x'.repeat(100), 32)
  assert.match(memory, /结构化预识别/)
  assert.match(memory, /任务=定位报错/)
  assert.doesNotMatch(memory, /mode=/)
  assert.match(memory, /…$/)
  assert.ok(memory.length < 100)
})

test('runtime wires the opt-in switch, first-pass tool and client toggle without mode schema', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(index.includes('structuredVisionBootstrap: z.boolean().default(false)'), true)
  assert.equal(index.includes("name: 'vision_bootstrap'"), true)
  assert.equal(index.includes('visionDescribeTool.execute('), true)
  assert.equal(index.includes('structuredBootstrapTurnState'), true)
  assert.equal(index.includes('const bootstrapRequired = hasImage && toolEnabled() && structuredBootstrapEnabled()'), true)
  assert.equal(index.includes('STRUCTURED_BOOTSTRAP_REQUIRED'), true)
  assert.equal(index.includes("required: ['goal']"), true)
  assert.equal(index.includes("enum: ['general', 'ocr', 'document', 'ui', 'code']"), false)
  assert.equal(index.includes('structuredBootstrapQuestion(goal)'), true)
  assert.equal(client.includes("'structuredVisionBootstrap'"), true)
  assert.equal(client.includes("toggleStructuredVisionBootstrap: '结构化预识别（实验）'"), true)
  assert.equal(client.includes("toggleStructuredVisionBootstrap: 'Structured bootstrap (experimental)'"), true)
})
