import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkPackageUpdate,
  compareSemver,
  normalizeRegistryBase,
  registryBaseFromEnv,
} from '../lib/update-check.js'

test('compareSemver follows stable and prerelease precedence', () => {
  assert.equal(compareSemver('1.1.1', '1.1.2'), -1)
  assert.equal(compareSemver('1.2.0', '1.1.9'), 1)
  assert.equal(compareSemver('v1.2.0', '1.2.0'), 0)
  assert.equal(compareSemver('1.2.0-beta.2', '1.2.0-beta.10'), -1)
  assert.equal(compareSemver('1.2.0-beta.10', '1.2.0'), -1)
  assert.equal(compareSemver('not-semver', '1.2.0'), undefined)
})

test('registry helpers respect inherited npm configuration and reject unsafe schemes', () => {
  assert.equal(registryBaseFromEnv({ npm_config_registry: 'https://registry.example.test/' }), 'https://registry.example.test')
  assert.equal(registryBaseFromEnv({ NPM_CONFIG_REGISTRY: 'http://127.0.0.1:4873///' }), 'http://127.0.0.1:4873')
  assert.equal(normalizeRegistryBase('file:///tmp/registry'), 'https://registry.npmjs.org')
})

test('checkPackageUpdate is install-method agnostic and reports a newer npm version', async () => {
  let request
  const result = await checkPackageUpdate({
    currentVersion: '1.1.1',
    registry: 'https://registry.example.test/',
    fetchImpl: async (url, init) => {
      request = { url, init }
      return {
        ok: true,
        status: 200,
        async json() {
          return { version: '1.2.0' }
        },
      }
    },
  })
  assert.equal(request.url, 'https://registry.example.test/dsh-vision-router/latest')
  assert.equal(request.init.method, 'GET')
  assert.equal(result.currentVersion, '1.1.1')
  assert.equal(result.latestVersion, '1.2.0')
  assert.equal(result.updateAvailable, true)
  assert.equal(result.installMethodAgnostic, true)
  assert.equal(result.packageSpec, 'dsh-vision-router@latest')
})

test('checkPackageUpdate treats a local/source version ahead of npm as not needing downgrade', async () => {
  const result = await checkPackageUpdate({
    currentVersion: '1.3.0-dev.1',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { version: '1.2.9' }
      },
    }),
  })
  assert.equal(result.updateAvailable, false)
  assert.equal(result.aheadOfRegistry, true)
})

test('checkPackageUpdate rejects registry failures and malformed versions', async () => {
  await assert.rejects(
    () =>
      checkPackageUpdate({
        fetchImpl: async () => ({ ok: false, status: 503, async json() { return {} } }),
      }),
    /HTTP 503/,
  )
  await assert.rejects(
    () =>
      checkPackageUpdate({
        fetchImpl: async () => ({ ok: true, status: 200, async json() { return { version: 'latest' } } }),
      }),
    /invalid version/,
  )
})
