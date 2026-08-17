import test from 'node:test'
import assert from 'node:assert/strict'
import { probeLocalBackends } from '../lib/local-connection-probe.js'

test('no local backends leaves the caller on its normal fallback path', async () => {
  let calls = 0
  const result = await probeLocalBackends([], async () => { calls += 1 })
  assert.equal(result, undefined)
  assert.equal(calls, 0)
})

test('one local backend preserves the original probe result shape', async () => {
  const expected = { ok: false, status: 503, error: 'offline' }
  const result = await probeLocalBackends(
    [{ name: 'local-ollama' }],
    async () => expected,
  )
  assert.equal(result, expected)
})

test('multiple local backends fall through and report the successful backend', async () => {
  const seen = []
  const result = await probeLocalBackends(
    [{ name: 'local-ollama' }, { name: 'local-lmstudio' }],
    async (provider) => {
      seen.push(provider.name)
      if (provider.name === 'local-ollama') return { ok: false, error: 'offline' }
      return { ok: true, status: 200, models: 3 }
    },
    Date.now(),
  )
  assert.deepEqual(seen, ['local-ollama', 'local-lmstudio'])
  assert.equal(result.ok, true)
  assert.equal(result.backend, 'local-lmstudio')
  assert.equal(result.fallbackUsed, true)
  assert.equal(result.attempts.length, 2)
  assert.equal(result.attempts[0].backend, 'local-ollama')
  assert.equal(result.attempts[0].ok, false)
  assert.equal(result.attempts[1].backend, 'local-lmstudio')
  assert.equal(result.attempts[1].ok, true)
})

test('multiple failed local backends return one bounded aggregate failure', async () => {
  const result = await probeLocalBackends(
    [{ name: 'local-ollama' }, { name: 'local-lmstudio' }],
    async (provider) => ({ ok: false, error: `${provider.name} down` }),
  )
  assert.equal(result.ok, false)
  assert.equal(result.error, 'all enabled local vision backends failed the connection probe')
  assert.equal(result.attempts.length, 2)
})
