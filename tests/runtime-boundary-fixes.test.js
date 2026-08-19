import test from 'node:test'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'

import { createCoalescingRunner } from '../lib/adapter-update-coalescer.js'
import {
  createTesseractPromisifyCompat,
  installTesseractExecFileCompat,
} from '../lib/tesseract-exec-compat.js'
import {
  configuredVisionAdapterModels,
  contextWithDelegatedReplay,
} from '../lib/replay-delegation.js'
import {
  MAX_RUNTIME_FALLBACKS_PER_ROW,
  MAX_RUNTIME_MODEL_ID_CHARS,
  MAX_RUNTIME_PROVIDER_ROWS,
  normalizeRuntimeVisionConfig,
} from '../lib/runtime-config-normalizer.js'
import { createSessionVisionStateStore } from '../lib/session-vision-state.js'
import { installLocalVisionStabilizer } from '../lib/local-vision-stabilizer.js'
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

test('tesseract promisify compatibility materializes asynchronously and cleans up', async () => {
  const events = []
  let delegatedArgs
  let delegatedOptions
  let eventLoopYielded = false

  const fakeExecFile = () => {
    throw new Error('callback execFile must not be used when a native custom promisify exists')
  }
  const originalCustom = async (_file, args, options) => {
    events.push('delegate')
    delegatedArgs = args
    delegatedOptions = options
    return { stdout: 'OCR_OK', stderr: '' }
  }
  const wrapped = createTesseractPromisifyCompat(fakeExecFile, originalCustom, {
    tempDir: '/virtual-tmp',
    async mkdtemp(prefix) {
      events.push('mkdir')
      assert.match(prefix, /dsh-vision-router-ocr-$/)
      return '/virtual-tmp/ocr-123'
    },
    async writeFile(file, bytes) {
      events.push('write-start')
      assert.equal(file, '/virtual-tmp/ocr-123/input.png')
      assert.equal(bytes, pngBytes, 'Buffer input should not be copied before async materialization')
      await new Promise((resolve) => setImmediate(() => {
        eventLoopYielded = true
        resolve()
      }))
      events.push('write-end')
    },
    async rm(dir, options) {
      events.push('rm')
      assert.equal(dir, '/virtual-tmp/ocr-123')
      assert.equal(options.recursive, true)
      assert.equal(options.force, true)
    },
  })

  const result = await wrapped(
    'tesseract',
    ['stdin', 'stdout', '-l', 'chi_sim+eng', '--psm', '6'],
    { timeout: 1500, maxBuffer: 1024, input: pngBytes },
  )

  assert.deepEqual(result, { stdout: 'OCR_OK', stderr: '' })
  assert.equal(eventLoopYielded, true, 'large OCR staging must yield instead of blocking the event loop')
  assert.deepEqual(events, ['mkdir', 'write-start', 'write-end', 'delegate', 'rm'])
  assert.equal(delegatedArgs[0], '/virtual-tmp/ocr-123/input.png')
  assert.equal(Object.prototype.hasOwnProperty.call(delegatedOptions, 'input'), false)
  assert.equal(delegatedOptions.timeout, 1500)
  assert.equal(delegatedOptions.windowsHide, true)
})

test('tesseract promisify compatibility cleans up after delegated failure', async () => {
  const events = []
  const wrapped = createTesseractPromisifyCompat(
    () => {},
    async () => {
      events.push('delegate')
      throw new Error('fake tesseract failure')
    },
    {
      tempDir: '/virtual-tmp',
      async mkdtemp() { events.push('mkdir'); return '/virtual-tmp/ocr-fail' },
      async writeFile() { events.push('write') },
      async rm() { events.push('rm') },
    },
  )

  await assert.rejects(
    wrapped('tesseract', ['stdin', 'stdout'], { input: pngBytes }),
    /fake tesseract failure/,
  )
  assert.deepEqual(events, ['mkdir', 'write', 'delegate', 'rm'])
})

