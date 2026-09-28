import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { probeDoctorHostCapabilities, run } from '../lib/doctor-cli-p0.js'
import { DOCTOR_RESPONSE_MAX_BYTES } from '../lib/http-body-limit.js'

test('Doctor consumes the live Host capability endpoint without version inference', async () => {
  let requestUrl
  const probe = await probeDoctorHostCapabilities({
    baseUrl: 'http://127.0.0.1:3080/somewhere?ignored=1',
    fetchImpl: async (url, options) => {
      requestUrl = String(url)
      assert.equal(options.method, 'GET')
      return new Response(JSON.stringify({
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
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  assert.equal(requestUrl, 'http://127.0.0.1:3080/_dsh/vision-router/host-capabilities')
  assert.equal(probe.ok, true)
  assert.equal(probe.source, 'live-runtime')
  assert.equal(probe.capabilities.batchAttachments, true)
  assert.equal(probe.capabilities.prepareCall, true)
  assert.equal(probe.capabilities.settingsWebExposure, 'unknown')
})


test('Doctor capability probe rejects and cancels an oversized declared response without reading its body', async () => {
  let pulls = 0
  let cancelled = false
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1
      controller.enqueue(new Uint8Array(1))
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })

  const probe = await probeDoctorHostCapabilities({
    baseUrl: 'http://127.0.0.1:3080',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return String(name).toLowerCase() === 'content-length'
            ? String(DOCTOR_RESPONSE_MAX_BYTES + 1)
            : null
        },
      },
      body: stream,
    }),
  })
  assert.equal(pulls, 0, 'declared oversize must be rejected before reading a body chunk')
  assert.equal(cancelled, true, 'declared oversize must cancel the unread body immediately')
  assert.equal(probe.ok, false)
  assert.equal(probe.source, 'runtime-unavailable')
  assert.match(probe.error, /16384-byte response limit/)
})

test('Doctor capability probe cancels a chunked response as soon as the decoded body exceeds 16 KiB', async () => {
  let pulls = 0
  let cancelled = false
  const chunks = [10 * 1024, 10 * 1024, 10 * 1024]
  const stream = new ReadableStream({
    pull(controller) {
      if (pulls >= chunks.length) return controller.close()
      controller.enqueue(new Uint8Array(chunks[pulls++]))
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })

  const probe = await probeDoctorHostCapabilities({
    baseUrl: 'http://127.0.0.1:3080',
    fetchImpl: async () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  })
  assert.equal(probe.ok, false)
  assert.equal(probe.source, 'runtime-unavailable')
  assert.match(probe.error, /16384-byte response limit/)
  assert.equal(cancelled, true)
  assert.ok(pulls <= 2, `bounded reader should stop after the first overflowing chunk; pulls=${pulls}`)
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

test('authenticated capability route reports auth-required unknown without claiming Host capabilities', async () => {
  const probe = await probeDoctorHostCapabilities({
    baseUrl: 'http://127.0.0.1:3080',
    fetchImpl: async () => ({ ok: false, status: 401 }),
  })
  assert.equal(probe.ok, false)
  assert.equal(probe.source, 'runtime-auth-required')
  assert.equal(probe.status, 401)
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


test('Doctor JSON keeps public support policy separate from verification evidence', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dvr-host-policy-'))
  const stdout = []
  const stderr = []
  await run(['doctor', '--no-runtime', '--json'], {
    log: (value) => stdout.push(String(value)),
    error: (value) => stderr.push(String(value)),
  }, { DSH_HOME: home })

  const report = JSON.parse(stdout.join('\n'))
  assert.deepEqual(report.hostSupportWindow, {
    dvrTrain: '2.2.x',
    minimum: '0.1.0-rc.8',
    currentStable: '0.1.5-rc.3',
  })
  assert.deepEqual(report.hostVerificationEvidence, {
    exactStable: '0.1.5-rc.3',
    exactPreview: '0.1.7-rc.2',
    stableCanaryDistTag: 'latest',
    previewCanaryDistTag: 'alpha',
  })
  assert.equal(Object.hasOwn(report.hostSupportWindow, 'canary'), false)
  assert.equal(Object.hasOwn(report.hostSupportWindow, 'preview'), false)
})
