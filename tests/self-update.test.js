import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  detectDshSelfUpdatePlan,
  findDshPackageRoot,
  profileFromArgv,
  runDshPluginUpdate,
  updateTookEffect,
} from '../lib/self-update.js'

function fixture({ entry = 'bin/dsh.mjs', packageName = '@deepseek-ai/dsh' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'vision-router-dsh-'))
  mkdirSync(path.join(root, path.dirname(entry)), { recursive: true })
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: packageName, version: '0.1.0-rc.6' }),
  )
  const cliEntry = path.join(root, entry)
  writeFileSync(cliEntry, '#!/usr/bin/env node\n')
  return { root, cliEntry }
}

// A fake $DSH_HOME with a profile whose node_modules already materializes the
// plugin at `installedVersion`, declared by the profile with `dependencySpec`.
function profileFixture({
  profile = 'web',
  installedVersion = '1.4.0',
  dependencySpec = '^1.2.0',
  withInstalledManifest = true,
} = {}) {
  const dshHome = mkdtempSync(path.join(tmpdir(), 'vision-router-home-'))
  const profileDir = path.join(dshHome, 'profiles', profile)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ dependencies: { 'dsh-vision-router': dependencySpec } }),
  )
  if (withInstalledManifest) {
    mkdirSync(path.join(profileDir, 'node_modules', 'dsh-vision-router'), { recursive: true })
    writeFileSync(
      path.join(profileDir, 'node_modules', 'dsh-vision-router', 'package.json'),
      JSON.stringify({ name: 'dsh-vision-router', version: installedVersion }),
    )
  }
  return { dshHome }
}

function planFor(cliEntry, profile = 'web') {
  return {
    available: true,
    method: 'current-dsh-cli',
    execPath: '/opt/node/bin/node',
    cliEntry,
    profile,
  }
}

const exitZero = async (_file, _args, _options) => ({ stdout: 'downloaded 0 / added 0\n', stderr: '' })

test('profileFromArgv honors explicit profiles and defaults Web hosts to web', () => {
  assert.equal(profileFromArgv(['node', 'dsh', 'web']), 'web')
  assert.equal(profileFromArgv(['node', 'dsh', '--profile', 'custom-web', 'web']), 'custom-web')
  assert.equal(profileFromArgv(['node', 'dsh', '--profile=lab.1', 'web']), 'lab.1')
  assert.equal(profileFromArgv(['node', 'dsh', '--profile', '../bad', 'web']), undefined)
})

test('findDshPackageRoot only trusts an owning @deepseek-ai/dsh manifest', () => {
  const trusted = fixture()
  // macOS symlinks /var -> /private/var: the walk realpaths the entry, so
  // compare against the realpath'd root (identical on Linux CI).
  assert.equal(findDshPackageRoot(trusted.cliEntry)?.packageRoot, realpathSync(trusted.root))
  const unrelated = fixture({ packageName: 'not-dsh' })
  assert.equal(findDshPackageRoot(unrelated.cliEntry), undefined)
})

test('detectDshSelfUpdatePlan reuses a verified packaged DSH CLI', () => {
  const { root, cliEntry } = fixture()
  const plan = detectDshSelfUpdatePlan({
    argv: ['/usr/bin/node', cliEntry, 'web'],
    execPath: '/usr/bin/node',
  })
  assert.equal(plan.available, true)
  assert.equal(plan.method, 'current-dsh-cli')
  assert.equal(plan.cliEntry, realpathSync(cliEntry))
  assert.equal(plan.packageRoot, realpathSync(root))
  assert.equal(plan.profile, 'web')
  assert.equal(plan.dshVersion, '0.1.0-rc.6')
})

test('detectDshSelfUpdatePlan refuses unverified or loader-dependent CLI entries', () => {
  const unrelated = fixture({ packageName: 'not-dsh' })
  assert.deepEqual(
    detectDshSelfUpdatePlan({ argv: ['node', unrelated.cliEntry, 'web'], execPath: 'node' }),
    { available: false, reason: 'unverified-dsh-cli' },
  )

  const source = fixture({ entry: 'src/cli.ts' })
  assert.deepEqual(
    detectDshSelfUpdatePlan({ argv: ['node', source.cliEntry, 'web'], execPath: 'node' }),
    { available: false, reason: 'source-cli-needs-loader', profile: 'web' },
  )
})

test('updateTookEffect requires the installed version to reach the target', () => {
  assert.equal(updateTookEffect({ installedVersion: '1.4.0', targetVersion: '1.4.0' }).effect, true)
  assert.equal(updateTookEffect({ installedVersion: '1.5.0', targetVersion: '1.4.0' }).effect, true)
  assert.equal(updateTookEffect({ installedVersion: '1.2.0', targetVersion: '1.4.0' }).effect, false)
  assert.equal(updateTookEffect({ installedVersion: undefined, targetVersion: '1.4.0' }).effect, false)
  // Without a target the installed version must be strictly newer than the
  // running bundle: staying equal is exactly the false-success case.
  assert.equal(updateTookEffect({ installedVersion: '1.3.0', currentVersion: '1.2.0' }).effect, true)
  assert.equal(updateTookEffect({ installedVersion: '1.2.0', currentVersion: '1.2.0' }).effect, false)
})

