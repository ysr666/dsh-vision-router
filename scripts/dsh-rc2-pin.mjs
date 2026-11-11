import assert from 'node:assert/strict'
import { readFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const RC2_RELEASE_SHA = 'ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c'
export const RC2_PIN_PATH = fileURLToPath(new URL('../config/dsh-rc2-settings-pin.json', import.meta.url))
export function validateRc2Pin(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'RC2 pin must be an object')
  assert.deepEqual(Object.keys(value).sort(), ['sha','version'])
  assert.equal(value.version, '0.2.2-rc.2', 'RC2 gate must stay on the reviewed release')
  assert.match(value.sha, /^[a-f0-9]{40}$/, 'RC2 SHA must be an immutable 40-character commit')
  assert.equal(value.sha, RC2_RELEASE_SHA, 'RC2 source must be the immutable official release commit')
  return { version: value.version, sha: value.sha }
}
export function readRc2Pin(file = RC2_PIN_PATH) {
  return validateRc2Pin(JSON.parse(readFileSync(file, 'utf8')))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['read'], 'Usage: dsh-rc2-pin.mjs read')
  const pin = readRc2Pin()
  const output = Object.entries(pin).map(([key,val]) => key + '=' + val).join('\n') + '\n'
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
  process.stdout.write(output)
}
