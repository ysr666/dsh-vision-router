import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { doctorProfiles, inspectProfilePatch, registrySpecSatisfiesVersion } from '../lib/doctor.js'

function makeProfile({ manifest = {}, patch, installedVersion, installedManifest, workspace, name = 'web', createInstalledTargets = true } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'vr-doctor-'))
  const dir = path.join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  if (patch !== undefined) writeFileSync(path.join(dir, 'cordis.patch.yml'), patch)
  if (workspace !== undefined) writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), workspace)
  if (installedVersion || installedManifest) {
    const pkg = path.join(dir, 'node_modules', 'dsh-vision-router')
    mkdirSync(pkg, { recursive: true })
    const installed = installedManifest ?? {
      name: 'dsh-vision-router', version: installedVersion,
      main: 'entry.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify(installed))
    if (createInstalledTargets && installed.main) writeFileSync(path.join(pkg, installed.main), 'export default {}\n')
    if (createInstalledTargets && installed.dsh?.bundle?.patch) writeFileSync(path.join(pkg, installed.dsh.bundle.patch), '- insert: []\n')
  }
  return { home, dir }
}
function bundleManifest(spec = '^1.7.4') {
  return { dependencies: { 'dsh-vision-router': spec }, dsh: { profile: { bundles: ['dsh-vision-router'] } } }
}

test('requested profile without Vision Router is unhealthy instead of a green false positive', () => {
  const { home } = makeProfile({ manifest: {} })
  const report = doctorProfiles({ dshHome: home, profile: 'web' })
  assert.equal(report.ok, false)
  assert.equal(report.profiles[0].installation.applicable, true)
  assert.match(report.profiles[0].installation.errors.join('\n'), /not installed or mounted/)
})

test('unrelated profiles are skipped when scanning all profiles', () => {
  const { home } = makeProfile({ manifest: bundleManifest(), installedVersion: '1.7.4' })
  const other = path.join(home, 'profiles', 'headless')
  mkdirSync(other, { recursive: true })
  writeFileSync(path.join(other, 'package.json'), '{}\n')
  const report = doctorProfiles({ dshHome: home })
  assert.equal(report.ok, true)
  assert.equal(report.applicableProfiles, 1)
  assert.equal(report.profiles.find((item) => item.name === 'headless').installation.applicable, false)
})

test('bundle installation requires declaration and installed package', () => {
  const missing = makeProfile({ manifest: bundleManifest() })
  assert.equal(doctorProfiles({ dshHome: missing.home, profile: 'web' }).ok, false)
  const good = makeProfile({ manifest: bundleManifest(), installedVersion: '1.7.4' })
  const report = doctorProfiles({ dshHome: good.home, profile: 'web' })
  assert.equal(report.ok, true)
  assert.equal(report.profiles[0].installation.mode, 'bundle')
})

test('dependency-only install is unhealthy because the plugin is not mounted', () => {
  const { home } = makeProfile({ manifest: { dependencies: { 'dsh-vision-router': '^1.7.4' } }, installedVersion: '1.7.4' })
  const report = doctorProfiles({ dshHome: home, profile: 'web' })
  assert.equal(report.ok, false)
  assert.equal(report.profiles[0].installation.mode, 'unmounted')
})

test('manual cordis.patch.yml mode is healthy but bundle plus manual insert is a duplicate-load error', () => {
  const manualPatch = '- insert:\n    - id: vision-router\n      name: dsh-vision-router\n'
  let profile = makeProfile({ manifest: { dependencies: { 'dsh-vision-router': '^1.7.4' } }, installedVersion: '1.7.4', patch: manualPatch })
  assert.equal(doctorProfiles({ dshHome: profile.home, profile: 'web' }).ok, true)
  assert.equal(inspectProfilePatch(path.join(profile.dir, 'cordis.patch.yml')).visionRouterRows, 1)
  profile = makeProfile({ manifest: bundleManifest(), installedVersion: '1.7.4', patch: manualPatch })
  const report = doctorProfiles({ dshHome: profile.home, profile: 'web' })
  assert.equal(report.ok, false)
  assert.equal(report.profiles[0].installation.mode, 'duplicate')
})

