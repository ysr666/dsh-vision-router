import { readFileSync as readDvrManifest } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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
    dvrTrain: JSON.parse(readDvrManifest(new URL('../package.json', import.meta.url), 'utf8')).version.split('.').slice(0, 2).join('.') + '.x',
    minimum: '0.2.1-rc.5',
    currentRecommended: '0.2.2-rc.1',
    nodeMinimum: '24.9.0',
  })
  assert.deepEqual(report.hostVerificationEvidence, {
    exactFloor: '0.2.1-rc.5',
    exactRecommended: '0.2.2-rc.1',
    exactVerified: ['0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3', '0.2.2-rc.4'],
    stableCanaryDistTag: 'latest',
    nextCanaryDistTag: 'next',
    previewCanaryDistTag: 'alpha',
  })
  assert.equal(report.hostSupportVersionEvidence.source, 'unverified')
  assert.notEqual(report.hostSupportAdvice.level, 'ok')
  assert.equal(Object.hasOwn(report.hostSupportWindow, 'canary'), false)
  assert.equal(Object.hasOwn(report.hostSupportWindow, 'preview'), false)
})


test('Doctor text, JSON and issue template use the same installed Host version evidence without live version inference', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dvr-doctor-version-'))
  function profile(name, hostVersion, manifestName = '@deepseek-ai/dsh') {
    const dir = path.join(home, 'profiles', name)
    const plugin = path.join(dir, 'node_modules', 'dsh-vision-router')
    const host = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(plugin, { recursive: true })
    mkdirSync(host, { recursive: true })
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-vision-router': '3.4.0' }, dsh: { profile: { bundles: ['dsh-vision-router'] } },
    }))
    writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({
      name: 'dsh-vision-router', version: '3.4.0', main: 'entry.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(path.join(plugin, 'entry.js'), 'export default {}')
    writeFileSync(path.join(plugin, 'cordis.patch.yml'), '- insert: []\n')
    writeFileSync(path.join(host, 'package.json'), JSON.stringify({ name: manifestName, version: hostVersion }))
  }
  async function doctor(args) {
    const out = []
    const code = await run(['doctor', '--no-runtime', ...args], {
      log: value => out.push(String(value)), error: () => {},
    }, { DSH_HOME: home })
    return { code, text: out.join('\n') }
  }
  try {
    profile('web', '0.2.1-rc.2')
    const json = await doctor(['--profile', 'web', '--json'])
    const report = JSON.parse(json.text)
    assert.deepEqual(report.hostSupportVersionEvidence, { source: 'installed-profile-package', version: '0.2.1-rc.2' })
    assert.equal(report.hostSupportAdvice.code, 'HOST_BELOW_CURRENT_FLOOR_VERSION')
    for (const args of [[], ['--issue-template']]) {
      const result = await doctor(['--profile', 'web', ...args])
      assert.equal(result.code, json.code)
      assert.match(result.text, /installed Host version: 0\.2\.1-rc\.2/)
      assert.match(result.text, /HOST_BELOW_CURRENT_FLOOR_VERSION/)
      assert.match(result.text, /not running-process identity/)
    }
    profile('desktop', '0.2.2-rc.3')
    const mixed = JSON.parse((await doctor(['--json'])).text)
    assert.deepEqual(mixed.hostSupportVersionEvidence, { source: 'unverified', version: null })
    profile('desktop', 'TOKEN-PRIVATE-NONVERSION')
    const malformed = await doctor(['--profile', 'desktop', '--json'])
    assert.doesNotMatch(malformed.text, /TOKEN-PRIVATE-NONVERSION/)
    assert.equal(JSON.parse(malformed.text).hostSupportVersionEvidence.source, 'unverified')
    profile('desktop', '0.2.2-rc.3', 'different-package')
    assert.equal(JSON.parse((await doctor(['--profile', 'desktop', '--json'])).text).hostSupportVersionEvidence.source, 'unverified')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
