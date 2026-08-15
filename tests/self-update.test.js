import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  detectDshSelfUpdatePlan,
  findDshPackageRoot,
  profileFromArgv,
  runDshPluginUpdate,
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

test('profileFromArgv honors explicit profiles and defaults Web hosts to web', () => {
  assert.equal(profileFromArgv(['node', 'dsh', 'web']), 'web')
  assert.equal(profileFromArgv(['node', 'dsh', '--profile', 'custom-web', 'web']), 'custom-web')
  assert.equal(profileFromArgv(['node', 'dsh', '--profile=lab.1', 'web']), 'lab.1')
  assert.equal(profileFromArgv(['node', 'dsh', '--profile', '../bad', 'web']), undefined)
})

test('findDshPackageRoot only trusts an owning @deepseek-ai/dsh manifest', () => {
  const trusted = fixture()
  assert.equal(findDshPackageRoot(trusted.cliEntry)?.packageRoot, trusted.root)
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
  assert.equal(plan.cliEntry, cliEntry)
  assert.equal(plan.packageRoot, root)
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
    { available: false, reason: 'source-cli-needs-loader' },
  )
})

test('runDshPluginUpdate invokes the current DSH CLI without a shell', async () => {
  const { cliEntry } = fixture()
  const plan = {
    available: true,
    method: 'current-dsh-cli',
    execPath: '/opt/node/bin/node',
    cliEntry,
    profile: 'custom-web',
  }
  let invocation
  const result = await runDshPluginUpdate(plan, {
    env: { TEST_ENV: '1' },
    execFileImpl: async (file, args, options) => {
      invocation = { file, args, options }
      return { stdout: 'updated\n', stderr: '' }
    },
  })

  assert.equal(invocation.file, '/opt/node/bin/node')
  assert.deepEqual(invocation.args, [
    cliEntry,
    'plugin',
    '--profile',
    'custom-web',
    'update',
    'dsh-vision-router',
  ])
  assert.equal(invocation.options.shell, false)
  assert.equal(invocation.options.windowsHide, true)
  assert.equal(invocation.options.env.TEST_ENV, '1')
  assert.equal(result.ok, true)
  assert.equal(result.restartRequired, true)
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
