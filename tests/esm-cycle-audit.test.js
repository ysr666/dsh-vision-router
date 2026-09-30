import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('production static ESM graph is acyclic', () => {
  const script = fileURLToPath(new URL('../scripts/esm-cycle-audit.mjs', import.meta.url))
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', '--experimental-vm-modules', script],
    { encoding: 'utf8' },
  )
  assert.equal(
    result.status,
    0,
    `ESM cycle audit failed:\n${result.stdout || ''}${result.stderr || ''}`,
  )
  assert.match(result.stdout, /0 cycles/)
})
