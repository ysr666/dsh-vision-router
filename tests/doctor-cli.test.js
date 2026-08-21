import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isCliEntry } from '../lib/doctor-cli.js'

const modulePath = fileURLToPath(new URL('../lib/doctor-cli.js', import.meta.url))
const moduleUrl = pathToFileURL(modulePath).href

function materializeHealthyProfile(profileDir) {
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    dependencies: { 'dsh-vision-router': '^1.7.4' },
    dsh: { profile: { bundles: ['dsh-vision-router'] } },
  }, null, 2))
  const pluginDir = path.join(profileDir, 'node_modules', 'dsh-vision-router')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
    name: 'dsh-vision-router', version: '1.7.4', main: 'entry.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(path.join(pluginDir, 'entry.js'), 'export default {}\n')
  writeFileSync(path.join(pluginDir, 'cordis.patch.yml'), '- insert: []\n')
}

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
  materializeHealthyProfile(profileDir)

  const binDir = mkdtempSync(path.join(tmpdir(), 'dsh-bin-'))
  const link = path.join(binDir, 'dsh-vision-router')
  symlinkSync(modulePath, link)

  const result = spawnSync(process.execPath, [link, 'doctor', '--no-runtime'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /DSH home:/)
  assert.match(result.stdout, /✓ web/)
  rmSync(binDir, { recursive: true, force: true })
})

test('repair-sessions CLI repairs the exact legacy reminder and prints the backup path', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-cli-session-repair-'))
  const sessionDir = path.join(home, 'sessions', '--project--', 'broken-session')
  mkdirSync(sessionDir, { recursive: true })
  const sessionPath = path.join(sessionDir, 'session.jsonl')
  const lines = [
    JSON.stringify({ type: 'session', version: 0, id: 'broken-session', createdAt: 1, delegationDepth: 0 }),
    JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
    JSON.stringify({
      type: 'user/message', seq: 1, time: 2,
      data: {
        role: 'user',
        content: [{ type: 'text', text: '视觉深看工具已挂载：vision_describe。现在可以直接调用已启用的工具。' }],
        source: { kind: 'plugin', plugin: 'dsh-vision-router' },
      },
      surfaceOp: 'append',
    }),
    JSON.stringify({ type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }),
    '',
  ]
  writeFileSync(sessionPath, lines.join('\n'))

  const result = spawnSync(process.execPath, [modulePath, 'repair-sessions'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Repaired session broken-session/)
  assert.match(result.stdout, /backup:/)
  assert.match(result.stdout, /Restart DSH and reopen the affected conversation/)

  const repaired = readFileSync(sessionPath, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line))
  assert.equal(repaired[2].data.id, 'vision-router-recovered-auto-mount:broken-session:1')
  const backupMention = result.stdout.match(/backup: (.+)$/m)?.[1]?.trim()
  assert.ok(backupMention)
  assert.equal(existsSync(backupMention), true)
})
