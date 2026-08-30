import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { probeRuntime, supportReport } from '../lib/doctor-runtime.js'

const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

function response(status, headers = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => normalized[name.toLowerCase()] ?? '' },
    async text() { return headers.body ?? '' },
  }
}
function routeResponse(url, extra = {}) {
  const allow = url.includes('/logs') ? 'GET, POST'
    : url.includes('settings-save-diagnostics') || url.includes('self-update') ? 'POST'
      : 'GET'
  return response(405, { allow, ...(url.includes('self-update') ? extra : {}) })
}

test('runtime probe uses a side-effect-free rejected method and catches SPA fallback as a missing route', async () => {
  const methods = []
  const report = await probeRuntime({ fetchImpl: async (url, init) => {
    methods.push(init.method)
    if (url.includes('model-capabilities')) return response(200, { 'content-type': 'text/html' })
    return routeResponse(url)
  } })
  assert.ok(methods.every((method) => method === 'DELETE'))
  assert.equal(report.reachable, true)
  assert.equal(report.ok, false)
})

test('405 plus the exact Allow contract confirms unbound routes without executing them', async () => {
  const report = await probeRuntime({ fetchImpl: async (url, init) => {
    assert.equal(init.redirect, 'manual')
    return routeResponse(url)
  } })
  assert.equal(report.reachable, true)
  assert.equal(report.ok, true)
  assert.equal(report.routes.length, 6)
  assert.ok(report.routes.every((item) => item.registered))
})

test('requested profile requires verified runtime ownership before route health can pass', async () => {
  const home = '/tmp/dsh-home'
  let report = await probeRuntime({
    requestedProfile: 'web', dshHome: home, applicableProfiles: ['web', 'desktop'],
    fetchImpl: async (url, init) => init.method === 'GET'
      ? response(200, { body: JSON.stringify({ ok: true, local: true, directory: `${home}/logs/vision-router` }) })
      : routeResponse(url),
  })
  assert.equal(report.routeOk, true)
  assert.equal(report.ownership.verified, false)
  assert.equal(report.ok, false)

  report = await probeRuntime({
    requestedProfile: 'web', dshHome: home, applicableProfiles: ['web'],
    fetchImpl: async (url, init) => init.method === 'GET'
      ? response(200, { body: JSON.stringify({ ok: true, local: true, directory: `${home}/logs/vision-router` }) })
      : routeResponse(url),
  })
  assert.equal(report.ownership.verified, true)
  assert.equal(report.ownership.profile, 'web')
  assert.equal(report.ok, true)
})

test('unreachable DSH is advisory so offline doctor can still succeed', async () => {
  const report = await probeRuntime({ requestedProfile: 'web', fetchImpl: async () => { throw new TypeError('fetch failed https://secret.invalid') } })
  assert.equal(report.reachable, false)
  assert.equal(report.ok, true)
})

test('runtime probe rejects invalid base URLs instead of treating them as offline success', async () => {
  await assert.rejects(() => probeRuntime({ baseUrl: 'file:///tmp/socket' }), /http or https/)
  await assert.rejects(() => probeRuntime({ baseUrl: 'not a url' }), /valid absolute/)
})

test('support report is schema-versioned, identifies doctor version, and omits raw secrets/paths', () => {
  const profileReport = {
    ok: true,
    dshHome: '/Users/alice/.dsh',
    profiles: [{
      name: 'web', exists: true, validJson: true, hasBom: false,
      pluginDependency: 'file:/Users/alice/private/dsh-vision-router', pluginBundle: true,
      installedPlugin: { version: '1.7.4' },
      installation: { applicable: true, mode: 'bundle', ok: true, errors: [], warnings: [], declaredSpecKind: 'local-path', installTarget: '/Users/alice/private' },
      workspace: { pinned: [] }, patch: { visionRouterRows: 0, manualVisionRouter: false, disablesOfficialDeepSeek: false },
    }],
    log: { exists: true, settingsSaveFailures: [], historicalSettingsSaveFailures: [], recentErrors: [], startupScoped: true, startupVersion: '1.7.4' },
  }
  const report = supportReport({
    profileReport,
    runtime: {
      baseUrl: 'http://alice:secret@127.0.0.1:3080/private?token=secret#frag', reachable: true, ok: true, routeOk: true,
      ownership: { verified: true, profile: 'web', version: '1.7.4' },
      routes: [{ route: '/x', status: 405, registered: true, error: 'raw-secret-error' }],
    },
    sessions: {
      ok: true, scanned: 1, affected: 1, repaired: 0, errors: [], advisories: [],
      reports: [{ sessionId: 'private-session-id', repairs: [{ kind: 'duplicate-structured-guard-stop', seq: 9 }] }],
    },
    platform: { platform: 'darwin', arch: 'arm64', node: 'v22.23.0', nodeSupported: true, nodeRequirement: '^22.19.0 || >=24.0.0', release: 'x', tesseract: { available: false }, chromium: { available: false }, sharp: [], hostPackages: [] },
  })
  const json = JSON.stringify(report)
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.doctorVersion, packageVersion)
  assert.equal(json.includes('file:/Users/alice'), false)
  assert.equal(json.includes('/Users/alice/private'), false)
  assert.equal(json.includes('secret@'), false)
  assert.equal(json.includes('token=secret'), false)
  assert.equal(json.includes('private-session-id'), false)
  assert.equal(json.includes('raw-secret-error'), false)
  assert.equal(report.runtime.baseUrl, 'http://127.0.0.1:3080/private')
})
