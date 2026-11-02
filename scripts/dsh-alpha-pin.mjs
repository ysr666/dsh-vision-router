import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_ALPHA_PIN_PATH = fileURLToPath(new URL('../config/dsh-alpha-settings-pin.json', import.meta.url))
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+$/
const SHA_PATTERN = /^[a-f0-9]{40}$/

export function validateAlphaPin(pin) {
  assert.ok(pin && typeof pin === 'object' && !Array.isArray(pin), 'alpha pin must be a JSON object')
  assert.deepEqual(Object.keys(pin).sort(), ['sha', 'version'], 'alpha pin must only contain version and sha')
  assert.match(pin.version, VERSION_PATTERN, 'alpha pin version must be an exact alpha release')
  assert.match(pin.sha, SHA_PATTERN, 'alpha pin sha must be an immutable 40-character commit SHA')
  return { version: pin.version, sha: pin.sha }
}

export function readAlphaPin(file = DEFAULT_ALPHA_PIN_PATH) {
  return validateAlphaPin(JSON.parse(readFileSync(file, 'utf8')))
}

export function compareAlphaPin(file, targetSha) {
  assert.match(targetSha, SHA_PATTERN, 'target sha must be a full commit SHA')
  const current = readAlphaPin(file)
  return { current: current.sha, current_version: current.version, changed: String(current.sha !== targetSha) }
}

export function updateAlphaPin(file, expectedSha, version, sha) {
  assert.match(expectedSha, SHA_PATTERN, 'expected current SHA must be valid')
  const next = validateAlphaPin({ version, sha })
  const previous = readAlphaPin(file)
  assert.equal(previous.sha, expectedSha, 'alpha pin changed since compare; refusing stale update')
  assert.notEqual(previous.sha, next.sha, 'alpha pin is already current')
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  return next
}

function output(values) {
  const lines = Object.entries(values).map(([key, value]) => key + '=' + value).join('\n') + '\n'
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines)
  process.stdout.write(lines)
}

export function main(args = process.argv.slice(2)) {
  const [command, ...values] = args
  if (command === 'read' && values.length === 0) {
    const { version, sha } = readAlphaPin()
    output({ version, sha })
  } else if (command === 'compare' && values.length === 1) {
    output(compareAlphaPin(DEFAULT_ALPHA_PIN_PATH, values[0]))
  } else if (command === 'update' && values.length === 3) {
    const [current, version, sha] = values
    updateAlphaPin(DEFAULT_ALPHA_PIN_PATH, current, version, sha)
    output({ version, sha })
  } else {
    throw new Error('Usage: node scripts/dsh-alpha-pin.mjs read | compare <sha> | update <current-sha> <version> <sha>')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