test('runDshPluginUpdate installs the confirmed target explicitly and verifies it', async () => {
  const { cliEntry } = fixture()
  const { dshHome } = profileFixture({ profile: 'custom-web', installedVersion: '1.4.0' })
  const plan = planFor(cliEntry, 'custom-web')
  let invocation
  const result = await runDshPluginUpdate(plan, {
    targetVersion: '1.4.0',
    dshHome,
    env: { TEST_ENV: '1' },
    execFileImpl: async (file, args, options) => {
      invocation = { file, args, options }
      return { stdout: 'added dsh-vision-router@1.4.0\n', stderr: '' }
    },
  })

  assert.equal(invocation.file, '/opt/node/bin/node')
  assert.deepEqual(invocation.args, [
    cliEntry,
    'plugin',
    '--profile',
    'custom-web',
    'add',
    'dsh-vision-router@1.4.0',
  ])
  assert.equal(invocation.options.shell, false)
  assert.equal(invocation.options.windowsHide, true)
  assert.equal(invocation.options.env.TEST_ENV, '1')
  assert.equal(result.ok, true)
  assert.equal(result.installedVersion, '1.4.0')
  assert.equal(result.verified, true)
  assert.equal(result.restartRequired, true)
})

test('runDshPluginUpdate keeps update semantics without a target and verifies the move', async () => {
  const { cliEntry } = fixture()
  const { dshHome } = profileFixture({ installedVersion: '1.3.0' })
  let invocation
  const result = await runDshPluginUpdate(planFor(cliEntry), {
    currentVersion: '1.2.0',
    dshHome,
    execFileImpl: async (file, args, options) => {
      invocation = { file, args, options }
      return { stdout: 'updated\n', stderr: '' }
    },
  })

  assert.deepEqual(invocation.args.slice(4), ['update', 'dsh-vision-router'])
  assert.equal(result.ok, true)
  assert.equal(result.installedVersion, '1.3.0')
})

test('runDshPluginUpdate falls back to update for non-registry specs', async () => {
  const { cliEntry } = fixture()
  const { dshHome } = profileFixture({
    installedVersion: '1.4.0',
    dependencySpec: 'github:ysr666/dsh-vision-router',
  })
  let invocation
  const result = await runDshPluginUpdate(planFor(cliEntry), {
    targetVersion: '1.4.0',
    currentVersion: '1.2.0',
    dshHome,
    execFileImpl: async (file, args, options) => {
      invocation = { file, args, options }
      return { stdout: 'updated\n', stderr: '' }
    },
  })

  assert.deepEqual(invocation.args.slice(4), ['update', 'dsh-vision-router'])
  assert.equal(result.ok, true)
  assert.equal(result.installedVersion, '1.4.0')
})

test('runDshPluginUpdate rejects a false-success update that kept the old version', async () => {
  const { cliEntry } = fixture()
  const { dshHome } = profileFixture({ installedVersion: '1.2.0' })
  let message = ''
  try {
    await runDshPluginUpdate(planFor(cliEntry), {
      targetVersion: '1.4.0',
      currentVersion: '1.2.0',
      dshHome,
      execFileImpl: exitZero,
    })
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }

  assert.match(message, /update did not take effect/)
  assert.match(message, /1\.2\.0/)
  assert.match(message, /minimumReleaseAge/)
  assert.match(message, /downloaded 0 \/ added 0/)
  assert.match(message, /add dsh-vision-router@1\.4\.0/)
})

test('runDshPluginUpdate rejects an update that leaves no readable installed manifest', async () => {
  const { cliEntry } = fixture()
  const { dshHome } = profileFixture({ withInstalledManifest: false })
  await assert.rejects(
    () =>
      runDshPluginUpdate(planFor(cliEntry), {
        targetVersion: '1.4.0',
        currentVersion: '1.2.0',
        dshHome,
        execFileImpl: exitZero,
      }),
    /installed version is unreadable/,
  )
})

test('runDshPluginUpdate surfaces bounded updater output on failure', async () => {
  await assert.rejects(
    () =>
      runDshPluginUpdate(
        {
          available: true,
          method: 'current-dsh-cli',
          execPath: 'node',
          cliEntry: '/tmp/dsh.mjs',
          profile: 'web',
        },
        {
          execFileImpl: async () => {
            const error = new Error('exit 1')
            error.stderr = 'package manager failed'
            throw error
          },
        },
      ),
    /package manager failed/,
  )
})
