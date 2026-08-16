import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { doctorProfiles, hasUtf8Bom, inspectProfileManifest, inspectProfileWorkspace, resolveDshHome } from '../lib/doctor.js'

function fixture(manifestText, { profile = 'web', workspace } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-doctor-'))
  const dir = path.join(home, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  const manifestPath = path.join(dir, 'package.json')
  writeFileSync(manifestPath, manifestText)
  const workspacePath = path.join(dir, 'pnpm-workspace.yaml')
  if (workspace !== undefined) writeFileSync(workspacePath, workspace)
  return { home, dir, manifestPath, workspacePath }
}

const validManifest = JSON.stringify({
  name: 'dsh-profile-web',
  dependencies: { 'dsh-vision-router': 'github:ysr666/dsh-vision-router' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-vision-router'] } },
}, null, 2) + '\n'

test('hasUtf8Bom recognizes only the UTF-8 BOM prefix', () => {
  assert.equal(hasUtf8Bom(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')])), true)
  assert.equal(hasUtf8Bom(Buffer.from('{}')), false)
  assert.equal(hasUtf8Bom(Buffer.from([0xef, 0xbb])), false)
})

test('inspectProfileManifest diagnoses BOM without mutating by default', () => {
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(validManifest)])
  const { manifestPath } = fixture(original)
  const result = inspectProfileManifest(manifestPath)
  assert.equal(result.hasBom, true)
  assert.equal(result.repaired, false)
  assert.equal(result.validJson, true)
  assert.equal(result.pluginDependency, 'github:ysr666/dsh-vision-router')
  assert.equal(result.pluginBundle, true)
  assert.deepEqual(readFileSync(manifestPath), original)
})

test('doctor reports an unresolved BOM as unhealthy and repair clears it', () => {
  const { home } = fixture(Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(validManifest),
  ]))
  const before = doctorProfiles({ dshHome: home, profile: 'web' })
  assert.equal(before.profiles[0].validJson, true)
  assert.equal(before.profiles[0].hasBom, true)
  assert.equal(before.ok, false)

  const after = doctorProfiles({ dshHome: home, profile: 'web', fix: true })
  assert.equal(after.profiles[0].repaired, true)
  assert.equal(after.ok, true)
})

test('inspectProfileManifest repair removes only the leading BOM', () => {
  const { manifestPath } = fixture(Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(validManifest),
  ]))
  const result = inspectProfileManifest(manifestPath, { fix: true })
  assert.equal(result.hasBom, true)
  assert.equal(result.repaired, true)
  assert.equal(result.validJson, true)
  assert.equal(readFileSync(manifestPath, 'utf8'), validManifest)
})

test('repair does not paper over non-BOM JSON errors', () => {
  const broken = '{"name":"web", trailing}\n'
  const { manifestPath } = fixture(Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(broken),
  ]))
  const result = inspectProfileManifest(manifestPath, { fix: true })
  assert.equal(result.repaired, true)
  assert.equal(result.validJson, false)
  assert.equal(readFileSync(manifestPath, 'utf8'), broken)
})

test('doctorProfiles can scan all profiles or a requested profile', () => {
  const first = fixture(validManifest)
  const secondDir = path.join(first.home, 'profiles', 'headless')
  mkdirSync(secondDir, { recursive: true })
  writeFileSync(path.join(secondDir, 'package.json'), '{}\n')
  mkdirSync(path.join(first.home, 'profiles', 'node_modules'), { recursive: true })

  const all = doctorProfiles({ dshHome: first.home })
  assert.deepEqual(all.profiles.map((item) => item.name), ['headless', 'web'])
  assert.equal(all.ok, true)

  const one = doctorProfiles({ dshHome: first.home, profile: 'web' })
  assert.deepEqual(one.profiles.map((item) => item.name), ['web'])
})