test('bundle plus legal by-id override remains one effective Vision Router mount', () => {
  const overridePatch = '- id: vision-router\n  config:\n    progressiveTools: true\n'
  const { home, dir } = makeProfile({ manifest: bundleManifest(), installedVersion: '1.7.4', patch: overridePatch })
  const patch = inspectProfilePatch(path.join(dir, 'cordis.patch.yml'))
  assert.equal(patch.visionRouterRows, 0)
  assert.equal(patch.visionRouterOverrideRows, 1)
  assert.equal(patch.manualVisionRouter, false)
  const report = doctorProfiles({ dshHome: home, profile: 'web' })
  assert.equal(report.ok, true)
  assert.equal(report.profiles[0].installation.mode, 'bundle')
})

test('named by-id override is still an override rather than a second mount', () => {
  const overridePatch = '- id: vision-router\n  name: dsh-vision-router\n  config:\n    progressiveTools: true\n'
  const { home, dir } = makeProfile({ manifest: bundleManifest(), installedVersion: '1.7.4', patch: overridePatch })
  const patch = inspectProfilePatch(path.join(dir, 'cordis.patch.yml'))
  assert.equal(patch.visionRouterRows, 0)
  assert.equal(patch.visionRouterOverrideRows, 1)
  const report = doctorProfiles({ dshHome: home, profile: 'web' })
  assert.equal(report.ok, true)
  assert.equal(report.profiles[0].installation.mode, 'bundle')
})

test('legacy static llm-deepseek disable is detected as a warning', () => {
  const { home, dir } = makeProfile({
    manifest: { dependencies: { 'dsh-vision-router': '^1.7.4' } }, installedVersion: '1.7.4',
    patch: '- insert:\n    - id: llm-deepseek\n      name: @deepseek-ai/dsh-llm-deepseek\n      disabled: true\n    - id: vision-router\n      name: dsh-vision-router\n',
  })
  assert.equal(inspectProfilePatch(path.join(dir, 'cordis.patch.yml')).disablesOfficialDeepSeek, true)
  const report = doctorProfiles({ dshHome: home, profile: 'web' })
  assert.equal(report.ok, true)
  assert.match(report.profiles[0].installation.warnings.join('\n'), /official model disappear/)
})

test('version-pinned release-age entries remain unhealthy until repair', () => {
  const workspace = 'minimumReleaseAgeExclude:\n  - dsh-vision-router@1.7.4\n'
  const { home } = makeProfile({ manifest: bundleManifest(), installedVersion: '1.7.4', workspace })
  assert.equal(doctorProfiles({ dshHome: home, profile: 'web' }).ok, false)
  assert.equal(doctorProfiles({ dshHome: home, profile: 'web', fix: true }).ok, true)
})

test('doctor scopes settings failures to the latest plugin start and keeps older/unscoped failures advisory', () => {
  const { home } = makeProfile({ manifest: bundleManifest(), installedVersion: '1.7.4' })
  const logDir = path.join(home, 'logs', 'vision-router')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(path.join(logDir, 'vision-router.1.log'), '[2026-01-01T00:00:00Z] [WARN] vision-router: settings save failed field=old operation=set reason=readback-mismatch detail=none\n')
  writeFileSync(path.join(logDir, 'vision-router.log'), [
    '[2026-01-01T00:00:01Z] [INFO] vision-router: diagnostics log enabled at /tmp/log (plugin=1.7.4 node=v22 platform=linux/x64)',
    '[2025-12-31T23:59:59Z] [WARN] vision-router: settings save failed field=current operation=set reason=readback-mismatch detail=none',
  ].join('\n'))
  const report = doctorProfiles({ dshHome: home, profile: 'web' })
  assert.equal(report.ok, false)
  assert.deepEqual(report.log.settingsSaveFailures, [{ field: 'current', operation: 'set', reason: 'readback-mismatch' }])
  assert.deepEqual(report.log.historicalSettingsSaveFailures, [{ field: 'old', operation: 'set', reason: 'readback-mismatch' }])
})

