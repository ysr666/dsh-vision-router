import { readFileSync, writeFileSync } from 'node:fs'

const path = 'index.js'
let source = readFileSync(path, 'utf8')
const before = `export function visionDescribePrompt(question, wantJson = false) {
  const text = String(question ?? '')
  return wantJson ? text + '\\n\\n' + describeStructuredInstruction(text) : text
}`
const after = `export function visionDescribePrompt(question, wantJson = false) {
  const raw = String(question ?? '').trim()
  const text = raw === ''
    ? 'Describe the image accurately and answer based only on visible content.'
    : raw
  return wantJson ? text + '\\n\\n' + describeStructuredInstruction(text) : text
}`
if (!source.includes(before)) {
  if (source.includes(after)) process.exit(0)
  throw new Error('visionDescribePrompt patch anchor not found')
}
source = source.replace(before, after)
writeFileSync(path, source)
