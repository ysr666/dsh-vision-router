import { readFileSync, writeFileSync } from 'node:fs'

function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1
  if (count !== 1) throw new Error(`${label}: expected one match, got ${count}`)
  return source.replace(from, to)
}

const clientPath = 'lib/client.js'
let client = readFileSync(clientPath, 'utf8')
client = replaceOnce(
  client,
  "        if (!group || typeof group.id !== 'string' || group.id === 'vision-http') continue\n        for (const model",
  "        if (\n          !group ||\n          typeof group.id !== 'string' ||\n          group.id === 'vision-http' ||\n          group.id === 'vision-chain' ||\n          group.id.endsWith('-vision')\n        ) continue\n        for (const model",
  'exclude generated wrapper routes from diagnostics',
)
writeFileSync(clientPath, client)

const testPath = 'tests/client.test.js'
let tests = readFileSync(testPath, 'utf8')
tests = replaceOnce(
  tests,
  "    { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'qwen-vl', name: 'Qwen VL' }] },\n  ]",
  "    { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'qwen-vl', name: 'Qwen VL' }] },\n    { id: 'opencode-go-vision', name: 'opencode-go + 自动识图', models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }] },\n  ]",
  'wrapper regression fixture',
)
writeFileSync(testPath, tests)
