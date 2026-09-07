import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const runtime = readFileSync(new URL('../lib/runtime-i18n.js', import.meta.url), 'utf8')
const bootstrap = readFileSync(new URL('../lib/structured-bootstrap.js', import.meta.url), 'utf8')

const toolRefs = (source) => [...source.matchAll(/\bvision_[a-z0-9_]+\b/g)].map((match) => match[0])
const registeredTools = new Set(
  [...index.matchAll(/name:\s*['"](vision_[a-z0-9_]+)['"]/g)].map((match) => match[1]),
)

function structuredPromptSlice() {
  const start = index.indexOf('let bootstrapReminder')
  const end = index.indexOf('const appendStructuredReminder', start)
  assert.ok(start >= 0 && end > start)
  return index.slice(start, end)
}

test('model-visible vision tool names are backed by registered tools', () => {
  const visible = [runtime, bootstrap, structuredPromptSlice()]
  const unknown = [...new Set(visible.flatMap(toolRefs).filter((name) => !registeredTools.has(name)))].sort()
  assert.deepEqual(unknown, [])
  assert.equal(runtime.includes('vision_ask'), false)
})

test('structured follow-up suggestions stay advisory and task-conditioned', () => {
  assert.match(bootstrap, /task-independent follow-up evidence candidate/i)
  assert.match(bootstrap, /optional suggestions, not a task plan/i)
  assert.match(runtime, /recommended_followups are task-independent suggestions only, not a required plan/i)
  assert.match(runtime, /Choose the next tool from the user’s question and the evidence still needed/i)
  const core = structuredPromptSlice()
  assert.match(core, /recommended_followups 只是任务无关的候选建议，不是调用计划/)
  assert.match(core, /证据充分后直接作答，不为流程继续调用/)
})

test('Round 1 hard boundaries remain visible while guidance is slimmed', () => {
  const core = structuredPromptSlice()
  assert.match(core, /x >= 1/)
  assert.match(core, /engine=auto 始终先尝试本地 Tesseract/)
  assert.match(runtime, /first vision-tool call for this image MUST be vision_bootstrap/i)
  assert.match(runtime, /at least 1 targeted evidence call \(x >= 1\)/i)
  assert.match(runtime, /do not blindly repeat the same failing path/i)
})
