import assert from 'node:assert/strict'
import { readFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const RC1_PIN_PATH = fileURLToPath(new URL('../config/dsh-rc1-settings-pin.json', import.meta.url))
export function validateRc1Pin(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'RC1 pin must be an object')
  assert.deepEqual(Object.keys(value).sort(), ['sha','version'])
  assert.equal(value.version, '0.2.2-rc.1', 'RC1 gate must stay on the reviewed release')
  assert.match(value.sha, /^[a-f0-9]{40}$/, 'RC1 SHA must be an immutable 40-character commit')
  return { version: value.version, sha: value.sha }
}
export function readRc1Pin(file = RC1_PIN_PATH) {
  return validateRc1Pin(JSON.parse(readFileSync(file, 'utf8')))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['read'], 'Usage: dsh-rc1-pin.mjs read')
  const pin = readRc1Pin()
  const output = Object.entries(pin).map(([key,val]) => key + '=' + val).join('\n') + '\n'
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
  process.stdout.write(output)
}
