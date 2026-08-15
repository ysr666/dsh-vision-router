import { readFileSync, writeFileSync } from 'node:fs'

function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1
  if (count !== 1) throw new Error(`${label}: expected exactly one match, got ${count}`)
  return source.replace(from, to)
}

const clientPath = 'lib/client.js'
let client = readFileSync(clientPath, 'utf8')
client = replaceOnce(
  client,
  "quickStartTitle: '先分清两个模型'",
  "quickStartTitle: '聊天与看图分别设置'",
  'Chinese quick-start title',
)
client = replaceOnce(
  client,
  "quickStartTitle: 'Know the two model settings'",
  "quickStartTitle: 'Chat and vision are configured separately'",
  'English quick-start title',
)
writeFileSync(clientPath, client)

const testPath = 'tests/client.test.js'
let tests = readFileSync(testPath, 'utf8')
tests = replaceOnce(
  tests,
  "  assert.equal(source.includes(\"onboardingStep1Title: '1 · 会话 / 文字模型'\"), true)\n",
  "  assert.equal(source.includes(\"onboardingStep1Title: '1 · 会话 / 文字模型'\"), true)\n  assert.equal(source.includes(\"quickStartTitle: '聊天与看图分别设置'\"), true)\n  assert.equal(source.includes(\"quickStartTitle: 'Chat and vision are configured separately'\"), true)\n",
  'client copy regression assertion',
)
writeFileSync(testPath, tests)
