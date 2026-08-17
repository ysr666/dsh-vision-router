import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('structured bootstrap mode choice cannot replace the first visual pass', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /structuredBootstrapTurnState/)
  assert.match(source, /STRUCTURED_BOOTSTRAP_REQUIRED/)
  assert.match(source, /选择 mode 只是决定第 1 次结构化识别采用什么策略，本身不算视觉识别/)
  assert.match(source, /if \(bootstrapState\) bootstrapState\.completed = true/)
  assert.match(source, /def\.name === 'vision_bootstrap'/)
})
