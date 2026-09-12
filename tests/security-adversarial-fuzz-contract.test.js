import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fuzzScript = resolve(root, 'scripts/security-adversarial-fuzz.mjs')
const workflowPath = resolve(root, '.github/workflows/adversarial-fuzz.yml')

function runFuzz(seed) {
  return spawnSync(process.execPath, [fuzzScript], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DVR_FUZZ_CASES: '100',
      DVR_FUZZ_SEED: String(seed),
    },
  })
}

test('adversarial fuzz preserves and reports the replay seed', () => {
  const zeroSeed = runFuzz(0)
  assert.equal(zeroSeed.status, 0, zeroSeed.stderr)
  assert.match(zeroSeed.stdout, /security adversarial fuzz passed: cases=100 seed=0/)

  const first = runFuzz(1592639710)
  const second = runFuzz(1592639710)
  assert.equal(first.status, 0, first.stderr)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(first.stdout, second.stdout)
  assert.match(first.stdout, /seed=1592639710/)
})

test('fuzz workflow keeps a fixed PR corpus and rotating scheduled exploration', () => {
  const workflow = readFileSync(workflowPath, 'utf8')
  assert.match(workflow, /Fuzz deterministic regression corpus/)
  assert.match(workflow, /DVR_FUZZ_CASES: '500'/)
  assert.match(workflow, /DVR_FUZZ_SEED: '1592639710'/)
  assert.match(workflow, /Derive rotating exploration seed/)
  assert.match(workflow, /GITHUB_RUN_ID/)
  assert.match(workflow, /DVR_FUZZ_CASES: '1500'/)
  assert.match(workflow, /steps\.exploration_seed\.outputs\.seed/)
  assert.match(workflow, /GITHUB_STEP_SUMMARY/)
  assert.match(workflow, /\.github\/workflows\/adversarial-fuzz\.yml/)
})
