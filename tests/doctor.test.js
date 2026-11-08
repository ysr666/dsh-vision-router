import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { doctorProfiles, hasUtf8Bom, inspectProfileManifest, inspectProfilePatch, inspectProfileWorkspace, resolveDshHome } from '../lib/doctor.js'

function materializeVisionRouterIfDeclared(dir, manifestText) {
  let text = Buffer.isBuffer(manifestText) ? manifestText : Buffer.from(String(manifestText))
  if (text.length >= 3 && text[0] === 0xef && text[1] === 0xbb && text[2] === 0xbf) text = text.subarray(3)
  let manifest
  try { manifest = JSON.parse(text.toString('utf8')) } catch { return }
  const declared = manifest?.dependencies?.['dsh-vision-router']
  if (typeof declared !== 'string') return
  const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(declared) ? declared : '1.7.4'
  const pkg = path.join(dir, 'node_modules', 'dsh-vision-router')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
    name: 'dsh-vision-router', version, main: 'entry.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(path.join(pkg, 'entry.js'), 'export default {}\n')
  writeFileSync(path.join(pkg, 'cordis.patch.yml'), '- insert: []\n')
}

function fixture(manifestText, { profile = 'web', workspace } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-doctor-'))
  const dir = path.join(home, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  const manifestPath = path.join(dir, 'package.json')
  writeFileSync(manifestPath, manifestText)
  materializeVisionRouterIfDeclared(dir, manifestText)
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
  const { home } = fixture(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(validManifest)]))
  const before = doctorProfiles({ dshHome: home, profile: 'web' })
  assert.equal(before.profiles[0].validJson, true)
  assert.equal(before.profiles[0].hasBom, true)
  assert.equal(before.ok, false)
  const after = doctorProfiles({ dshHome: home, profile: 'web', fix: true })
  assert.equal(after.profiles[0].repaired, true)
  assert.equal(after.ok, true)
})

test('inspectProfileManifest repair removes only the leading BOM', () => {
  const { manifestPath } = fixture(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(validManifest)]))
  const result = inspectProfileManifest(manifestPath, { fix: true })
  assert.equal(result.hasBom, true)
  assert.equal(result.repaired, true)
  assert.equal(result.validJson, true)
  assert.equal(readFileSync(manifestPath, 'utf8'), validManifest)
})

test('repair does not paper over non-BOM JSON errors', () => {
  const broken = '{"name":"web", trailing}\n'
  const { manifestPath } = fixture(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(broken)]))
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
  'packages:', '  - .', '', 'minimumReleaseAgeExclude:',
  "  - '@deepseek-ai/cosmokit@1.8.2'", '  - dsh-vision-router@1.2.0', '  - unrelated-pkg@0.0.1', '',
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
    'packages:', '  - .', '', 'minimumReleaseAgeExclude:', "  - '@deepseek-ai/*'", '  - dsh-vision-router', '  - unrelated-pkg@0.0.1', '',
  ].join('\n'))
})

test('inspectProfileWorkspace drops a pinned entry that duplicates an existing bare name', () => {
  const workspace = ['packages:', '  - .', '', 'minimumReleaseAgeExclude:', '  - dsh-vision-router', '  - dsh-vision-router@1.2.0', ''].join('\n')
  const { workspacePath } = fixture(validManifest, { workspace })
  const result = inspectProfileWorkspace(workspacePath, { fix: true })
  assert.equal(result.rewritten, true)
  assert.equal(readFileSync(workspacePath, 'utf8'), ['packages:', '  - .', '', 'minimumReleaseAgeExclude:', '  - dsh-vision-router', ''].join('\n'))
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
  const bare = fixture(validManifest, { workspace: ['packages:', '  - .', '', 'minimumReleaseAgeExclude:', "  - '@deepseek-ai/*'", '  - dsh-vision-router', ''].join('\n') })
  assert.equal(doctorProfiles({ dshHome: bare.home, profile: 'web' }).ok, true)
  const none = fixture(validManifest)
  assert.equal(doctorProfiles({ dshHome: none.home, profile: 'web' }).ok, true)
  assert.equal(doctorProfiles({ dshHome: none.home, profile: 'web' }).profiles[0].workspace.exists, false)
})


test('DVR 3.2 Doctor warns about a profile-owned Connection override without changing it', () => {
  const { home, dir } = fixture(validManifest)
  const patchPath = path.join(dir, 'cordis.patch.yml')
  const original = [
    '# - id: connection (historical comment; must not count)',
    '- id: connection',
    '  inject: [webStartup, visionRouterWebConnectionReady]',
    '  config:',
    '    trustedHosts: !!js ctx.webRuntime.trustedHosts',
    '- insert:',
    '    - id: vision-router-web-connection-ready',
    '      name: ./presets/web-connection-ready/index.mjs',
    '',
  ].join('\n')
  writeFileSync(patchPath, original)
  const inspected = inspectProfilePatch(patchPath)
  assert.equal(inspected.connectionOverrideRows, 1)
  assert.equal(inspected.retiredReadyBridgeRows, 1)
  assert.equal(inspected.retiredReadyInjectionRows, 1)
  assert.equal(inspected.manualVisionRouter, false)
  const report = doctorProfiles({ dshHome: home, profile: 'web', fix: true })
  assert.equal(report.ok, true, 'an advisory must not destructively reject a healthy profile')
  assert.equal(report.profiles[0].installation.warnings.some((text) => text.includes('Profile-owned Connection override')), true)
  assert.equal(report.profiles[0].installation.warnings.some((text) => text.includes('retired visionRouterWebConnectionReady')), true)
  assert.equal(readFileSync(patchPath, 'utf8'), original, 'Doctor fix must not edit user trust or connection patches')
})

test('DVR 3.2 Doctor counts only structural override rows and supports multiline injection', () => {
  const { dir } = fixture(validManifest)
  const patchPath = path.join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, [
    '# - id: connection',
    '#   inject: [visionRouterWebConnectionReady]',
    '- id: harmless-plugin',
    '  name: harmless',
    '  config:',
    '    note: "connection is not an id here"',
    '  inject:',
    '    - webStartup',
    '    - visionRouterWebConnectionReady',
    '- insert:',
    '    - id: alternate-ready',
    '      name: ./presets/web-connection-ready/index.mjs',
    '',
  ].join('\n'))
  const inspected = inspectProfilePatch(patchPath)
  assert.equal(inspected.connectionOverrideRows, 0)
  assert.equal(inspected.retiredReadyBridgeRows, 1)
  assert.equal(inspected.retiredReadyInjectionRows, 1)
  assert.equal(inspected.visionRouterRows, 0)
  writeFileSync(patchPath, [
    '# - id: connection',
    '  # inject: [visionRouterWebConnectionReady]',
    '- id: harmless',
    '  config:',
    '    value: "visionRouterWebConnectionReady is part of a string, not an injection"',
    '',
  ].join('\n'))
  const clean = inspectProfilePatch(patchPath)
  assert.equal(clean.connectionOverrideRows, 0)
  assert.equal(clean.retiredReadyBridgeRows, 0)
  assert.equal(clean.retiredReadyInjectionRows, 0)
})

test('DVR 3.2 Doctor patch fields are defined when no profile patch exists', () => {
  const { dir } = fixture(validManifest)
  const missing = inspectProfilePatch(path.join(dir, 'cordis.patch.yml'))
  assert.equal(missing.connectionOverrideRows, 0)
  assert.equal(missing.retiredReadyBridgeRows, 0)
  assert.equal(missing.retiredReadyInjectionRows, 0)
})
