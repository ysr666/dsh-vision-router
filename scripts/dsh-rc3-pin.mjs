import assert from 'node:assert/strict'
import { readFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const RC3_RELEASE_SHA = '38a6a5c965aa99ab525161efb7cc5cf1fe62fced'
export const RC3_PIN_PATH = fileURLToPath(new URL('../config/dsh-rc3-settings-pin.json', import.meta.url))
export function validateRc3Pin(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'RC3 pin must be an object')
  assert.deepEqual(Object.keys(value).sort(), ['sha','version'])
  assert.equal(value.version, '0.2.2-rc.3', 'RC3 gate must stay on the reviewed release')
  assert.match(value.sha, /^[a-f0-9]{40}$/, 'RC3 SHA must be an immutable 40-character commit')
  assert.equal(value.sha, RC3_RELEASE_SHA, 'RC3 source must be the immutable official release commit')
  return { version: value.version, sha: value.sha }
}
export function readRc3Pin(file = RC3_PIN_PATH) {
  return validateRc3Pin(JSON.parse(readFileSync(file, 'utf8')))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['read'], 'Usage: dsh-rc3-pin.mjs read')
  const pin = readRc3Pin()
  const output = Object.entries(pin).map(([key,val]) => key + '=' + val).join('\n') + '\n'
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
  process.stdout.write(output)
}
