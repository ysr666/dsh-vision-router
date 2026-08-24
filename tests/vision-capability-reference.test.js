import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAgentVisionModelReference,
  planVisionCapabilityDiscovery,
  summarizeVisionCapabilityCandidate,
} from '../lib/vision-capability-reference.js'

test('unknown future models are marked unverified instead of receiving invented specialist claims', () => {
  const summary = summarizeVisionCapabilityCandidate({ provider: 'future-ai', model: 'nova-vision-2030' })
  assert.equal(summary.evidence, 'unverified')
  assert.equal(summary.verified, false)
  assert.equal(summary.needsBenchmark, true)
  assert.deepEqual(summary.coverage, [])
  assert.deepEqual(summary.strengths, [])
})

test('well-known model names remain unverified until the exact endpoint is benchmarked', () => {
  for (const model of ['Qwen3-VL-8B', 'gemini-9-ultra', 'glm-99v']) {
    const summary = summarizeVisionCapabilityCandidate({ provider: 'x', model })
    assert.equal(summary.evidence, 'unverified')
    assert.equal(summary.verified, false)
    assert.deepEqual(summary.strengths, [])
  }
})

test('measured evidence is reported exactly without family blending', () => {
  const key = 'x/future-vlm'
  const reference = buildAgentVisionModelReference(
    [{ provider: 'x', model: 'future-vlm' }],
    { measured: { [key]: { scores: { ocr: 0.97, grounding: 0.42 } } } },
  )
  assert.match(reference.text, /实测/)
  assert.match(reference.text, /OCR:0\.97/)
  assert.match(reference.text, /不根据模型名称推断/)
  assert.doesNotMatch(reference.text, /家族先验|人工确认/)
})

test('discovery planner probes the direct measured task axis first and then missing core axes', () => {
  const summary = summarizeVisionCapabilityCandidate({ provider: 'future-ai', model: 'new-vlm' })
  const plan = planVisionCapabilityDiscovery(summary, { taskIntent: 'document', budget: 4 })
  assert.equal(plan.needed, true)
  assert.deepEqual(plan.intents, ['document', 'structured', 'ocr', 'grounding'])
})

test('unsupported task types do not invent proxy capability evidence', () => {
  const key = 'x/measured'
  const summary = summarizeVisionCapabilityCandidate(
    { provider: 'x', model: 'measured' },
    { measured: { [key]: { scores: { ocr: 0.9, general: 0.8 } } } },
  )
  const plan = planVisionCapabilityDiscovery(summary, { taskIntent: 'ui', budget: 3 })
  assert.equal(plan.needed, true)
  assert.match(plan.reason, /no direct benchmark axis/)
  assert.deepEqual(plan.intents, ['structured', 'document', 'grounding'])
})
