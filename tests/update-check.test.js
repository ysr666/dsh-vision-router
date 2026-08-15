import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkPackageUpdate,
  compareSemver,
  createCachedUpdateChecker,
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
  assert.equal(result.registry, 'https://registry.example.test')
  assert.equal(result.registryFallbackFrom, undefined)
  assert.equal(result.installMethodAgnostic, true)
  assert.equal(result.packageSpec, 'dsh-vision-router@latest')
})

test('checkPackageUpdate falls back to npmjs when an inherited pnpm/npm registry fails', async () => {
  const requests = []
  const result = await checkPackageUpdate({
    currentVersion: '1.1.1',
    registry: 'https://slow-mirror.example.test/',
    fetchImpl: async (url) => {
      requests.push(url)
      if (url.startsWith('https://slow-mirror.example.test/')) {
        throw new Error('The operation was aborted due to timeout')
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { version: '1.2.0' }
        },
      }
    },
  })
  assert.deepEqual(requests, [
    'https://slow-mirror.example.test/dsh-vision-router/latest',
    'https://registry.npmjs.org/dsh-vision-router/latest',
  ])
  assert.equal(result.ok, true)
  assert.equal(result.latestVersion, '1.2.0')
  assert.equal(result.registry, 'https://registry.npmjs.org')
  assert.equal(result.registryFallbackFrom, 'https://slow-mirror.example.test')
})

test('checkPackageUpdate reports every attempted registry when all attempts fail', async () => {
  await assert.rejects(
    () =>
      checkPackageUpdate({
        registry: 'https://mirror.example.test',
        fetchImpl: async (url) => {
          if (url.startsWith('https://mirror.example.test/')) throw new Error('mirror timeout')
          throw new Error('npmjs offline')
        },
      }),
    (error) => {
      assert.match(error.message, /https:\/\/mirror\.example\.test \(mirror timeout\)/)
      assert.match(error.message, /https:\/\/registry\.npmjs\.org \(npmjs offline\)/)
      return true
    },
  )
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

test('cached checker coalesces startup/card-open requests and reuses success', async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const checker = createCachedUpdateChecker({
    currentVersion: '1.1.1',
    successTtlMs: 60_000,
    fetchImpl: async () => {
      calls += 1
      await gate
      return { ok: true, status: 200, async json() { return { version: '1.2.0' } } }
    },
  })
  const startup = checker.check(false)
  const cardOpen = checker.check(false)
  const manualWhileRunning = checker.check(true)
  assert.equal(calls, 1)
  release()
  const [a, b, c] = await Promise.all([startup, cardOpen, manualWhileRunning])
  assert.equal(a.latestVersion, '1.2.0')
  assert.equal(b.latestVersion, '1.2.0')
  assert.equal(c.latestVersion, '1.2.0')
  assert.equal(calls, 1)
  const cached = await checker.check(false)
  assert.equal(cached.latestVersion, '1.2.0')
  assert.equal(calls, 1)
})

test('cached checker turns registry failures into non-fatal status objects', async () => {
  const checker = createCachedUpdateChecker({
    currentVersion: '1.1.1',
    fetchImpl: async () => { throw new Error('offline') },
  })
  const result = await checker.check(false)
  assert.equal(result.ok, false)
  assert.equal(result.currentVersion, '1.1.1')
  assert.match(result.error, /offline/)
  assert.match(result.error, /registry\.npmjs\.org/)
})
