import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'

import { createCoalescingRunner } from '../lib/adapter-update-coalescer.js'
import {
  createTesseractExecFileCompat,
  installTesseractExecFileCompat,
} from '../lib/tesseract-exec-compat.js'
import {
  installLocalMutationRouteBoundary,
  isLocalUiRequest,
  isLoopbackAddress,
} from '../lib/web-capability-boundary.js'

test('coalescing runner reaches a fixed point across synchronous re-entry and mid-pass topology changes', () => {
  const providers = new Set(['alpha'])
  const twins = new Set()
  const registrations = new Map()
  let reconcile
  let depth = 0
  let maxDepth = 0
  let injectedSecondProvider = false

  reconcile = createCoalescingRunner(() => {
    depth += 1
    maxDepth = Math.max(maxDepth, depth)
    try {
      for (const provider of [...providers]) {
        if (twins.has(provider)) continue
        twins.add(provider)
        registrations.set(provider, (registrations.get(provider) ?? 0) + 1)
        reconcile()
        if (provider === 'alpha' && !injectedSecondProvider) {
          injectedSecondProvider = true
          providers.add('beta')
          reconcile()
        }
      }
    } finally {
      depth -= 1
    }
  })

  reconcile()

  assert.deepEqual([...twins].sort(), ['alpha', 'beta'])
  assert.equal(registrations.get('alpha'), 1)
  assert.equal(registrations.get('beta'), 1)
  assert.equal(maxDepth, 1, 'nested notifications must be coalesced, never recursively executed')
})

test('coalescing runner stops a permanently dirty synchronous event cycle', () => {
  let passes = 0
  let reported
  let reconcile
  reconcile = createCoalescingRunner(
    () => {
      passes += 1
      reconcile()
    },
    {
      maxPasses: 5,
      onNonConverging(info) { reported = info },
    },
  )

  reconcile()
  assert.equal(passes, 5)
  assert.equal(reported.passes, 5)
  reconcile()
  assert.equal(passes, 10)
})

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
])

test('tesseract execFile compatibility materializes input bytes and preserves promisify shape', async () => {
  let materializedPath
  let delegatedOptions

  const fakeExecFile = (_file, args, options, callback) => {
    materializedPath = args[0]
    delegatedOptions = options
    assert.notEqual(materializedPath, 'stdin')
    assert.match(materializedPath, /input\.png$/)
    assert.equal(existsSync(materializedPath), true)
    assert.deepEqual(readFileSync(materializedPath), pngBytes)
    callback(null, 'OCR_OK', '')
    return { pid: 1 }
  }

  const wrapped = createTesseractExecFileCompat(fakeExecFile)
  const result = await promisify(wrapped)(
    'tesseract',
    ['stdin', 'stdout', '-l', 'chi_sim+eng', '--psm', '6'],
    { timeout: 1500, maxBuffer: 1024, input: pngBytes },
  )

  assert.deepEqual(result, { stdout: 'OCR_OK', stderr: '' })
  assert.equal(Object.prototype.hasOwnProperty.call(delegatedOptions, 'input'), false)
  assert.equal(delegatedOptions.timeout, 1500)
  assert.equal(delegatedOptions.windowsHide, true)
  assert.equal(existsSync(materializedPath), false, 'temporary OCR input must be removed after success')
})

test('tesseract execFile compatibility removes materialized input after failure', async () => {
  let materializedPath

  const fakeExecFile = (_file, args, _options, callback) => {
    materializedPath = args[0]
    assert.equal(existsSync(materializedPath), true)
    assert.deepEqual(readFileSync(materializedPath), pngBytes)
    callback(new Error('fake tesseract failure'), '', 'boom')
    return { pid: 2 }
  }

  const wrapped = createTesseractExecFileCompat(fakeExecFile)
  await assert.rejects(
    promisify(wrapped)(
      'tesseract',
      ['stdin', 'stdout', '-l', 'chi_sim+eng', '--psm', '6'],
      { timeout: 1500, maxBuffer: 1024, input: pngBytes },
    ),
    /fake tesseract failure/,
  )

  assert.equal(existsSync(materializedPath), false, 'temporary OCR input must be removed after failure')
})

