import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isCliEntry } from '../lib/doctor-cli.js'

const modulePath = fileURLToPath(new URL('../lib/doctor-cli.js', import.meta.url))
const moduleUrl = pathToFileURL(modulePath).href

test('isCliEntry matches direct invocation paths only', () => {
  assert.equal(isCliEntry(modulePath, moduleUrl), true)
  assert.equal(isCliEntry(path.join(path.dirname(modulePath), 'other.js'), moduleUrl), false)
  assert.equal(isCliEntry('', moduleUrl), false)
  assert.equal(isCliEntry(undefined, moduleUrl), false)
})

test('doctor CLI prints a report when invoked through a symlinked bin (npx shim shape)', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-cli-'))
  const profileDir = path.join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(path.join(profileDir, 'package.json'), '{}\n')

  const binDir = mkdtempSync(path.join(tmpdir(), 'dsh-bin-'))
  const link = path.join(binDir, 'dsh-vision-router')
  symlinkSync(modulePath, link)

  const result = spawnSync(process.execPath, [link, 'doctor'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
  })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /DSH home:/)
  assert.match(result.stdout, /✓ web/)
  rmSync(binDir, { recursive: true, force: true })
})
