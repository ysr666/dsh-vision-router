import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run } from '../lib/doctor-cli.js'

const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

function fixture({ good = true } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'vr-cli-'))
  const dir = path.join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  const manifest = good
    ? { dependencies: { 'dsh-vision-router': '^1.7.4' }, dsh: { profile: { bundles: ['dsh-vision-router'] } } }
    : {}
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest))
  if (good) {
    const pkg = path.join(dir, 'node_modules', 'dsh-vision-router')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
      name: 'dsh-vision-router', version: '1.7.4', main: 'entry.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(path.join(pkg, 'entry.js'), 'export default {}\n')
    writeFileSync(path.join(pkg, 'cordis.patch.yml'), '- insert: []\n')
  }
  return home
}
function capture() {
  const stdout = []; const stderr = []
  return { io: { log: (x) => stdout.push(String(x)), error: (x) => stderr.push(String(x)) }, stdout, stderr }
}
function sessionHeader() { return { type: 'session', version: 0, id: 's', createdAt: 1, delegationDepth: 0 } }
function turnStart() { return { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } }
function guard(seq) { return { type: 'user/message', seq, time: seq + 1, data: { role: 'user', id: 'vision-router-structured-guard-stop-1', content: [{ type: 'text', text: '本轮视觉总时间预算已耗尽。不要再调用视觉工具；请基于已经获得的证据作答，并明确仍存在的不确定性。' }], source: { kind: 'plugin', plugin: 'dsh-vision-router' } } } }
function writeSession(home, lines, torn = false) {
  const dir = path.join(home, 'sessions', '--project--', 's')
  mkdirSync(dir, { recursive: true })
  let text = [JSON.stringify(sessionHeader()), ...lines.map(JSON.stringify), ''].join('\n')
  if (torn) text = text.slice(0, -1)
  writeFileSync(path.join(dir, 'session.jsonl'), text)
}

test('doctor returns nonzero and prints a red failure for a requested profile with no plugin', async () => {
  const home = fixture({ good: false })
  const cap = capture()
  const code = await run(['doctor', '--profile', 'web', '--no-runtime'], cap.io, { DSH_HOME: home })
  assert.equal(code, 1)
  assert.match(cap.stdout.join('\n'), /✗ web/)
  assert.match(cap.stderr.join('\n'), /not installed or mounted/)
})

test('doctor JSON report is parseable and healthy for a good bundle install', async () => {
  const home = fixture({ good: true })
  const cap = capture()
  const code = await run(['doctor', '--profile', 'web', '--no-runtime', '--json'], cap.io, { DSH_HOME: home })
  assert.equal(code, 0)
  const report = JSON.parse(cap.stdout.join('\n'))
  assert.equal(report.ok, true)
  assert.equal(report.doctorVersion, packageVersion)
  assert.equal(report.profiles[0].installedVersion, '1.7.4')
  assert.equal(report.profiles[0].installation.mode, 'bundle')
})

test('doctor --sessions treats an incomplete live tail as advisory, not Vision Router corruption', async () => {
  const home = fixture({ good: true })
  writeSession(home, [turnStart()], true)
  const cap = capture()
  const code = await run(['doctor', '--profile', 'web', '--no-runtime', '--sessions'], cap.io, { DSH_HOME: home })
  assert.equal(code, 0)
  assert.match(cap.stdout.join('\n'), /live\/incomplete tail/)
})

test('doctor --sessions still fails on a committed hard session corruption', async () => {
  const home = fixture({ good: true })
  writeSession(home, [turnStart(), { ...guard(2) }])
  const cap = capture()
  const code = await run(['doctor', '--profile', 'web', '--no-runtime', '--sessions'], cap.io, { DSH_HOME: home })
  assert.equal(code, 1)
  assert.match(cap.stderr.join('\n'), /could not be inspected safely/)
})
