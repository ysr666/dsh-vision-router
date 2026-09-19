import test from 'node:test'
import assert from 'node:assert/strict'
import { createVisionTurnMemory } from '../lib/vision-resilience.js'
import { shouldBlockDegradedHostTool } from '../lib/degraded-local-evidence.js'
const SOURCE_A = `sha256:${'a'.repeat(64)}`
const SOURCE_B = `sha256:${'b'.repeat(64)}`
const MATERIALIZED_A = 'sha256-aaaaaaaaaaaaaaaaaaaaaaaaa-deadbeef-materialized.png'
const CROP_A = 'sha256-aaaaaaaaaaaaaaaaaaaaaaaaa-cafebabe-crop-1-2-3-4.png'
const CROP_B = 'sha256-bbbbbbbbbbbbbbbbbbbbbbbbb-deadbeef-crop-5-6-7-8.png'

test('derived artifact lineage resolves back to the original OCR source', () => {
  const memory = createVisionTurnMemory({ maxEvidencePerScope: 8 })
  const scope = 's1:1'
  memory.recordLocalOcr(scope, SOURCE_A, { uncertain: true })
  memory.recordDerivedArtifact(scope, SOURCE_A, MATERIALIZED_A)
  memory.recordDerivedArtifact(scope, `/tmp/${MATERIALIZED_A}`, CROP_A)
  assert.equal(memory.resolveSource(scope, `/tmp/${MATERIALIZED_A}`), SOURCE_A)
  assert.equal(memory.resolveSource(scope, `/tmp/${CROP_A}`), SOURCE_A)
  assert.equal(memory.hasLocalOcr(scope, `/tmp/${CROP_A}`), true)
  assert.equal(memory.hasLocalOcr(scope, SOURCE_B), false)
})

test('degraded refinement counts are isolated by source and follow derived crops', () => {
  const memory = createVisionTurnMemory({ maxEvidencePerScope: 8 })
  const scope = 's1:1'
  memory.recordLocalOcr(scope, SOURCE_A)
  memory.recordDerivedArtifact(scope, SOURCE_A, CROP_A)
  assert.equal(memory.recordDegradedRefinement(scope, `/tmp/${CROP_A}`), 1)
  assert.equal(memory.degradedRefinementCount(scope, SOURCE_A), 1)
  assert.equal(memory.degradedRefinementCount(scope, SOURCE_B), 0)
})

test('new Host turn drops degraded local evidence and refinement counts', () => {
  const memory = createVisionTurnMemory({ maxEvidencePerScope: 8 })
  memory.bindSession('s1', 's1:1')
  memory.recordLocalOcr('s1:1', SOURCE_A)
  memory.recordDerivedArtifact('s1:1', SOURCE_A, MATERIALIZED_A)
  memory.recordDegradedRefinement('s1:1', SOURCE_A)
  memory.markAllFailed('s1:1')
  assert.equal(memory.allFailed('s1:1'), true)
  assert.equal(memory.degradedRefinementCount('s1:1', SOURCE_A), 1)

  memory.bindSession('s1', 's1:2')
  assert.equal(memory.allFailed('s1:1'), false)
  assert.equal(memory.hasLocalOcr('s1:1', SOURCE_A), false)
  assert.equal(memory.degradedRefinementCount('s1:1', SOURCE_A), 0)
  assert.equal(memory.hasLocalOcr('s1:2', SOURCE_A), false)
})

test('degraded artifact tokens appear only after backend failure plus local OCR', () => {
  const memory = createVisionTurnMemory({ maxEvidencePerScope: 8 })
  const scope = 's1:1'
  memory.recordDerivedArtifact(scope, SOURCE_A, CROP_A)
  memory.recordDerivedArtifact(scope, SOURCE_B, CROP_B)
  assert.deepEqual(memory.degradedEvidenceTokens(scope), [])
  memory.recordLocalOcr(scope, SOURCE_A, { uncertain: true })
  assert.deepEqual(memory.degradedEvidenceTokens(scope), [])
  memory.markAllFailed(scope)
  assert.deepEqual(memory.degradedEvidenceTokens(scope), [SOURCE_A, CROP_A])
  assert.equal(memory.degradedEvidenceTokens(scope).includes(CROP_B), false)
})

test('Host re-analysis guard blocks degraded image pipelines without blocking ordinary shell work', () => {
  const tokens = [CROP_A]
  assert.equal(shouldBlockDegradedHostTool('bash', { command: 'npm test' }, tokens), false)
  assert.equal(shouldBlockDegradedHostTool('bash', { command: 'which tesseract' }, tokens), false)
  assert.equal(shouldBlockDegradedHostTool('read_image', { file_path: '/tmp/unrelated.png' }, tokens), false)
  assert.equal(shouldBlockDegradedHostTool('vision_crop', { image: CROP_A }, tokens), false)
  assert.equal(shouldBlockDegradedHostTool('bash', { command: `python3 inspect.py /work/${CROP_B}` }, tokens), false)
  assert.equal(shouldBlockDegradedHostTool('bash', { command: `python3 inspect.py /tmp/${CROP_A}` }, tokens), true)
  assert.equal(shouldBlockDegradedHostTool('read_image', { file_path: `/work/${CROP_A}` }, tokens), true)
  assert.equal(shouldBlockDegradedHostTool('bash', { command: 'tesseract unrelated.png - --psm 6' }, tokens), false)
  assert.equal(shouldBlockDegradedHostTool('bash', { command: "python3 -c 'from PIL import Image; Image.open(\"unrelated.png\")'" }, tokens), false)
  assert.equal(shouldBlockDegradedHostTool('bash', { command: 'find $DSH_HOME/.dsh/attachments -type f' }, tokens), true)
  assert.equal(shouldBlockDegradedHostTool('bash', { command: `cp /tmp/${SOURCE_A.slice(7)} ./img.png` }, [SOURCE_A]), true)
  assert.equal(shouldBlockDegradedHostTool('bash', { command: `find /tmp -name '*${SOURCE_A.slice(7, 23)}*'` }, [SOURCE_A]), true)
})
