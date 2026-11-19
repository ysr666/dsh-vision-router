import assert from 'node:assert/strict'
import { readFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CURRENT_HOST_RELEASE_SHA = '9c2670d3bce5275e0d1610272958121af87787bb'
export const CURRENT_HOST_PIN_PATH = fileURLToPath(new URL('../config/dsh-current-host-pin.json', import.meta.url))
export function validateCurrentHostPin(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Current Host pin must be an object')
  assert.deepEqual(Object.keys(value).sort(), ['sha','version'])
  assert.equal(value.version, '0.2.2-rc.5', 'Current Host gate must stay on the reviewed release')
  assert.match(value.sha, /^[a-f0-9]{40}$/, 'Current Host SHA must be an immutable 40-character commit')
  assert.equal(value.sha, CURRENT_HOST_RELEASE_SHA, 'Current Host source must be the immutable official release commit')
  return { version: value.version, sha: value.sha }
}
export function readCurrentHostPin(file = CURRENT_HOST_PIN_PATH) {
  return validateCurrentHostPin(JSON.parse(readFileSync(file, 'utf8')))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['read'], 'Usage: dsh-current-host-pin.mjs read')
  const pin = readCurrentHostPin()
  const output = Object.entries(pin).map(([key,val]) => key + '=' + val).join('\n') + '\n'
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
  process.stdout.write(output)
}
