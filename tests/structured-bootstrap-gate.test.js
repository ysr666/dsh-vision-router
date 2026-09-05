import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('core owns bootstrap order while hardening owns the required x>=1 evidence gate', async () => {
  const core = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  const hardening = await readFile(new URL('../lib/structured-flow-hardening.js', import.meta.url), 'utf8')

  // Core still owns the ordered bootstrap protocol and the model-visible
  // transition into the task-directed 1+x phase.
  assert.match(core, /STRUCTURED_BOOTSTRAP_REQUIRED/)
  assert.match(core, /至少 1 个能新增或验证证据的视觉工具/)
  assert.match(core, /normalizeStructuredBootstrapResult\(parsed, raw\)/)
  assert.match(core, /该预识别只建立任务无关的视觉底图，不携带也不生成 goal/)
  assert.doesNotMatch(core, /并把真实任务写进 goal/)

  // The outer structured-flow boundary is the hard completion authority. It
  // asks only whether at least one usable task-directed evidence call landed;
  // mixed classifications must not become branch quotas inferred from tool names.
  assert.match(hardening, /successfulEvidenceCalls/)
  assert.match(hardening, /return state\.successfulEvidenceCalls >= 1 \? 0 : 1/)
  assert.doesNotMatch(hardening, /function inferBranchForTool/)
  assert.doesNotMatch(hardening, /completedBranches/)
  assert.doesNotMatch(hardening, /mixedAttemptSignatures/)

  // OCR's structured-mode engine override is intentionally unchanged in PR 1;
  // model-visible OCR/runtime alignment belongs to Vision Agent Quality PR 3.
  assert.match(core, /def\.name === 'vision_ocr'/)
  assert.match(core, /effectiveArgs = \{ \.\.\.\(args \?\? \{\}\), engine: 'vision' \}/)
})
