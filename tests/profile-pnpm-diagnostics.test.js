import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { doctorProfiles } from '../lib/doctor.js'
import {
  classifyProfilePnpmFailure,
  inspectCoexistingVisionPlugins,
} from '../lib/profile-pnpm-diagnostics.js'
import { runDshPluginUpdate } from '../lib/self-update.js'

function profileFixture({
  dependencies = {},
  installed = {},
} = {}) {
  const profileDir = mkdtempSync(path.join(tmpdir(), 'vision-profile-diag-'))
  writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ dependencies }, null, 2),
  )
  for (const [name, version] of Object.entries(installed)) {
    const dir = path.join(profileDir, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, version }),
    )
  }
  return profileDir
}

function dshHomeFixture({ dependencies = {}, installed = {} } = {}) {
  const dshHome = mkdtempSync(path.join(tmpdir(), 'vision-profile-home-'))
  const profileDir = path.join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ dependencies }, null, 2),
  )
  for (const [name, version] of Object.entries(installed)) {
    const dir = path.join(profileDir, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, version }),
    )
  }
  return { dshHome, profileDir }
}

test('doctor advisory detects coexisting vision plugins without calling them conflicts', () => {
  const profileDir = profileFixture({
    dependencies: {
      'dsh-vision-router': '1.5.3',
      'dsh-vision-proxy': '^0.2.5',
      'dsh-vision-sidecar': '0.1.0',
      unrelated: '1.0.0',
    },
    installed: {
      'dsh-vision-proxy': '0.2.5',
    },
  })

  assert.deepEqual(inspectCoexistingVisionPlugins(profileDir), [
    {
      name: 'dsh-vision-proxy',
      spec: '^0.2.5',
      installedVersion: '0.2.5',
    },
    {
      name: 'dsh-vision-sidecar',
      spec: '0.1.0',
      installedVersion: undefined,
    },
  ])
})

test('doctorProfiles exposes the advisory without marking an otherwise healthy profile unhealthy', () => {
  const { dshHome } = dshHomeFixture({
    dependencies: {
      'dsh-vision-router': '1.5.3',
      'dsh-vision-proxy': '0.2.5',
    },
    installed: {
      'dsh-vision-proxy': '0.2.5',
    },
  })

  const report = doctorProfiles({ dshHome, profile: 'web' })
  assert.equal(report.ok, true)
  assert.equal(report.profiles[0].coexistingVisionPlugins.length, 1)
  assert.equal(report.profiles[0].coexistingVisionPlugins[0].name, 'dsh-vision-proxy')
})

test('classifies ignored build from an existing plugin as a profile-level blocker', () => {
  const profileDir = profileFixture({
    dependencies: {
      'dsh-vision-router': '1.5.3',
      'dsh-vision-proxy': '0.2.5',
    },
    installed: {
      'dsh-vision-proxy': '0.2.5',
    },
  })
  const error = new Error('dsh: pnpm failed in profile directory C:\\Users\\admin\\.dsh\\profiles\\web')
  error.stderr = [
    'ERR_PNPM_IGNORED_BUILDS Ignored build scripts: dsh-vision-proxy@0.2.5',
    'Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.',
    'GET https://registry.npmjs.org/@img/sharp-win32-arm64/-/sharp-win32-arm64-0.34.5.tgz',
    'UND_ERR_DESTROYED',
  ].join('\n')

  const result = classifyProfilePnpmFailure(error, {
    profileDir,
    profile: 'web',
  })

  assert.equal(result.kind, 'existing-profile-dependency')
  assert.equal(result.blockers.length, 1)
  assert.equal(result.blockers[0].name, 'dsh-vision-proxy')
  assert.equal(result.blockers[0].versionedSpec, 'dsh-vision-proxy@0.2.5')
  assert.equal(result.buildApproval, true)
  assert.equal(result.sharpArtifacts, true)
  assert.equal(result.destroyedRequest, true)
  assert.match(result.message, /blocked by another dependency already present/)
  assert.match(result.message, /dsh-vision-proxy@0\.2\.5/)
  assert.match(result.message, /not evidence that dsh-vision-router itself failed/)
  assert.match(result.message, /remove dsh-vision-proxy/)
})

test('does not blame another package when the ignored build is Vision Router itself', () => {
  const profileDir = profileFixture({
    dependencies: {
      'dsh-vision-router': '1.5.3',
    },
  })
  const error = new Error('exit 1')
  error.stderr = 'ERR_PNPM_IGNORED_BUILDS Ignored build scripts: dsh-vision-router@1.5.3'

  assert.equal(classifyProfilePnpmFailure(error, { profileDir }), undefined)
})

test('does not frame Vision Router own transitive dependency sharp as a removable blocker', () => {
  const profileDir = profileFixture({
    dependencies: {
      'dsh-vision-router': '1.5.3',
    },
  })
  const error = new Error('exit 1')
  error.stderr = [
    'ERR_PNPM_IGNORED_BUILDS Ignored build scripts: sharp@0.33.5',
    'Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.',
  ].join('\n')

  const result = classifyProfilePnpmFailure(error, { profileDir, profile: 'web' })
  assert.equal(result.kind, 'ignored-build-policy')
  assert.equal(result.blockers.length, 0)
  assert.match(result.message, /sharp@0\.33\.5/)
  assert.match(result.message, /approve-builds/)
  assert.match(result.message, /approve its build instead of removing it/)
  assert.doesNotMatch(result.message, /remove sharp/)
})