test('resolveDshHome respects DSH_HOME and expands tilde', () => {
  const fakeHome = path.join(tmpdir(), 'doctor-home')
  assert.equal(resolveDshHome({}, fakeHome), path.resolve(fakeHome, '.dsh'))
  assert.equal(resolveDshHome({ DSH_HOME: '~/custom-dsh' }, fakeHome), path.resolve(fakeHome, 'custom-dsh'))
})

const pinnedWorkspace = [
  'packages:',
  '  - .',
  '',
  'minimumReleaseAgeExclude:',
  "  - '@deepseek-ai/cosmokit@1.8.2'",
  '  - dsh-vision-router@1.2.0',
  '  - unrelated-pkg@0.0.1',
  '',
].join('\n')

test('inspectProfileWorkspace flags version-pinned exemptions without mutating', () => {
  const { workspacePath } = fixture(validManifest, { workspace: pinnedWorkspace })
  const result = inspectProfileWorkspace(workspacePath)
  assert.equal(result.exists, true)
  assert.deepEqual(result.pinned, ['@deepseek-ai/cosmokit@1.8.2', 'dsh-vision-router@1.2.0'])
  assert.equal(result.rewritten, false)
  assert.equal(readFileSync(workspacePath, 'utf8'), pinnedWorkspace)
})

test('inspectProfileWorkspace fix rewrites pinned entries to bare names and keeps the rest', () => {
  const { workspacePath } = fixture(validManifest, { workspace: pinnedWorkspace })
  const result = inspectProfileWorkspace(workspacePath, { fix: true })
  assert.equal(result.rewritten, true)
  assert.equal(readFileSync(workspacePath, 'utf8'), [
    'packages:',
    '  - .',
    '',
    'minimumReleaseAgeExclude:',
    "  - '@deepseek-ai/*'",
    '  - dsh-vision-router',
    '  - unrelated-pkg@0.0.1',
    '',
  ].join('\n'))
})

test('inspectProfileWorkspace drops a pinned entry that duplicates an existing bare name', () => {
  const workspace = [
    'packages:',
    '  - .',
    '',
    'minimumReleaseAgeExclude:',
    '  - dsh-vision-router',
    '  - dsh-vision-router@1.2.0',
    '',
  ].join('\n')
  const { workspacePath } = fixture(validManifest, { workspace })
  const result = inspectProfileWorkspace(workspacePath, { fix: true })
  assert.equal(result.rewritten, true)
  assert.equal(readFileSync(workspacePath, 'utf8'), [
    'packages:',
    '  - .',
    '',
    'minimumReleaseAgeExclude:',
    '  - dsh-vision-router',
    '',
  ].join('\n'))
})

test('doctorProfiles treats a version-pinned exemption as unhealthy until repaired', () => {
  const { home } = fixture(validManifest, { workspace: pinnedWorkspace })
  const before = doctorProfiles({ dshHome: home, profile: 'web' })
  assert.equal(before.ok, false)
  assert.deepEqual(before.profiles[0].workspace.pinned, ['@deepseek-ai/cosmokit@1.8.2', 'dsh-vision-router@1.2.0'])

  const after = doctorProfiles({ dshHome: home, profile: 'web', fix: true })
  assert.equal(after.ok, true)
  assert.equal(after.profiles[0].workspace.rewritten, true)
})

test('doctorProfiles stays healthy with bare names or no workspace file', () => {
  const bare = fixture(validManifest, {
    workspace: [
      'packages:',
      '  - .',
      '',
      'minimumReleaseAgeExclude:',
      "  - '@deepseek-ai/*'",
      '  - dsh-vision-router',
      '',
    ].join('\n'),
  })
  assert.equal(doctorProfiles({ dshHome: bare.home, profile: 'web' }).ok, true)

  const none = fixture(validManifest)
  assert.equal(doctorProfiles({ dshHome: none.home, profile: 'web' }).ok, true)
  assert.equal(doctorProfiles({ dshHome: none.home, profile: 'web' }).profiles[0].workspace.exists, false)
})
