import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('universal structured bootstrap must complete before follow-up visual tools', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /structuredBootstrapTurnState/)
  assert.match(source, /STRUCTURED_BOOTSTRAP_REQUIRED/)
  assert.match(source, /vision_bootstrap 会直接完成固定的第 1 次详细结构化视觉识别/)
  assert.doesNotMatch(source, /选择 mode 只是决定第 1 次结构化识别采用什么策略/)
  assert.match(source, /if \(bootstrapState\) bootstrapState\.completed = true/)
  assert.match(source, /def\.name === 'vision_bootstrap'/)
})