test('non-tesseract promisified execFile calls keep native semantics', async () => {
  const calls = []
  const options = { timeout: 99, input: Buffer.from('not for us') }
  const wrapped = createTesseractPromisifyCompat(
    () => {},
    async (...args) => {
      calls.push(args)
      return { stdout: 'native', stderr: '' }
    },
    {
      async mkdtemp() { throw new Error('must not materialize non-tesseract calls') },
    },
  )

  const result = await wrapped('powershell.exe', ['-NoProfile'], options)
  assert.deepEqual(result, { stdout: 'native', stderr: '' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'powershell.exe')
  assert.deepEqual(calls[0][1], ['-NoProfile'])
  assert.equal(calls[0][2], options)
})

test('tesseract installer never replaces execFile and unload preserves a later custom promisify patch', async () => {
  const originalCallbackExecFile = function () { return { pid: 4 } }
  const originalCustom = async () => ({ stdout: 'original', stderr: '' })
  originalCallbackExecFile[promisify.custom] = originalCustom
  const fakeChildProcess = { execFile: originalCallbackExecFile }

  const dispose = installTesseractExecFileCompat(undefined, {
    childProcessModule: fakeChildProcess,
    tempDir: '/virtual-tmp',
    async mkdtemp() { return '/virtual-tmp/ocr-installer' },
    async writeFile() {},
    async rm() {},
  })

  assert.equal(fakeChildProcess.execFile, originalCallbackExecFile, 'callback API identity must stay native')
  const visionCustom = originalCallbackExecFile[promisify.custom]
  assert.notEqual(visionCustom, originalCustom)
  assert.equal(visionCustom.active, true)

  const laterCustom = async () => ({ stdout: 'later', stderr: '' })
  originalCallbackExecFile[promisify.custom] = laterCustom
  dispose()

  assert.equal(originalCallbackExecFile[promisify.custom], laterCustom, 'later plugin custom promisify remains authoritative')
  assert.equal(visionCustom.active, false, 'captured Vision Router custom promisify becomes inert')
  assert.deepEqual(await visionCustom('node', ['--version'], {}), { stdout: 'original', stderr: '' })
})

test('one shared wrapper adapter never captures another DSH context', async () => {
  const sharedAdapter = {
    async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } },
    async listModels() { return [] },
    async resolveModel(_provider, model) { return { provider: 'core-wrapper', id: model } },
  }

  function harness(route, retryPolicy) {
    let registered
    const officialAdapter = {
      async listModels(provider) {
        return [{ provider, id: 'deepseek-v4-pro', name: route, inputModalities: ['text'] }]
      },
      async resolveModel(provider, model) {
        return { provider, id: model, name: route, inputModalities: ['text'] }
      },
    }
    const ctx = {
      get(name) {
        if (name !== 'settings') return undefined
        return { get: () => ({ wrapperRoute: route }) }
      },
      llm: {
        registration(provider) {
          return provider === 'deepseek-official' ? { retryPolicy, adapter: officialAdapter } : undefined
        },
        registerAdapter(_providers, adapter) { registered = adapter; return () => {} },
        async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } },
      },
    }
    const wrapped = contextWithDelegatedReplay(ctx, { wrapperRoute: route })
    wrapped.llm.registerAdapter([route], sharedAdapter)
    return () => registered
  }

  const adapterA = harness('alpha-vision', 'alpha-retry')()
  const adapterB = harness('beta-vision', 'beta-retry')()

  assert.notEqual(adapterA, adapterB, 'the same source adapter needs one proxy per owning context')
  assert.equal(adapterA.providerRetryPolicy(), 'alpha-retry')
  assert.equal(adapterB.providerRetryPolicy(), 'beta-retry')
  assert.equal((await adapterA.listModels())[0].provider, 'alpha-vision')
  assert.equal((await adapterB.listModels())[0].provider, 'beta-vision')
})

test('runtime vision config normalization is bounded and makes malformed fallbacks non-iterable-safe', () => {
  const tooLong = 'x'.repeat(MAX_RUNTIME_MODEL_ID_CHARS + 1)
  const rows = Array.from({ length: MAX_RUNTIME_PROVIDER_ROWS + 10 }, (_, i) => ({
    provider: `provider-${i}`,
    model: `model-${i}`,
    fallbacks: Array.from({ length: MAX_RUNTIME_FALLBACKS_PER_ROW + 10 }, (_x, j) => `fallback-${j}`),
  }))
  rows.unshift({ provider: 'bad', model: tooLong, fallbacks: ['must-not-survive'] })
  const normalized = normalizeRuntimeVisionConfig({ providers: rows, fallbacks: { malformed: true } })

  assert.equal(normalized.providers.length, MAX_RUNTIME_PROVIDER_ROWS)
  assert.ok(normalized.providers.every((row) => row.fallbacks.length <= MAX_RUNTIME_FALLBACKS_PER_ROW))
  assert.deepEqual(normalized.fallbacks, [])
  assert.ok(normalized.providers.every((row) => row.model !== tooLong))

  assert.doesNotThrow(() => configuredVisionAdapterModels({
    providers: [{ provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: { malformed: true } }],
    fallbacks: { malformed: true },
  }))
  const allowed = configuredVisionAdapterModels({
    providers: [{ provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: { malformed: true } }],
  })
  assert.deepEqual([...allowed.get('zhipu')], ['glm-4.6v-flash'])
})

test('live Settings values are normalized before the core can iterate the vision chain', () => {
  const rawScope = {
    get() {
      return {
        providers: [{ provider: 'zhipu', model: 'glm', fallbacks: { malformed: true } }],
        fallbacks: { malformed: true },
      }
    },
    watch() { return () => {} },
  }
  const child = {
    settings: {
      register() { return rawScope },
    },
  }
  const ctx = {
    tools: { register() { return () => {} } },
    llm: {},
    inject(_deps, callback) { return callback(child) },
    effect() { return () => {} },
  }
  const { ctx: stabilized, bootConfig } = installLocalVisionStabilizer(
    ctx,
    { providers: [{ provider: 'p', model: 'm', fallbacks: { malformed: true } }] },
    {},
  )
  assert.deepEqual(bootConfig.providers[0].fallbacks, [])

  let scope
  stabilized.inject(['settings'], (injected) => {
    scope = injected.settings.register('vision-router', {}, {})
  })
  assert.deepEqual(scope.get().providers[0].fallbacks, [])
  assert.deepEqual(scope.get().fallbacks, [])
})

test('apply-level vision state stores isolate identical session ids across DSH contexts', () => {
  const first = createSessionVisionStateStore()
  const second = createSessionVisionStateStore()
  const sessionA = { id: 'session-1' }
  const sessionB = { id: 'session-1' }

  first.setDescription(sessionA, 'sha256:image', 'only in first apply')
  first.recordAttachments(sessionA, [{ attachmentId: 'sha256:image', marker: 'A' }])

  assert.equal(first.getDescription(sessionA, 'sha256:image'), 'only in first apply')
  assert.equal(second.getDescription(sessionB, 'sha256:image'), undefined)
  assert.equal(second.lookupAttachment(sessionB, 'sha256:image'), undefined)
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
