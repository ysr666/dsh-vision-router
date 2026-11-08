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


test('DVR 3.2 Doctor tells the user about legacy Connection rows but never prints trust values in issue templates', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-cli-connection-retirement-'))
  const profileDir = path.join(home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  materializeHealthyProfile(profileDir)
  const original = [
    '- id: connection',
    '  config:',
    '    trustedHosts: !!js "private.example.invalid?token=do-not-print"',
    '  inject: [webStartup, visionRouterWebConnectionReady]',
    '',
  ].join('\n')
  const patch = path.join(profileDir, 'cordis.patch.yml')
  writeFileSync(patch, original)
  const run = (argv) => spawnSync(process.execPath, [modulePath, ...argv], {
    encoding: 'utf8', env: { ...process.env, DSH_HOME: home },
  })
  const doctor = run(['doctor', '--no-runtime'])
  assert.equal(doctor.status, 0, doctor.stderr)
  assert.match(doctor.stdout, /Profile-owned Connection override detected/)
  assert.match(doctor.stdout, /retired visionRouterWebConnectionReady bridge/)
  assert.equal(readFileSync(patch, 'utf8'), original)
  const blocked = run(['doctor', '--upgrade-preflight', '--no-runtime'])
  assert.equal(blocked.status, 1, '3.2 upgrade gate must not treat dangerous Connection warnings as ready')
  assert.match(blocked.stderr, /PROFILE_CONNECTION_OVERRIDE/)
  assert.match(blocked.stderr, /RETIRED_READY_BRIDGE_REFERENCE/)
  const blockedJson = run(['doctor', '--upgrade-preflight', '--no-runtime', '--json'])
  assert.equal(blockedJson.status, 1)
  const data = JSON.parse(blockedJson.stdout)
  assert.equal(data.ok, false)
  assert.equal(data.upgradePreflight.pass, false)
  assert.equal(data.upgradePreflight.fullReleaseApproval, false)
  assert.deepEqual(data.upgradePreflight.blockers.map((x) => x.code).sort(), [
    'PROFILE_CONNECTION_OVERRIDE', 'RETIRED_READY_BRIDGE_REFERENCE',
  ])
  assert.doesNotMatch(blockedJson.stdout, /private\.example\.invalid|do-not-print/)
  const refusedFix = run(['doctor', '--upgrade-preflight', '--fix', '--no-runtime'])
  assert.equal(refusedFix.status, 2, 'read-only preflight must reject repair')
  assert.equal(readFileSync(patch, 'utf8'), original)
  const report = run(['doctor', '--issue-template', '--no-runtime'])
  assert.equal(report.status, 0, report.stderr)
  assert.match(report.stdout, /Profile-owned Connection overrides: 1 profile/)
  assert.match(report.stdout, /Retired private Connection-bridge references: 1 profile/)
  assert.doesNotMatch(report.stdout, /private\.example\.invalid|do-not-print/)
  assert.equal(readFileSync(patch, 'utf8'), original)
})


test('upgrade preflight gates workspace pins but never changes ordinary Doctor semantics', async () => {
  const { assessUpgradeProfileRisk } = await import('../lib/doctor-cli.js')
  const base = {
    ok: true,
    profiles: [{
      installation: { applicable: true, ok: true },
      workspace: { pinned: ['old-minimum-release-exclusion'], rewritten: false },
      patch: { connectionOverrideRows: 0, retiredReadyBridgeRows: 0, retiredReadyInjectionRows: 0 },
    }],
  }
  const blocked = assessUpgradeProfileRisk(base, { nodeSupported: true })
  assert.equal(blocked.pass, false)
  assert.deepEqual(blocked.blockers, [
    { code: 'STALE_WORKSPACE_RELEASE_AGE_PIN', affectedProfiles: 1 },
  ])
  assert.equal(blocked.actualDesktopHostVersionVerified, false)
  assert.equal(blocked.fullReleaseApproval, false)

  const clean = assessUpgradeProfileRisk({
    ...base,
    profiles: [{ ...base.profiles[0], workspace: { pinned: [], rewritten: false } }],
  }, { nodeSupported: true })
  assert.equal(clean.pass, true)
  assert.deepEqual(clean.blockers, [])
  assert.equal(clean.scope, 'known-profile-risks-only')
  assert.equal(clean.runtimeAndHistoricalDataVerified, false)

  const oldNode = assessUpgradeProfileRisk(base, { nodeSupported: false })
  assert.deepEqual(oldNode.blockers.map((item) => item.code), [
    'STALE_WORKSPACE_RELEASE_AGE_PIN', 'NODE_BELOW_3_2_MINIMUM',
  ])
})


test('upgrade preflight refuses floating GitHub DVR sources while preserving immutable refs', async () => {
  const { assessUpgradeProfileRisk, isFloatingDvrGitSource } = await import('../lib/doctor-cli.js')
  const floating = [
    'github:ysr666/dsh-vision-router',
    'github:ysr666/dsh-vision-router#main',
    'github:ysr666/dsh-vision-router#master',
    'github:ysr666/dsh-vision-router#semver:^3.1.0',
    'git+https://github.com/ysr666/dsh-vision-router.git#feature-branch',
  ]
  const fixed = [
    '3.1.2',
    '3.1.4',
    'github:ysr666/dsh-vision-router#v2.3.0',
    'github:ysr666/dsh-vision-router#41b048647a5c5b2f6aa7d3fdc5eec3cc5b8db2ec',
  ]
  for (const value of floating) assert.equal(isFloatingDvrGitSource(value), true, value)
  for (const value of fixed) assert.equal(isFloatingDvrGitSource(value), false, value)
  const profile = (dependency) => ({
    installation: { applicable: true, ok: true },
    workspace: { pinned: [], rewritten: false },
    patch: { connectionOverrideRows: 0, retiredReadyBridgeRows: 0, retiredReadyInjectionRows: 0 },
    pluginDependency: dependency,
  })
  const inspected = assessUpgradeProfileRisk({
    ok: true,
    profiles: [
      profile(floating[0]), profile(floating[1]), profile(floating[2]),
      profile(fixed[0]), profile(fixed[2]), profile(fixed[3]),
      { ...profile(floating[3]), installation: { applicable: false } },
    ],
  }, { nodeSupported: true })
  assert.equal(inspected.pass, false)
  assert.deepEqual(inspected.blockers, [
    { code: 'FLOATING_GITHUB_DVR_SOURCE', affectedProfiles: 3 },
  ])
  assert.equal(inspected.profileCount, 6)
  assert.equal(inspected.fullReleaseApproval, false)
  assert.doesNotMatch(JSON.stringify(inspected), /ysr666|github:/,
    'only reason-code counts are allowed in public upgrade preflight')
})
