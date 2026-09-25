import assert from 'node:assert/strict'
import test from 'node:test'
import { lookupRegistryIdentity, waitForRegistryIdentity } from '../scripts/release-registry-identity.mjs'

function response(status, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body },
  }
}

test('registry identity always targets the fixed public npm origin', async () => {
  let requestedUrl = ''
  await lookupRegistryIdentity({
    packageName: '@scope/pkg',
    version: '1.0.0+build',
    fetchImpl: async (url) => {
      requestedUrl = url
      return response(404)
    },
  })
  assert.equal(requestedUrl, 'https://registry.npmjs.org/%40scope%2Fpkg/1.0.0%2Bbuild')
})

test('registry lookup distinguishes missing, transient and exact identities', async () => {
  assert.deepEqual(
    await lookupRegistryIdentity({ packageName: 'pkg', version: '1.0.0', fetchImpl: async () => response(404) }),
    { state: 'missing' },
  )
  assert.deepEqual(
    await lookupRegistryIdentity({ packageName: 'pkg', version: '1.0.0', fetchImpl: async () => response(503) }),
    { state: 'transient', detail: 'HTTP 503' },
  )
  assert.deepEqual(
    await lookupRegistryIdentity({
      packageName: 'pkg',
      version: '1.0.0',
      fetchImpl: async () => response(200, { dist: { shasum: 'abc123' } }),
    }),
    { state: 'visible', sha1: 'abc123' },
  )
})

test('post-publish verification tolerates delayed registry propagation', async () => {
  const sequence = [404, 404, 503, 200]
  let calls = 0
  let sleeps = 0
  const result = await waitForRegistryIdentity({
    packageName: 'pkg',
    version: '1.0.0',
    expectedSha1: 'abc123',
    attempts: 8,
    delayMs: 1,
    sleepImpl: async () => { sleeps += 1 },
    fetchImpl: async () => {
      const status = sequence[calls++] ?? 200
      return status === 200
        ? response(200, { dist: { shasum: 'abc123' } })
        : response(status)
    },
  })
  assert.equal(result.state, 'exact')
  assert.equal(result.attempt, 4)
  assert.equal(calls, 4)
  assert.equal(sleeps, 3)
})

test('visible mismatched tarball fails closed immediately', async () => {
  let calls = 0
  const result = await waitForRegistryIdentity({
    packageName: 'pkg',
    version: '1.0.0',
    expectedSha1: 'expected',
    attempts: 120,
    delayMs: 1,
    sleepImpl: async () => assert.fail('mismatch must not retry'),
    fetchImpl: async () => {
      calls += 1
      return response(200, { dist: { shasum: 'different' } })
    },
  })
  assert.deepEqual(result, {
    state: 'mismatch',
    attempt: 1,
    remoteSha1: 'different',
  })
  assert.equal(calls, 1)
})

test('continuous absence times out without inventing a publish failure', async () => {
  const result = await waitForRegistryIdentity({
    packageName: 'pkg',
    version: '1.0.0',
    expectedSha1: 'abc123',
    attempts: 4,
    delayMs: 1,
    sleepImpl: async () => {},
    fetchImpl: async () => response(404),
  })
  assert.equal(result.state, 'timeout')
  assert.equal(result.attempt, 4)
  assert.equal(result.last.state, 'missing')
})

test('unexpected client/auth responses fail instead of permitting a publish', async () => {
  const result = await waitForRegistryIdentity({
    packageName: 'pkg',
    version: '1.0.0',
    expectedSha1: 'abc123',
    attempts: 4,
    delayMs: 1,
    sleepImpl: async () => assert.fail('fatal errors must not retry'),
    fetchImpl: async () => response(401),
  })
  assert.equal(result.state, 'fatal')
  assert.equal(result.attempt, 1)
  assert.equal(result.detail, 'HTTP 401')
})
