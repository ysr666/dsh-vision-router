import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { doctorProfiles, hasUtf8Bom, inspectProfileManifest, resolveDshHome } from '../lib/doctor.js'

function fixture(manifestText, { profile = 'web' } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-doctor-'))
  const dir = path.join(home, 'profiles', profile)
  mkdirSync(dir, { recursive: true })
  const manifestPath = path.join(dir, 'package.json')
  writeFileSync(manifestPath, manifestText)
  return { home, dir, manifestPath }
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