test('manual mode without a persistent dependency and duplicate bundle rows are unhealthy', () => {
  let profile = makeProfile({ manifest: {}, installedVersion: '1.7.4', patch: '- insert:\n    - id: vision-router\n      name: dsh-vision-router\n' })
  assert.equal(doctorProfiles({ dshHome: profile.home, profile: 'web' }).ok, false)
  const manifest = bundleManifest(); manifest.dsh.profile.bundles.push('dsh-vision-router')
  profile = makeProfile({ manifest, installedVersion: '1.7.4' })
  assert.equal(doctorProfiles({ dshHome: profile.home, profile: 'web' }).ok, false)
})

test('declared registry range is checked against the materialized installed version', () => {
  const { home } = makeProfile({ manifest: bundleManifest('^1.8.0'), installedVersion: '1.7.4' })
  const report = doctorProfiles({ dshHome: home, profile: 'web' })
  assert.equal(report.ok, false)
  assert.match(report.profiles[0].installation.errors.join('\n'), /does not match installed/)
})

test('non-registry declarations report the real install target without inventing a version mismatch', () => {
  const { home } = makeProfile({ manifest: bundleManifest('github:ysr666/dsh-vision-router'), installedVersion: '1.7.4' })
  const report = doctorProfiles({ dshHome: home, profile: 'web' })
  assert.equal(report.ok, true)
  assert.equal(report.profiles[0].installation.declaredSpecKind, 'hosted-vcs')
  assert.equal(typeof report.profiles[0].installation.installTarget, 'string')
})

test('stable registry ranges do not falsely accept prerelease installs', () => {
  assert.equal(registrySpecSatisfiesVersion('^1.7.0', '1.8.0-rc.1'), false)
  assert.equal(registrySpecSatisfiesVersion('^1.7.0', '1.8.0'), true)
})

test('exact prerelease declarations compare using SemVer numeric prerelease identifiers', () => {
  assert.equal(registrySpecSatisfiesVersion('1.7.4-rc.10', '1.7.4-rc.10'), true)
  assert.equal(registrySpecSatisfiesVersion('1.7.4-rc.10', '1.7.4-rc.2'), false)
})

test('scan-all does not hide an invalid profile that still contains Vision Router evidence', () => {
  const { home } = makeProfile({ manifest: bundleManifest(), installedVersion: '1.7.4' })
  const bad = path.join(home, 'profiles', 'bad')
  mkdirSync(path.join(bad, 'node_modules', 'dsh-vision-router'), { recursive: true })
  writeFileSync(path.join(bad, 'package.json'), '{broken')
  writeFileSync(path.join(bad, 'node_modules', 'dsh-vision-router', 'package.json'), JSON.stringify({ name: 'dsh-vision-router', version: '1.7.4' }))
  const report = doctorProfiles({ dshHome: home })
  assert.equal(report.ok, false)
  assert.equal(report.profiles.find((item) => item.name === 'bad').installation.applicable, true)
})

test('missing package.json is still relevant when a Vision Router patch or installed package exists', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'vr-doctor-missing-'))
  const dir = path.join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'cordis.patch.yml'), '- insert:\n    - id: vision-router\n      name: dsh-vision-router\n')
  const report = doctorProfiles({ dshHome: home })
  assert.equal(report.ok, false)
  assert.equal(report.profiles[0].installation.applicable, true)
})

test('oversized profile inputs fail boundedly instead of being read without a safety limit', () => {
  const { home, dir } = makeProfile({ manifest: bundleManifest(), installedVersion: '1.7.4' })
  writeFileSync(path.join(dir, 'package.json'), ' '.repeat(1024 * 1024 + 1))
  const report = doctorProfiles({ dshHome: home, profile: 'web' })
  assert.equal(report.ok, false)
  assert.equal(report.profiles[0].oversized, true)
})

test('installed package integrity rejects wrong package identity and missing bundle patch target', () => {
  let profile = makeProfile({ manifest: bundleManifest(), installedManifest: { name: 'not-vision-router', version: '1.7.4' } })
  assert.equal(doctorProfiles({ dshHome: profile.home, profile: 'web' }).ok, false)
  profile = makeProfile({ manifest: bundleManifest(), createInstalledTargets: false, installedManifest: { name: 'dsh-vision-router', version: '1.7.4', dsh: { bundle: { patch: './missing.yml' } } })
  assert.equal(doctorProfiles({ dshHome: profile.home, profile: 'web' }).ok, false)
})
