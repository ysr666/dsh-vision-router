import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('one bootstrap call cannot directly finish a structured-bootstrap turn', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /followupCompleted: false/)
  assert.match(source, /structuredFollowupEvidenceTools/)
  assert.match(source, /state\.followupCompleted = true/)
  assert.match(source, /STRUCTURED_BOOTSTRAP_REQUIRED/)
  assert.match(source, /至少 1 个能新增或验证证据的视觉工具/)
  assert.match(source, /normalizeStructuredBootstrapResult\(parsed, raw\)/)
  assert.doesNotMatch(source, /question: structuredBootstrapQuestion\(goal\),\n\s*json: true/)
})
