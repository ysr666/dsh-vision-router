import assert from 'node:assert/strict'
import test from 'node:test'
import { probeDoctorHostCapabilities } from '../lib/doctor-cli-p0.js'

test('Doctor consumes the live Host capability endpoint without version inference', async () => {
  let requestUrl
  const probe = await probeDoctorHostCapabilities({
    baseUrl: 'http://127.0.0.1:3080/somewhere?ignored=1',
    fetchImpl: async (url, options) => {
      requestUrl = String(url)
      assert.equal(options.method, 'GET')
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            capabilities: {
              batchAttachments: true,
              maxImageDimension: true,
              adapterRegistration: true,
              registrationReplace: 'unknown',
              jobs: true,
              settingsLiveNamespace: true,
              prepareCall: true,
            },
          }
        },
      }
    },
  })

  assert.equal(requestUrl, 'http://127.0.0.1:3080/_dsh/vision-router/host-capabilities')
  assert.equal(probe.ok, true)
  assert.equal(probe.source, 'live-runtime')
  assert.equal(probe.capabilities.batchAttachments, true)
  assert.equal(probe.capabilities.prepareCall, true)
  assert.equal(probe.capabilities.settingsWebExposure, 'unknown')
})

test('Doctor capability probe fails open to unknown', async () => {
  const probe = await probeDoctorHostCapabilities({
    baseUrl: 'http://127.0.0.1:3080',
    fetchImpl: async () => { throw new Error('offline') },
  })
  assert.equal(probe.ok, false)
  assert.equal(probe.source, 'runtime-unavailable')
  assert.equal(probe.capabilities.batchAttachments, 'unknown')
  assert.equal(probe.capabilities.prepareCall, 'unknown')
})

test('missing capability route is advisory rather than a Doctor failure', async () => {
  const probe = await probeDoctorHostCapabilities({
    baseUrl: 'http://127.0.0.1:3080',
    fetchImpl: async () => ({ ok: false, status: 404 }),
  })
  assert.equal(probe.ok, false)
  assert.equal(probe.status, 404)
  assert.equal(probe.capabilities.registrationReplace, 'unknown')
})