test('non-tesseract execFile calls are delegated unchanged', () => {
  const calls = []
  const fakeExecFile = function (...args) {
    calls.push(args)
    return { pid: 3 }
  }
  const wrapped = createTesseractExecFileCompat(fakeExecFile)
  const callback = () => {}
  const options = { timeout: 99, input: Buffer.from('not for us') }

  const child = wrapped('powershell.exe', ['-NoProfile'], options, callback)

  assert.deepEqual(child, { pid: 3 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'powershell.exe')
  assert.deepEqual(calls[0][1], ['-NoProfile'])
  assert.equal(calls[0][2], options)
  assert.equal(calls[0][3], callback)
})

test('tesseract installer unload does not clobber a later process-level execFile patch', () => {
  const hostCalls = []
  const hostExecFile = function (...args) {
    hostCalls.push(args)
    return { pid: 4 }
  }
  const fakeChildProcess = { execFile: hostExecFile }
  let syncCalls = 0
  const dispose = installTesseractExecFileCompat(undefined, {
    childProcessModule: fakeChildProcess,
    syncBuiltinESMExports() { syncCalls += 1 },
  })
  const visionPatch = fakeChildProcess.execFile
  assert.notEqual(visionPatch, hostExecFile)
  assert.equal(visionPatch.active, true)

  const laterPatch = function (...args) {
    return visionPatch.apply(this, args)
  }
  fakeChildProcess.execFile = laterPatch

  dispose()

  assert.equal(fakeChildProcess.execFile, laterPatch, 'later patch must remain authoritative')
  assert.equal(visionPatch.active, false, 'captured Vision Router wrapper becomes inert')
  assert.ok(syncCalls >= 2, 'ESM binding is resynced to the current authoritative patch')

  const callback = () => {}
  hostCalls.length = 0
  visionPatch('tesseract', ['stdin', 'stdout'], { input: pngBytes }, callback)
  const seenArgs = hostCalls[0]
  assert.equal(seenArgs[1][0], 'stdin')
  assert.equal(seenArgs[2].input, pngBytes)
})

test('loopback transport detection covers IPv4, IPv6 and IPv4-mapped IPv6 only', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.99.3.4'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.8'), false)
  assert.equal(isLoopbackAddress('::ffff:192.168.1.8'), false)
  assert.equal(isLoopbackAddress('localhost'), false, 'headers/names are not transport identity')
})

test('local UI capability requires loopback transport and a local Host on real HTTP requests', () => {
  assert.equal(isLocalUiRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3000' } }), true)
  assert.equal(isLocalUiRequest({ socket: { remoteAddress: '::1' }, headers: { host: '[::1]:3000' } }), true)
  assert.equal(
    isLocalUiRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'router.example.com' } }),
    false,
    'a reverse proxy must not turn an external Host into a local-machine capability',
  )
  assert.equal(isLocalUiRequest({ socket: { remoteAddress: '192.168.1.8' }, headers: { host: '127.0.0.1:3000' } }), false)
  assert.equal(isLocalUiRequest({ headers: {} }), true, 'internal direct handler calls remain supported')
})

function responseRecorder() {
  return {
    status: undefined,
    body: '',
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    removeHeader(name) { delete this.headers[String(name).toLowerCase()] },
    writeHead(status, headers = {}) {
      this.status = status
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
    },
    end(body) { this.body = String(body ?? '') },
  }
}

