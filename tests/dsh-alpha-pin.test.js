import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  compareAlphaPin,
  DEFAULT_ALPHA_PIN_PATH,
  readAlphaPin,
  updateAlphaPin,
  validateAlphaPin,
} from '../scripts/dsh-alpha-pin.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const oldSha = '1517a4dbca0a2789ff1d41ba439600f8547d23fa'
const nextSha = 'f3803c96974ad4a94195fb97e5c637e9c2a3afe3'
const oldVersion = '0.2.1-alpha.5'
const nextVersion = '0.2.2-alpha.2'

test('reviewed alpha pin remains immutable and has a matching exact version', () => {
  const pin = readAlphaPin()
  assert.match(pin.version, /^[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+$/)
  assert.match(pin.sha, /^[a-f0-9]{40}$/)
  assert.equal(DEFAULT_ALPHA_PIN_PATH, path.join(root, 'config/dsh-alpha-settings-pin.json'))
})

test('compare emits a nonempty current SHA and changed status through GitHub output', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dvr-alpha-pin-'))
  try {
    const output = path.join(dir, 'github-output.txt')
    const currentSha = readAlphaPin().sha
    const otherSha = currentSha === nextSha ? oldSha : nextSha
    const cli = path.join(root, 'scripts/dsh-alpha-pin.mjs')
    const run = (sha) => spawnSync(process.execPath, [cli, 'compare', sha], {
      env: { ...process.env, GITHUB_OUTPUT: output },
      encoding: 'utf8',
    })
    assert.equal(run(currentSha).status, 0)
    assert.ok(readFileSync(output, 'utf8').includes('current=' + currentSha))
    assert.match(readFileSync(output, 'utf8'), /changed=false/)
    writeFileSync(output, '')
    assert.equal(run(otherSha).status, 0)
    assert.ok(readFileSync(output, 'utf8').includes('current=' + currentSha))
    assert.match(readFileSync(output, 'utf8'), /changed=true/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('alpha pin compare and write reject stale state and invalid values', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dvr-alpha-pin-'))
  try {
    const file = path.join(dir, 'pin.json')
    writeFileSync(file, JSON.stringify({ version: oldVersion, sha: oldSha }))
    assert.deepEqual(compareAlphaPin(file, nextSha), {
      current: oldSha,
      current_version: oldVersion,
      changed: 'true',
    })
    assert.throws(() => updateAlphaPin(file, nextSha, nextVersion, nextSha), /changed since compare/)
    assert.throws(() => updateAlphaPin(file, oldSha, '0.2.2-rc.1', nextSha), /exact alpha/)
    assert.throws(() => updateAlphaPin(file, oldSha, nextVersion, 'bad'), /40-character/)
    assert.throws(() => compareAlphaPin(file, 'bad'), /full commit SHA/)
    assert.deepEqual(updateAlphaPin(file, oldSha, nextVersion, nextSha), { version: nextVersion, sha: nextSha })
    assert.deepEqual(readAlphaPin(file), { version: nextVersion, sha: nextSha })
    assert.throws(() => updateAlphaPin(file, oldSha, nextVersion, nextSha), /changed since compare/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reject malformed pin files and injected GitHub output values', () => {
  for (const invalid of [
    null,
    [],
    {},
    { version: oldVersion, sha: oldSha, extra: true },
    { version: '0.2.1-alpha.5\nchanged=true', sha: oldSha },
    { version: oldVersion, sha: oldSha + '\nchanged=true' },
    { version: oldVersion, sha: 'g'.repeat(40) },
  ]) {
    assert.throws(() => validateAlphaPin(invalid))
  }
})

test('the host gate loads reviewed pin in all three job families, and the bot stages config only', () => {
  const gate = readFileSync(path.join(root, '.github/workflows/dsh-alpha-settings-host-gate.yml'), 'utf8')
  const updater = readFileSync(path.join(root, '.github/workflows/dsh-alpha-pin-refresh.yml'), 'utf8')
  const count = (source, needle) => source.split(needle).length - 1
  assert.equal(count(gate, 'run: node dvr/scripts/dsh-alpha-pin.mjs read'), 3)
  const locked = '05b1cae8db6e674c5685101494d4eec24652424a'
  assert.equal(count(gate, 'ref: ' + locked), 3)
  assert.equal(count(gate, 'ref: ' + '$' + '{{ steps.pin.outputs.sha }}'), 0)
  assert.equal(count(gate, 'Reject an Alpha pin change without a reviewed immutable checkout update'), 3)
  assert.equal(count(gate, 'test "$REVIEWED_SHA" = ' + "'" + locked + "'"), 3)
  assert.equal(readAlphaPin().sha, locked, 'a pin bump must be accompanied by an explicit human-reviewed workflow source update')
  assert.equal(count(gate, 'DSH_EXPECTED_VERSION: ' + '$' + '{{ steps.pin.outputs.version }}'), 5)
  assert.equal(count(gate, 'DSH_EXPECTED_COMMIT: ' + '$' + '{{ steps.pin.outputs.sha }}'), 1)
  assert.ok(gate.includes("      - 'config/dsh-alpha-settings-pin.json'"))
  assert.ok(gate.includes("      - 'scripts/dsh-alpha-pin.mjs'"))
  assert.doesNotMatch(gate, /ref: [a-f0-9]{40}.*dsh-v0\.2\.1-alpha\.5/)
  assert.match(updater, /node scripts\/dsh-alpha-pin\.mjs compare "\$SHA"/)
  assert.match(updater, /node scripts\/dsh-alpha-pin\.mjs update "\$CURRENT" "\$VERSION" "\$SHA"/)
  assert.match(updater, /git add config\/dsh-alpha-settings-pin\.json/)
  assert.doesNotMatch(updater, /git add .*\.github\/workflows/)
  assert.match(updater, /git diff --cached --name-only/)
  assert.match(updater, /git push --force-with-lease=/)
  assert.match(updater, /cannot create a PR under the current repository policy/)
})