test('attributes bare-name ignored build entries for declared plugins', () => {
  const profileDir = profileFixture({
    dependencies: {
      'dsh-vision-router': '1.5.3',
      esbuild: '0.25.0',
    },
  })
  const error = new Error('exit 1')
  error.stderr =
    'Ignored build scripts: esbuild, core-js. Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.'

  const result = classifyProfilePnpmFailure(error, { profileDir, profile: 'web' })
  assert.equal(result.kind, 'existing-profile-dependency')
  assert.equal(result.blockers.length, 1)
  assert.equal(result.blockers[0].name, 'esbuild')
  assert.match(result.message, /remove esbuild/)
})

test('attributes a scoped dependency named in an ignored build list', () => {
  const profileDir = profileFixture({
    dependencies: {
      'dsh-vision-router': '1.5.3',
      '@scope/tool': '2.1.0',
    },
  })
  const error = new Error('exit 1')
  error.stderr = 'Ignored build scripts: @scope/tool@2.1.0'

  const result = classifyProfilePnpmFailure(error, { profileDir, profile: 'web' })
  assert.equal(result.kind, 'existing-profile-dependency')
  assert.equal(result.blockers[0].name, '@scope/tool')
})

test('does not blame a dependency for a same-line substring match', () => {
  const profileDir = profileFixture({
    dependencies: {
      'dsh-vision-router': '1.5.3',
      'dsh-vision-proxy': '0.2.5',
    },
  })
  const error = new Error('exit 1')
  error.stderr = 'dsh-vision-proxy-core postinstall failed with exit code 1'

  assert.equal(classifyProfilePnpmFailure(error, { profileDir, profile: 'web' }), undefined)
})

test('does not blame a dependency named inside a registry URL on the same line', () => {
  const profileDir = profileFixture({
    dependencies: {
      'dsh-vision-router': '1.5.3',
      foo: '1.0.0',
    },
  })
  const error = new Error('exit 1')
  error.stderr = 'GET https://registry.npmjs.org/foo/-/foo-1.0.0.tgz ERR_PNPM_FETCH_500 registry unavailable'

  assert.equal(classifyProfilePnpmFailure(error, { profileDir, profile: 'web' }), undefined)
})

test('does not treat dsh-vision-routers or dsh-vision-router2 as coexisting vision plugins', () => {
  const profileDir = profileFixture({
    dependencies: {
      'dsh-vision-router': '1.5.3',
      'dsh-vision-routers': '9.9.9',
      'dsh-vision-router2': '9.9.9',
    },
  })

  assert.deepEqual(inspectCoexistingVisionPlugins(profileDir), [])
})

test('does not blame an existing dependency merely because pnpm progress output names it', () => {
  const profileDir = profileFixture({
    dependencies: {
      'dsh-vision-router': '1.5.3',
      'some-existing-plugin': '2.0.0',
    },
  })
  const error = new Error('network request failed')
  error.stderr = 'Progress: resolved some-existing-plugin@2.0.0\nERR_PNPM_FETCH_500 registry unavailable'

  assert.equal(classifyProfilePnpmFailure(error, { profileDir, profile: 'web' }), undefined)
})

test('can attribute another declared profile dependency when its own failure line is explicit', () => {
  const profileDir = profileFixture({
    dependencies: {
      'dsh-vision-router': '1.5.3',
      'some-existing-plugin': '2.0.0',
    },
  })
  const error = new Error('pnpm failed')
  error.stderr = 'some-existing-plugin postinstall failed with exit code 1'

  const result = classifyProfilePnpmFailure(error, { profileDir, profile: 'web' })
  assert.equal(result.kind, 'existing-profile-dependency')
  assert.equal(result.blockers[0].name, 'some-existing-plugin')
  assert.equal(result.buildApproval, false)
})

test('self updater surfaces the existing profile blocker instead of a generic Vision Router failure', async () => {
  const { dshHome } = dshHomeFixture({
    dependencies: {
      'dsh-vision-router': '1.5.3',
      'dsh-vision-proxy': '0.2.5',
    },
    installed: {
      'dsh-vision-proxy': '0.2.5',
    },
  })

  await assert.rejects(
    () => runDshPluginUpdate(
      {
        available: true,
        method: 'current-dsh-cli',
        execPath: 'node',
        cliEntry: '/tmp/dsh.mjs',
        profile: 'web',
      },
      {
        dshHome,
        execFileImpl: async () => {
          const error = new Error('exit 1')
          error.stderr = [
            'ERR_PNPM_IGNORED_BUILDS Ignored build scripts: dsh-vision-proxy@0.2.5',
            'GET https://registry.npmjs.org/@img/sharp-win32-arm64/-/sharp-win32-arm64-0.34.5.tgz',
            'UND_ERR_DESTROYED',
          ].join('\n')
          throw error
        },
      },
    ),
    (error) => {
      assert.match(error.message, /blocked by another dependency already present in profile "web"/)
      assert.match(error.message, /dsh-vision-proxy@0\.2\.5/)
      assert.match(error.message, /not evidence that dsh-vision-router itself failed/)
      assert.match(error.message, /Original pnpm output:/)
      return true
    },
  )
})