test('local mutation boundary preserves injected child identity and rejects remote side effects', async () => {
  const routes = new Map()
  const cleanups = []
  const child = {
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {}
      },
    },
    effect(factory) {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
  }
  const ctx = {
    inject(_dependencies, callback) { return callback(child) },
    effect(factory) {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
  }
  const wrapped = installLocalMutationRouteBoundary(ctx)
  let seenChild
  let calls = 0
  wrapped.inject(['webServer'], (injected) => {
    seenChild = injected
    injected.webServer.register({
      kind: 'exact',
      path: '/_dsh/vision-router/self-update',
      handler(_req, res) {
        calls += 1
        res.writeHead(200)
        res.end('ok')
      },
    })
  })
  assert.equal(seenChild, child, 'Cordis injection identity must remain exact')
  const registered = routes.get('/_dsh/vision-router/self-update')

  let res = responseRecorder()
  await registered.handler(
    { method: 'POST', socket: { remoteAddress: '192.168.1.55' }, headers: { host: '127.0.0.1:3000' } },
    res,
  )
  assert.equal(res.status, 403)
  assert.equal(calls, 0)

  res = responseRecorder()
  await registered.handler(
    { method: 'POST', socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { host: 'localhost:3000' } },
    res,
  )
  assert.equal(res.status, 200)
  assert.equal(calls, 1)

  res = responseRecorder()
  await registered.handler(
    { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'router.example.com' } },
    res,
  )
  assert.equal(res.status, 403, 'reverse-proxy-local transport with an external Host stays remote')
  assert.equal(calls, 1)

  // Capability+method specific: GET on the mutation route itself is still the
  // real handler's responsibility.
  res = responseRecorder()
  await registered.handler(
    { method: 'GET', socket: { remoteAddress: '10.0.0.8' }, headers: { host: 'router.example.com' } },
    res,
  )
  assert.equal(res.status, 200)
  assert.equal(calls, 2)

  for (const cleanup of cleanups.reverse()) cleanup()
})

test('remote update-check keeps version metadata but never receives the one-click mutation token', async () => {
  let route
  const child = {
    webServer: {
      register(spec) {
        route = spec
        return () => {}
      },
    },
    effect(factory) { return factory() },
  }
  const ctx = {
    inject(_dependencies, callback) { return callback(child) },
    effect(factory) { return factory() },
  }
  const wrapped = installLocalMutationRouteBoundary(ctx)
  wrapped.inject(['webServer'], (injected) => {
    injected.webServer.register({
      kind: 'exact',
      path: '/_dsh/vision-router/update-check',
      async handler(_req, res) {
        await Promise.resolve()
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '999' })
        res.end(JSON.stringify({
          ok: true,
          currentVersion: '1.0.0',
          latestVersion: '1.0.1',
          updateAvailable: true,
          autoUpdate: { supported: true, method: 'dsh-plugin-add', token: 'secret-token' },
        }))
      },
    })
  })

  let res = responseRecorder()
  await route.handler(
    { method: 'GET', socket: { remoteAddress: '192.168.1.9' }, headers: { host: 'router.example.com' } },
    res,
  )
  const remote = JSON.parse(res.body)
  assert.equal(remote.ok, true)
  assert.equal(remote.updateAvailable, true)
  assert.equal(remote.autoUpdate.supported, true)
  assert.equal(remote.autoUpdate.token, undefined)
  assert.equal(res.headers['content-length'], undefined)

  res = responseRecorder()
  await route.handler(
    { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3000' } },
    res,
  )
  const local = JSON.parse(res.body)
  assert.equal(local.autoUpdate.token, 'secret-token')
})

test('remote log metadata is redacted even when a reverse proxy makes the TCP peer loopback', async () => {
  let route
  const child = {
    webServer: {
      register(spec) {
        route = spec
        return () => {}
      },
    },
    effect(factory) { return factory() },
  }
  const ctx = {
    inject(_dependencies, callback) { return callback(child) },
    effect(factory) { return factory() },
  }
  const wrapped = installLocalMutationRouteBoundary(ctx)
  wrapped.inject(['webServer'], (injected) => {
    injected.webServer.register({
      kind: 'exact',
      path: '/_dsh/vision-router/logs',
      handler(_req, res) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, local: true, canOpen: true, directory: '/secret/home/logs', file: '/secret/home/logs/x.log' }))
      },
    })
  })

  const res = responseRecorder()
  await route.handler(
    { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'router.example.com' } },
    res,
  )
  const remote = JSON.parse(res.body)
  assert.equal(remote.ok, true)
  assert.equal(remote.local, false)
  assert.equal(remote.canOpen, false)
  assert.equal(remote.directory, undefined)
  assert.equal(remote.file, undefined)
})
