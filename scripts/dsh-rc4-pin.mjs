import assert from 'node:assert/strict'
import { readFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const RC4_RELEASE_SHA = '3f321d32bfe382212a8ed8785c1d47a5a300aa23'
export const RC4_PIN_PATH = fileURLToPath(new URL('../config/dsh-rc4-settings-pin.json', import.meta.url))
export function validateRc4Pin(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'RC4 pin must be an object')
  assert.deepEqual(Object.keys(value).sort(), ['sha','version'])
  assert.equal(value.version, '0.2.2-rc.4', 'RC4 gate must stay on the reviewed release')
  assert.match(value.sha, /^[a-f0-9]{40}$/, 'RC4 SHA must be an immutable 40-character commit')
  assert.equal(value.sha, RC4_RELEASE_SHA, 'RC4 source must be the immutable official release commit')
  return { version: value.version, sha: value.sha }
}
export function readRc4Pin(file = RC4_PIN_PATH) {
  return validateRc4Pin(JSON.parse(readFileSync(file, 'utf8')))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['read'], 'Usage: dsh-rc4-pin.mjs read')
  const pin = readRc4Pin()
  const output = Object.entries(pin).map(([key,val]) => key + '=' + val).join('\n') + '\n'
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
  process.stdout.write(output)
}
