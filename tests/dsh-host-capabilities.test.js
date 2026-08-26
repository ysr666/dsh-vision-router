import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatDshHostCapability,
  inspectDshHostCapabilities,
  normalizeDshHostCapabilities,
} from '../lib/dsh-host-capabilities.js'
import { installDshHostCapabilityDiagnostics } from '../lib/dsh-contract-compat.js'

test('Host capability snapshot reads seams without invoking registrations', () => {
  let registrations = 0
  const attachments = {
    saveImages() {},
    imageLimits: { maxImageDimension: 10_000 },
  }
  const llm = {
    registerAdapter() { registrations += 1 },
    prepareCall() {},
  }
  // Match the real DSH SettingsProvider shape: register() is on the service;
  // get()/watch() are on the SettingsScope returned by a registration.
  const settings = { register() { registrations += 1 } }
  const tools = { register() { registrations += 1 }, execute() {} }
  const jobs = { enqueue() {} }
  const ctx = {
    get(name) {
      return { attachments, llm, settings, tools, jobs }[name]
    },
  }

  const result = inspectDshHostCapabilities(ctx)
  assert.equal(result.batchAttachments, true)
  assert.equal(result.maxImageDimension, true)
  assert.equal(result.adapterRegistration, true)
  assert.equal(result.registrationReplace, 'unknown')
  assert.equal(result.jobs, true)
  assert.equal(result.surfaceReplacement, 'unknown')
  assert.equal(result.settingsLiveNamespace, true)
  assert.equal(result.settingsWebExposure, 'unknown')
  assert.equal(result.prepareCall, true)
  assert.equal(result.toolRegistration, true)
  assert.equal(result.toolExecution, true)
  assert.equal(registrations, 0, 'Doctor probe must not mutate Host topology')
})

test('registration replace stays unknown when only registerAdapter is observable', () => {
  const result = inspectDshHostCapabilities({
    get(name) {
      return name === 'llm' ? { registerAdapter() {} } : undefined
    },
  })
  assert.equal(result.adapterRegistration, true)
  assert.equal(result.registrationReplace, 'unknown')
})

test('unknown capability values remain explicit instead of becoming version guesses', () => {
  const result = normalizeDshHostCapabilities({ batchAttachments: true, prepareCall: false })
  assert.equal(result.batchAttachments, true)
  assert.equal(result.prepareCall, false)
  assert.equal(result.registrationReplace, 'unknown')
  assert.equal(result.settingsWebExposure, 'unknown')
  assert.equal(formatDshHostCapability(true), 'yes')
  assert.equal(formatDshHostCapability(false), 'no')
  assert.equal(formatDshHostCapability('unknown'), 'unknown')
})

test('Host capability endpoint is GET-only and diagnostics failures stay contained', async () => {
  let route
  const webCtx = {
    get(name) {
      if (name === 'attachments') return { saveImages() {}, imageLimits: { maxImageDimension: 10_000 } }
      if (name === 'llm') return { registerAdapter() {}, prepareCall() {} }
      if (name === 'settings') return { register() {} }
      return undefined
    },
    webServer: {
      register(candidate) {
        route = candidate
        return () => {}
      },
    },
    effect(factory) {
      return factory()
    },
  }
  const ctx = {
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['webServer'])
      callback(webCtx)
    },
  }

  assert.equal(installDshHostCapabilityDiagnostics(ctx), true)
  assert.equal(route.path, '/_dsh/vision-router/host-capabilities')

  const response = () => {
    const state = { headers: {}, status: undefined, body: undefined }
    return {
      state,
      writeHead(status, headers) { state.status = status; state.headers = headers },
      setHeader(name, value) { state.headers[name] = value },
      end(body) { state.body = body },
    }
  }

  const getRes = response()
  await route.handler({ method: 'GET' }, getRes)
  assert.equal(getRes.state.status, 200)
  const body = JSON.parse(getRes.state.body)
  assert.equal(body.ok, true)
  assert.equal(body.capabilities.batchAttachments, true)
  assert.equal(body.capabilities.prepareCall, true)
  assert.equal(body.capabilities.settingsLiveNamespace, true)

  const postRes = response()
  await route.handler({ method: 'POST' }, postRes)
  assert.equal(postRes.state.status, 405)

  assert.equal(installDshHostCapabilityDiagnostics({ inject() { throw new Error('host unavailable') } }), false)
})
