import test from 'node:test'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

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
import { installVisionMaintenanceRoutes } from '../lib/maintenance-routes.js'
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
      assert.match(file, /ocr-123[\\/]input\.png$/)
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
  assert.match(delegatedArgs[0], /ocr-123[\\/]input\.png$/)
  assert.equal(Object.prototype.hasOwnProperty.call(delegatedOptions, 'input'), false)
  assert.equal(delegatedOptions.timeout, 1500)
  assert.equal(delegatedOptions.windowsHide, true)
})

test('tesseract promisify compatibility canonicalizes the temp root before staging', async () => {
  const prefixes = []
  const wrapped = createTesseractPromisifyCompat(
    () => {},
    async (_file, args) => ({ stdout: args[0], stderr: '' }),
    {
      tempDir: '/tmp',
      async realpath(value) { assert.equal(value, '/tmp'); return '/private/tmp' },
      async mkdtemp(prefix) { prefixes.push(prefix); return '/private/tmp/ocr-realpath' },
      async writeFile() {},
      async rm() {},
    },
  )

  const result = await wrapped('tesseract', ['stdin', 'stdout'], { input: pngBytes })
  assert.deepEqual(prefixes, [path.join('/private/tmp', 'dsh-vision-router-ocr-')])
  assert.equal(result.stdout, path.join('/private/tmp', 'ocr-realpath', 'input.png'))
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

test('maintenance route owner preserves update token lifecycle and explicit target update', async () => {
  const routes = new Map()
  const cleanups = []
  const checks = []
  const updates = []
  const tokens = ['token-1', 'token-2', 'token-3']
  const child = {
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    effect(factory) {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
  }
  const ctx = {
    logger: { info() {} },
    inject(_dependencies, callback) { return callback(child) },
  }
  const updateChecker = {
    async check(force) {
      checks.push(force)
      return force
        ? { ok: true, currentVersion: '2.3.0', latestVersion: '2.4.0', updateAvailable: true }
        : { ok: true, currentVersion: '2.3.0', latestVersion: '2.3.0', updateAvailable: false }
    },
  }
  installVisionMaintenanceRoutes(ctx, {
    updateChecker,
    selfUpdatePlan: { available: true, method: 'dsh-plugin-add', profile: 'web' },
    tokenFactory: () => tokens.shift(),
    async runUpdate(plan, options) {
      updates.push({ plan, options })
      return { ok: true, updated: true, targetVersion: options.targetVersion }
    },
  })
  await Promise.resolve()
  assert.deepEqual(checks, [false], 'startup check remains passive')

  const updateRoute = routes.get('/_dsh/vision-router/update-check')
  const selfUpdateRoute = routes.get('/_dsh/vision-router/self-update')
  assert.ok(updateRoute)
  assert.ok(selfUpdateRoute)

  let res = responseRecorder()
  await updateRoute.handler({ method: 'GET', url: '/_dsh/vision-router/update-check?force=1' }, res)
  assert.equal(res.status, 200)
  let body = JSON.parse(res.body)
  assert.equal(body.updateAvailable, true)
  assert.equal(body.autoUpdate.token, 'token-1')
  assert.equal(res.headers['cache-control'], 'no-store')

  res = responseRecorder()
  await selfUpdateRoute.handler({
    method: 'POST',
    headers: {
      'sec-fetch-site': 'same-origin',
      'x-dsh-vision-router-update-token': 'token-1',
    },
  }, res)
  assert.equal(res.status, 200)
  body = JSON.parse(res.body)
  assert.equal(body.updated, true)
  assert.deepEqual(updates, [{
    plan: { available: true, method: 'dsh-plugin-add', profile: 'web' },
    options: { targetVersion: '2.4.0' },
  }])

  res = responseRecorder()
  await updateRoute.handler({ method: 'GET', url: '/_dsh/vision-router/update-check?force=1' }, res)
  body = JSON.parse(res.body)
  assert.equal(body.autoUpdate.token, 'token-2', 'successful mutation rotates the replay token')
  assert.deepEqual(checks, [false, true, true, true])

  for (const cleanup of cleanups.toReversed()) cleanup()
})

test('issue #678 remote update status remains cache-only even with force=1', async () => {
  let updateRoute
  const checks = []
  const ctx = {
    inject(_dependencies, callback) {
      return callback({
        webServer: {
          register(route) {
            if (route.path === '/_dsh/vision-router/update-check') updateRoute = route
            return () => {}
          },
        },
        effect(factory) { return factory() },
      })
    },
  }
  installVisionMaintenanceRoutes(ctx, {
    updateChecker: {
      async check(force) {
        checks.push(force)
        return { ok: true, currentVersion: '2.4.0', latestVersion: '2.4.0', updateAvailable: false }
      },
    },
    selfUpdatePlan: { available: false },
  })
  await Promise.resolve()
  assert.deepEqual(checks, [false], 'startup remains read-only and cached')
  assert.ok(updateRoute)

  async function get(request) {
    const res = responseRecorder()
    await updateRoute.handler({
      method: 'GET',
      url: '/_dsh/vision-router/update-check?force=1',
      ...request,
    }, res)
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).ok, true)
  }

  // Remote direct TCP requests, including spoofed Host, cannot force an
  // additional outbound refresh; a same-machine reverse proxy that retains
  // the public Host is also treated as remote.
  for (let index = 0; index < 3; index += 1) {
    await get({ socket: { remoteAddress: '192.0.2.42' }, headers: { host: 'public.example' } })
  }
  await get({ socket: { remoteAddress: '192.0.2.42' }, headers: { host: '127.0.0.1:3080' } })
  await get({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'public.example' } })
  assert.deepEqual(checks, [false, false, false, false, false, false])

  // Local DSH UI keeps the explicit manual refresh ability.
  await get({ socket: { remoteAddress: '::1' }, headers: { host: '[::1]:3080' } })
  await get({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3080' } })
  assert.deepEqual(checks, [false, false, false, false, false, false, true, true])
  // Internal Host invocations with no network transport preserve their
  // existing test/composition behavior.
  await get({ headers: {} })
  assert.equal(checks.at(-1), true)
})

test('maintenance Web ownership is extracted from Core and composed after Core apply', async () => {
  const [core, composition, maintenance] = await Promise.all([
    readFile(new URL('../index.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/runtime-composition.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/maintenance-routes.js', import.meta.url), 'utf8'),
  ])
  assert.doesNotMatch(core, /createCachedUpdateChecker|runDshPluginUpdate|selfUpdateToken/)
  assert.doesNotMatch(core, /\/_dsh\/vision-router\/(?:update-check|self-update)/)
  assert.match(maintenance, /path: '\/_dsh\/vision-router\/update-check'/)
  assert.match(maintenance, /path: '\/_dsh\/vision-router\/self-update'/)
  const applyAt = composition.indexOf('() => core.apply(')
  const postCoreAt = composition.indexOf('const installPostCoreRuntime = () => {')
  const settleSuccessAt = composition.indexOf('onSuccess: installPostCoreRuntime', applyAt)
  const postCoreEnd = composition.indexOf('const failCoreApply = (error) => {', postCoreAt)
  assert.ok(applyAt >= 0)
  assert.ok(postCoreAt >= 0)
  assert.ok(settleSuccessAt > applyAt, 'maintenance ownership must be attached only to Core apply success settlement')
  assert.match(
    composition.slice(postCoreAt, postCoreEnd),
    /installVisionMaintenanceRoutes\([\s\S]*?finishSchemaBootstrapOnce\(\)[\s\S]*?installWrapperDirectoryAlias\(/,
    'post-Core settlement mounts maintenance before closing bootstrap and publishing the wrapper alias',
  )
})

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
  assert.equal(res.status, 403, 'undeclared methods on a DVR capability route fail closed')
  assert.equal(calls, 1)

  for (const cleanup of cleanups.reverse()) cleanup()
})

test('local mutation boundary never leaves webServer.register patched for foreign plugins', () => {
  const routes = new Map()
  const webServer = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const originalRegister = webServer.register
  const child = {
    webServer,
    effect(factory) { return factory() },
  }
  const ctx = {
    inject(_dependencies, callback) { return callback(child) },
    effect(factory) { return factory() },
  }

  const wrapped = installLocalMutationRouteBoundary(ctx)
  wrapped.inject(['webServer'], (scope) => {
    assert.notEqual(scope.webServer.register, originalRegister, 'DVR registrations are guarded inside the callback')
    scope.webServer.register({
      kind: 'exact',
      path: '/_dsh/vision-router/host-capabilities',
      handler(_req, res) { res.end('ok') },
    })
  })

  assert.equal(webServer.register, originalRegister, 'foreign plugins must observe the original shared registrar')
  webServer.register({ kind: 'exact', path: '/foreign-health', handler(_req, res) { res.end('ok') } })
  assert.ok(routes.has('/foreign-health'))
})

test('local mutation boundary keeps async DVR registration private without exposing it to foreign plugins', async () => {
  const routes = new Map()
  const webServer = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const originalRegister = webServer.register
  const child = { webServer, effect(factory) { return factory() } }
  const ctx = { inject(_dependencies, callback) { return callback(child) } }

  let release
  const gate = new Promise((resolve) => { release = resolve })
  const pending = installLocalMutationRouteBoundary(ctx).inject(['webServer'], async (scope) => {
    assert.notEqual(scope.webServer.register, originalRegister)
    await gate
    scope.webServer.register({
      kind: 'exact',
      path: '/_dsh/vision-router/async-owned',
      handler(_req, res) { res.end('ok') },
    })
  })

  assert.equal(webServer.register, originalRegister, 'shared registrar stays untouched while DVR awaits')
  webServer.register({ kind: 'exact', path: '/foreign-during-await', handler(_req, res) { res.end('ok') } })
  release()
  await pending

  assert.equal(webServer.register, originalRegister)
  assert.ok(routes.has('/foreign-during-await'))
  assert.ok(routes.has('/_dsh/vision-router/async-owned'))
})

test('local mutation boundary does not mutate a traceable WebServer raw descriptor', () => {
  const raw = {
    register(route) { return () => route },
  }
  const originalOwn = Object.hasOwn(raw, 'register')
  const original = raw.register
  const traceable = new Proxy(raw, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      // Cordis traceable services return a fresh callable proxy on each method read.
      return new Proxy(value, { apply(fn, thisArg, args) { return Reflect.apply(fn, thisArg, args) } })
    },
  })
  const child = { webServer: traceable, effect(factory) { return factory() } }
  const ctx = { inject(_dependencies, callback) { return callback(child) } }

  installLocalMutationRouteBoundary(ctx).inject(['webServer'], (scope) => {
    scope.webServer.register({
      kind: 'exact',
      path: '/_dsh/vision-router/host-capabilities',
      handler() {},
    })
  })

  assert.equal(Object.hasOwn(raw, 'register'), originalOwn)
  assert.equal(raw.register, original)
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
          autoUpdate: { supported: true, method: 'dsh-plugin-add', token: ['secret', 'token'].join('-') },
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

test('issue #679 remote redaction buffers split JSON and fails closed on invalid, oversized or delayed output', async () => {
  const remoteRequest = {
    method: 'GET',
    socket: { remoteAddress: '192.0.2.44' },
    headers: { host: 'dsh.example.test' },
  }
  async function probe(path, handler, request = remoteRequest) {
    let registered
    const child = {
      webServer: {
        register(route) {
          registered = route
          return () => {}
        },
      },
      effect(factory) { return factory() },
    }
    installLocalMutationRouteBoundary({
      inject(_dependencies, callback) { return callback(child) },
    }).inject(['webServer'], (scope) => scope.webServer.register({
      kind: 'exact',
      path,
      handler,
    }))
    const res = responseRecorder()
    res.rawWrites = []
    res.write = function write(chunk) {
      this.rawWrites.push(String(chunk))
      this.body += String(chunk)
      return true
    }
    await registered.handler(request, res)
    return res
  }

  const updateBody = JSON.stringify({
    ok: true, updateAvailable: true,
    autoUpdate: { supported: true, token: 'SECRET_STREAMED_TOKEN' },
  })
  const split = await probe('/_dsh/vision-router/update-check', async (_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': '999',
      'set-cookie': 'SECRET_HEADER_TOKEN',
      'x-local-path': '/private/path',
    })
    res.write(updateBody.slice(0, 33))
    await Promise.resolve()
    res.write(Buffer.from(updateBody.slice(33, -1)))
    res.end(updateBody.slice(-1))
  })
  assert.equal(split.status, 200)
  assert.deepEqual(split.rawWrites, [], 'raw chunks must not reach the socket before redaction')
  assert.equal(JSON.parse(split.body).autoUpdate.token, undefined)
  assert.equal(split.headers['content-length'], undefined)
  assert.equal(split.headers['set-cookie'], undefined, 'sensitive staged headers must never reach remote clients')
  assert.equal(split.headers['x-local-path'], undefined)
  assert.doesNotMatch(split.body, /SECRET_STREAMED_TOKEN/)

  const log = await probe('/_dsh/vision-router/logs', (_req, res) => {
    const text = JSON.stringify({ ok: true, directory: '/private/path', file: 'secrets.log', local: true, canOpen: true })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write(text.slice(0, 15))
    res.end(text.slice(15))
  })
  const logBody = JSON.parse(log.body)
  assert.equal(logBody.directory, undefined)
  assert.equal(logBody.file, undefined)
  assert.equal(logBody.local, false)
  assert.equal(logBody.canOpen, false)

  const invalid = await probe('/_dsh/vision-router/update-check', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '29' })
    res.end('SECRET_NON_JSON_EXPOSED')
  })
  assert.equal(invalid.status, 502)
  assert.match(invalid.headers['content-type'], /application\/json/)
  assert.equal(invalid.headers['cache-control'], 'no-store')
  assert.doesNotMatch(invalid.body, /SECRET_NON_JSON_EXPOSED/)

  const huge = await probe('/_dsh/vision-router/update-check', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"token":"')
    res.write('X'.repeat(1024 * 1024 + 1))
    res.end('"}')
  })
  assert.equal(huge.status, 502)
  assert.ok(huge.body.length < 200)
  assert.deepEqual(huge.rawWrites, [])

  // A synchronous handler that schedules a later write and returns without a
  // promise must remain under the guard until its eventual end().
  let delayedEnd
  const deferred = new Promise((resolve) => { delayedEnd = resolve })
  const delayed = await probe('/_dsh/vision-router/update-check', (_req, res) => {
    void deferred.then(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(updateBody)
    })
  })
  // The handler returned before its deferred end; no bytes should have leaked.
  assert.equal(delayed.body, '')
  delayedEnd()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(JSON.parse(delayed.body).autoUpdate.token, undefined)

  // The genuine local path is intentionally not forced through remote
  // redaction: the local update token is necessary for self-update replay
  // protection and must remain available to the local UI.
  const local = await probe('/_dsh/vision-router/update-check', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(updateBody)
  }, {
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost:3080' },
  })
  assert.equal(JSON.parse(local.body).autoUpdate.token, 'SECRET_STREAMED_TOKEN')
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
