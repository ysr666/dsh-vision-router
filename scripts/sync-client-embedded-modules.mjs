import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createClientMaintenanceActions } from '../src/lib/client-maintenance-actions.js'

const CLIENT = fileURLToPath(new URL('../src/lib/client.js', import.meta.url))
const START = '    // <generated:client-maintenance-actions>'
const END = '    // </generated:client-maintenance-actions>'

function compactGeneratedFunction(fn) {
  const lines = fn.toString().split('\n')
  for (const line of lines) {
    // Leading whitespace is safe to remove only while generated owners avoid
    // multiline template literals. Fail closed if that invariant changes.
    const unescapedBackticks = (line.match(/(^|[^\\\\])`/g) ?? []).length
    if (unescapedBackticks % 2 !== 0) {
      throw new Error('generated client owner contains a multiline template literal')
    }
  }
  return lines.map((line) => line.trimStart()).join('\n')
}

export function renderedClientMaintenanceActions() {
  return `${START}\n${compactGeneratedFunction(createClientMaintenanceActions)}\n${END}`
}

export function replaceEmbeddedClientMaintenanceActions(source) {
  const start = source.indexOf(START)
  const end = source.indexOf(END, start + START.length)
  if (start < 0 || end < 0) throw new Error('client maintenance action markers are missing')
  return source.slice(0, start) + renderedClientMaintenanceActions() + source.slice(end + END.length)
}

async function main() {
  const check = process.argv.includes('--check')
  const source = await readFile(CLIENT, 'utf8')
  const next = replaceEmbeddedClientMaintenanceActions(source)
  if (check) {
    if (source !== next) throw new Error('src/lib/client.js embedded maintenance actions are out of sync')
    console.log('client embedded modules are in sync')
    return
  }
  if (source !== next) await writeFile(CLIENT, next)
  console.log('synced client embedded modules')
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invoked) await main()
