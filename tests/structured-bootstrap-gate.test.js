import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('one bootstrap call cannot directly finish a task-independent structured-bootstrap turn', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /followupCompleted: false/)
  assert.match(source, /structuredFollowupEvidenceTools/)
  assert.match(source, /state\.followupCompleted = true/)
  assert.match(source, /STRUCTURED_BOOTSTRAP_REQUIRED/)
  assert.match(source, /至少 1 个能新增或验证证据的视觉工具/)
  assert.match(source, /normalizeStructuredBootstrapResult\(parsed, raw\)/)
  assert.match(source, /该预识别只建立任务无关的视觉底图，不携带也不生成 goal/)
  assert.doesNotMatch(source, /并把真实任务写进 goal/)
  assert.match(source, /def\.name === 'vision_ocr'/)
  assert.match(source, /effectiveArgs = \{ \.\.\.\(args \?\? \{\}\), engine: 'vision' \}/)
})
