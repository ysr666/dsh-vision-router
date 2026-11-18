import assert from 'node:assert/strict'
import { readFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const RC5_RELEASE_SHA = '9c2670d3bce5275e0d1610272958121af87787bb'
export const RC5_PIN_PATH = fileURLToPath(new URL('../config/dsh-022-rc5-settings-pin.json', import.meta.url))
export function validateRc5Pin(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'RC5 pin must be an object')
  assert.deepEqual(Object.keys(value).sort(), ['sha','version'])
  assert.equal(value.version, '0.2.2-rc.5', 'RC5 gate must stay on the reviewed release')
  assert.match(value.sha, /^[a-f0-9]{40}$/, 'RC5 SHA must be an immutable 40-character commit')
  assert.equal(value.sha, RC5_RELEASE_SHA, 'RC5 source must be the immutable official release commit')
  return { version: value.version, sha: value.sha }
}
export function readRc5Pin(file = RC5_PIN_PATH) {
  return validateRc5Pin(JSON.parse(readFileSync(file, 'utf8')))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['read'], 'Usage: dsh-022-rc5-pin.mjs read')
  const pin = readRc5Pin()
  const output = Object.entries(pin).map(([key,val]) => key + '=' + val).join('\n') + '\n'
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
  process.stdout.write(output)
}
