import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  classifyProfilePnpmFailure,
  inspectCoexistingVisionPlugins,
} from '../lib/profile-pnpm-diagnostics.js'

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

test('can attribute another declared profile dependency even without ignored-build syntax', () => {
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
