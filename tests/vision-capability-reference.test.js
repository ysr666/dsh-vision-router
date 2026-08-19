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
  assert.deepEqual(summary.strengths, [])
})

test('known family priors are exposed as weak evidence, not measurements', () => {
  const summary = summarizeVisionCapabilityCandidate({ provider: 'x', model: 'Qwen3-VL-8B' })
  assert.equal(summary.evidence, 'family-prior')
  assert.equal(summary.verified, false)
  assert.ok(summary.strengths.some((entry) => entry.intent === 'ocr'))
})

test('measured evidence is preferred in the agent reference', () => {
  const key = 'x/future-vlm'
  const reference = buildAgentVisionModelReference(
    [{ provider: 'x', model: 'future-vlm' }],
    { measured: { [key]: { scores: { ocr: 0.97, grounding: 0.42 } } } },
  )
  assert.match(reference.text, /实测/)
  assert.match(reference.text, /OCR:0\.88/)
  assert.match(reference.text, /不是永久排行榜/)
})

test('discovery planner probes task intent first and then a compact cross-section', () => {
  const summary = summarizeVisionCapabilityCandidate({ provider: 'future-ai', model: 'new-vlm' })
  const plan = planVisionCapabilityDiscovery(summary, { taskIntent: 'document', budget: 4 })
  assert.equal(plan.needed, true)
  assert.deepEqual(plan.intents, ['document', 'structured', 'ocr', 'grounding'])
})

test('manual override can make an exact backend high-confidence without relying on its name', () => {
  const key = 'private/my-finetune'
  const summary = summarizeVisionCapabilityCandidate(
    { provider: 'private', model: 'my-finetune' },
    { overrides: { [key]: { scores: { grounding: 0.99, detection: 0.96 } } } },
  )
  assert.equal(summary.evidence, 'manual-override')
  assert.equal(summary.verified, true)
  assert.ok(summary.strengths.some((entry) => entry.intent === 'grounding'))
})
