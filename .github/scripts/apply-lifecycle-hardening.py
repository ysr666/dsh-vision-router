from pathlib import Path


def replace_once(path, old, new, label):
    file = Path(path)
    source = file.read_text()
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, got {count}")
    file.write_text(source.replace(old, new, 1))


def replace_section(path, start, end, replacement, label):
    file = Path(path)
    source = file.read_text()
    first = source.find(start)
    if first < 0:
        raise SystemExit(f"{label}: start marker missing")
    second = source.find(end, first)
    if second < 0:
        raise SystemExit(f"{label}: end marker missing")
    if source.find(start, first + 1) >= 0:
        raise SystemExit(f"{label}: start marker is not unique")
    file.write_text(source[:first] + replacement + source[second:])


# 1) File logger: transient failures use bounded backoff instead of permanently
# poisoning the sink for the rest of the process.
new_sink = r'''export function createFileLogSink({
  file,
  backup,
  maxBytes = DEFAULT_LOG_MAX_BYTES,
  onError = () => {},
  retryBaseMs = 250,
  retryMaxMs = 10_000,
  now = Date.now,
  fsOps = { appendFile, mkdir, rename, rm, stat },
} = {}) {
  let queue = Promise.resolve()
  let initialized = false
  let size = 0
  let nextRetryAt = 0
  let failureStreak = 0
  let reportedError = false

  const retryBase = Number.isFinite(retryBaseMs) && retryBaseMs >= 0 ? Number(retryBaseMs) : 250
  const retryMax = Number.isFinite(retryMaxMs) && retryMaxMs >= retryBase
    ? Number(retryMaxMs)
    : Math.max(retryBase, 10_000)
  const clock = typeof now === 'function' ? now : Date.now
  const ops = {
    appendFile: fsOps?.appendFile ?? appendFile,
    mkdir: fsOps?.mkdir ?? mkdir,
    rename: fsOps?.rename ?? rename,
    rm: fsOps?.rm ?? rm,
    stat: fsOps?.stat ?? stat,
  }

  const reportError = (error) => {
    if (reportedError) return
    reportedError = true
    try {
      onError(error)
    } catch {
      // A diagnostics failure must never affect the plugin runtime.
    }
  }

  const markFailure = (error) => {
    initialized = false
    failureStreak += 1
    const exponent = Math.min(10, Math.max(0, failureStreak - 1))
    const delay = Math.min(retryMax, retryBase * (2 ** exponent))
    nextRetryAt = Number(clock()) + delay
    reportError(error)
  }

  const markRecovered = () => {
    nextRetryAt = 0
    failureStreak = 0
    reportedError = false
  }

  const prepare = async () => {
    if (initialized) return
    await ops.mkdir(path.dirname(file), { recursive: true })
    try {
      size = (await ops.stat(file)).size
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error
      size = 0
    }
    initialized = true
  }

  const rotate = async () => {
    try {
      await ops.rm(backup, { force: true })
      await ops.rename(file, backup)
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error
    }
    size = 0
  }

  const write = (level, args) => {
    const rendered = sanitizeLogText(formatArgs(...args))
    const line = `[${new Date().toISOString()}] [${String(level).toUpperCase()}] ${rendered}\n`
    const bytes = Buffer.byteLength(line)
    queue = queue.then(async () => {
      // A persistent filesystem failure should not create a tight retry loop,
      // but a transient startup/mount race must never disable logging forever.
      if (nextRetryAt > Number(clock())) return
      try {
        await prepare()
        if (size > 0 && size + bytes > maxBytes) await rotate()
        await ops.appendFile(file, line, { encoding: 'utf8', mode: 0o600 })
        size += bytes
        if (failureStreak > 0 || reportedError) markRecovered()
      } catch (error) {
        markFailure(error)
      }
    })
    return queue
  }

  return {
    write,
    flush: () => queue,
    // Kept for compatibility: disabled now means temporarily in retry
    // backoff, not permanently poisoned for the lifetime of the process.
    get disabled() {
      return nextRetryAt > Number(clock())
    },
  }
}

'''
replace_section(
    'lib/file-logger.js',
    'export function createFileLogSink({',
    'function packageVersion()',
    new_sink,
    'replace recoverable file log sink',
)

replace_once(
    'lib/file-logger.js',
    r'''  const sink = createFileLogSink({
    file: paths.file,
    backup: paths.backup,
    maxBytes: options.maxBytes ?? DEFAULT_LOG_MAX_BYTES,
    onError: (error) => {
      try {
        baseLogger?.warn?.(
          'vision-router: diagnostics file logging disabled: %s',
          error && error.message ? error.message : String(error),
        )
      } catch {
        // Logging failure remains non-fatal.
      }
    },
  })''',
    r'''  const sink = createFileLogSink({
    file: paths.file,
    backup: paths.backup,
    maxBytes: options.maxBytes ?? DEFAULT_LOG_MAX_BYTES,
    retryBaseMs: options.retryBaseMs,
    retryMaxMs: options.retryMaxMs,
    now: options.now,
    fsOps: options.fsOps,
    onError: (error) => {
      try {
        baseLogger?.warn?.(
          'vision-router: diagnostics file logging write failed; will retry: %s',
          error && error.message ? error.message : String(error),
        )
      } catch {
        // Logging failure remains non-fatal.
      }
    },
  })''',
    'pass retry controls into file logger',
)

replace_once(
    'lib/file-logger.js',
    r'''  const installed = { ctx: wrappedCtx, logger, sink, ...paths }
  if (ctx && typeof ctx === 'object') installs.set(ctx, installed)

  installLogRoute(ctx, paths, logger)''',
    r'''  const installed = { ctx: wrappedCtx, logger, sink, ...paths }
  if (ctx && typeof ctx === 'object') {
    installs.set(ctx, installed)
    // Cordis can unload/reload this plugin fiber when a required service is
    // replaced. Its child effects (including routes) are disposed at unload,
    // so the installation cache must expire with the same lifecycle or the
    // next apply would reuse an object whose routes are no longer mounted.
    try {
      ctx.effect?.(
        () => () => {
          if (installs.get(ctx) === installed) installs.delete(ctx)
        },
        'vision-router: diagnostics file logger lifecycle',
      )
    } catch {
      // Cache expiry is a hardening aid; logging itself must stay non-fatal.
    }
  }

  installLogRoute(ctx, paths, logger)''',
    'expire logger installation cache with plugin fiber',
)

# 2) Local stabilizer: do not retain service-owned objects across service
# unload/reload cycles.
replace_once(
    'lib/local-vision-stabilizer.js',
    '  let screenshotPermissionRouteHandle\n',
    '  const screenshotPermissionRoutes = new Map()\n',
    'replace one-shot screenshot route handle',
)

new_settings = r'''  const wrapSettings = (settings, ownerCtx) =>
    new Proxy(settings, {
      get(target, property) {
        if (property !== 'register') {
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return (namespace, schema, options = {}) => {
          // Core receives bootConfig only so it constructs the screenshot tool;
          // resolved Settings must still inherit the user's real composition
          // config (where desktopScreenshot remains false unless opted in).
          const fixedOptions =
            namespace === 'vision-router' ? { ...options, base: config } : options
          const scope = target.register(namespace, schema, fixedOptions)
          if (namespace === 'vision-router') {
            rawScope = scope
            syncScreenshot()
            // The Settings service is dynamic. Never keep its scope after the
            // owning injection fiber unloads; during the gap fall back to the
            // composition config, then bind the new scope on service restore.
            try {
              ownerCtx?.effect?.(
                () => () => {
                  if (rawScope !== scope) return
                  rawScope = undefined
                  syncScreenshot()
                },
                'vision-router: local settings scope lifecycle',
              )
            } catch {
              /* lifecycle hardening must not block Settings registration */
            }
            return wrapScope(scope)
          }
          return scope
        }
      },
    })

'''
replace_section(
    'lib/local-vision-stabilizer.js',
    '  const wrapSettings = (settings) =>',
    '  const probeLocal = async (provider, signal) =>',
    new_settings,
    'make settings scope lifecycle-owned',
)

new_web = r'''  const releaseScreenshotPermissionRoute = (webServer, handle) => {
    if (!screenshotPermissionRoutes.has(webServer)) return
    if (screenshotPermissionRoutes.get(webServer) !== handle) return
    try {
      if (typeof handle === 'function') handle()
    } catch {
      /* best effort */
    }
    screenshotPermissionRoutes.delete(webServer)
  }

  const ensureScreenshotPermissionRoute = (webServer, ownerCtx) => {
    if (!webServer || typeof webServer.register !== 'function') return
    if (screenshotPermissionRoutes.has(webServer)) return
    const handle = webServer.register({
      path: '/_dsh/vision-router/request-screenshot-permission',
      handler: async (req, res) => {
        res.setHeader?.('content-type', 'application/json')
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        if (actualConfig().desktopScreenshot !== true) {
          res.writeHead(409, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'desktop screenshot is disabled' }))
          return
        }
        const result = await triggerDesktopScreenshotPermission()
        res.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      },
    })
    screenshotPermissionRoutes.set(webServer, handle)
    // Multiple core injections share one webServer instance. The Map prevents
    // duplicate routes, while the first owning child fiber removes the route
    // when that server instance disappears so a replacement can mount afresh.
    try {
      ownerCtx?.effect?.(
        () => () => releaseScreenshotPermissionRoute(webServer, handle),
        'vision-router: screenshot permission route lifecycle',
      )
    } catch {
      /* parent stabilizer cleanup remains a final fallback */
    }
  }

  const wrapWebServer = (webServer, ownerCtx) => {
    ensureScreenshotPermissionRoute(webServer, ownerCtx)
    return new Proxy(webServer, {
      get(target, property) {
        if (property !== 'register') {
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return (spec) => {
          if (!spec || spec.path !== '/_dsh/vision-router/test-connection') {
            return target.register(spec)
          }
          const originalHandler = spec.handler
          return target.register({
            ...spec,
            handler: async (req, res) => {
              const locals = core.localProvidersOf(actualConfig())
              if (req.method !== 'GET' || locals.length < 2) return originalHandler(req, res)
              const started = Date.now()
              const attempts = []
              for (let index = 0; index < locals.length; index++) {
                const controller = new AbortController()
                const timer = setTimeout(() => controller.abort(), 5000)
                try {
                  const result = await probeLocal(locals[index], controller.signal)
                  attempts.push({ backend: locals[index].name, ...result })
                  if (result.ok) {
                    res.writeHead(200, { 'content-type': 'application/json' })
                    res.end(JSON.stringify({
                      ...result,
                      ok: true,
                      backend: locals[index].name,
                      fallbackUsed: index > 0,
                      latencyMs: Date.now() - started,
                      attempts,
                    }))
                    return
                  }
                } finally {
                  clearTimeout(timer)
                }
              }
              res.writeHead(502, { 'content-type': 'application/json' })
              res.end(JSON.stringify({
                ok: false,
                latencyMs: Date.now() - started,
                error: 'all enabled local vision backends failed the connection probe',
                attempts,
              }))
            },
          })
        }
      },
    })
  }

'''
replace_section(
    'lib/local-vision-stabilizer.js',
    '  const ensureScreenshotPermissionRoute = (webServer) =>',
    '  const inject = rawInject',
    new_web,
    'make screenshot permission route lifecycle-owned',
)

replace_once(
    'lib/local-vision-stabilizer.js',
    "if (property === 'settings') return wrapSettings(target.settings)",
    "if (property === 'settings') return wrapSettings(target.settings, childCtx)",
    'pass settings child owner context',
)
replace_once(
    'lib/local-vision-stabilizer.js',
    "if (property === 'webServer') return wrapWebServer(target.webServer)",
    "if (property === 'webServer') return wrapWebServer(target.webServer, childCtx)",
    'pass webServer child owner context',
)

replace_once(
    'lib/local-vision-stabilizer.js',
    r'''      () => () => {
        unmountScreenshot()
        if (typeof screenshotPermissionRouteHandle === 'function') {
          try { screenshotPermissionRouteHandle() } catch { /* best effort */ }
        }
        screenshotPermissionRouteHandle = undefined
      },''',
    r'''      () => () => {
        rawScope = undefined
        unmountScreenshot()
        for (const [webServer, handle] of screenshotPermissionRoutes) {
          releaseScreenshotPermissionRoute(webServer, handle)
        }
        screenshotPermissionRoutes.clear()
      },''',
    'cleanup all service-owned stabilizer references',
)

# 3) Regression coverage: transient file failures recover and install caches / dynamic
# service references follow their owners' lifecycle.
replace_once(
    'tests/file-logger.test.js',
    "import { mkdtemp, readFile, rm } from 'node:fs/promises'",
    "import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'",
    'extend file logger test fs imports',
)

file_logger_tests = r'''

test('file log sink recovers after a transient write failure instead of staying permanently disabled', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vision-router-log-recover-'))
  const file = path.join(root, 'vision-router.log')
  const backup = path.join(root, 'vision-router.1.log')
  let clock = 1_000
  let appendAttempts = 0
  const reported = []
  const fsOps = {
    mkdir,
    rename,
    rm,
    stat,
    async appendFile(...args) {
      appendAttempts += 1
      if (appendAttempts === 1) {
        const error = new Error('temporary mount race')
        error.code = 'EBUSY'
        throw error
      }
      return appendFile(...args)
    },
  }
  try {
    const sink = createFileLogSink({
      file,
      backup,
      retryBaseMs: 100,
      retryMaxMs: 100,
      now: () => clock,
      fsOps,
      onError: (error) => reported.push(error.message),
    })
    await sink.write('info', ['first write races the mount'])
    assert.equal(sink.disabled, true)
    assert.equal(appendAttempts, 1)
    assert.deepEqual(reported, ['temporary mount race'])

    // Calls inside the cooldown are cheap and do not hammer a broken disk.
    await sink.write('info', ['still cooling down'])
    assert.equal(appendAttempts, 1)

    clock += 100
    await sink.write('info', ['recovered write'])
    await sink.flush()
    assert.equal(sink.disabled, false)
    assert.equal(appendAttempts, 2)
    assert.match(await readFile(file, 'utf8'), /recovered write/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('file logging installation cache expires with the plugin fiber so routes remount on reload', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vision-router-log-lifecycle-'))
  let routes = new Map()
  let pluginCleanups = []
  let serviceCleanups = []
  const makeEffect = (bucket) => (effect) => {
    const cleanup = effect()
    if (typeof cleanup === 'function') bucket.push(cleanup)
    return cleanup
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect: makeEffect(pluginCleanups),
    inject(_deps, install) {
      install({
        webServer: {
          register(spec) {
            routes.set(spec.path, spec)
            return () => {
              if (routes.get(spec.path) === spec) routes.delete(spec.path)
            }
          },
        },
        effect: makeEffect(serviceCleanups),
      })
    },
  }
  const dispose = async (bucket) => {
    for (const cleanup of bucket.splice(0).reverse()) await cleanup()
  }
  try {
    const first = installVisionRouterFileLogging(ctx, { dshHome: root })
    const duplicate = installVisionRouterFileLogging(ctx, { dshHome: root })
    assert.equal(duplicate, first)
    assert.equal(routes.has('/_dsh/vision-router/logs'), true)
    await first.sink.flush()

    await dispose(serviceCleanups)
    await dispose(pluginCleanups)
    assert.equal(routes.has('/_dsh/vision-router/logs'), false)

    // Same Cordis context object, new plugin-fiber activation.
    routes = new Map()
    pluginCleanups = []
    serviceCleanups = []
    const second = installVisionRouterFileLogging(ctx, { dshHome: root })
    assert.notEqual(second, first)
    assert.equal(routes.has('/_dsh/vision-router/logs'), true)
    await second.sink.flush()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
'''
with Path('tests/file-logger.test.js').open('a') as handle:
    handle.write(file_logger_tests)

stabilizer_tests = r'''

function makeLifecycleHarness(initial = {}) {
  let settings = { ...initial }
  let watcher
  let scope
  let settingsCtx
  let webCtx
  let webRoutes = new Map()
  const toolDefs = new Map()
  const settingsCallbacks = []
  const webCallbacks = []
  let settingsCleanups = []
  let webCleanups = []

  const makeEffect = (bucket) => (effect) => {
    const cleanup = effect()
    if (typeof cleanup === 'function') bucket.push(cleanup)
    return cleanup
  }
  const makeScope = () => ({
    get: () => settings,
    watch(fn) {
      watcher = fn
      return () => { if (watcher === fn) watcher = undefined }
    },
  })
  const makeSettingsCtx = () => ({
    settings: { register: () => scope },
    effect: makeEffect(settingsCleanups),
  })
  const makeWebCtx = () => {
    const routes = new Map()
    webRoutes = routes
    const server = {
      register(spec) {
        routes.set(spec.path, spec)
        return () => {
          if (routes.get(spec.path) === spec) routes.delete(spec.path)
        }
      },
    }
    return { webServer: server, effect: makeEffect(webCleanups) }
  }
  const dispose = (bucket) => {
    for (const cleanup of bucket.splice(0).reverse()) cleanup()
  }

  scope = makeScope()
  settingsCtx = makeSettingsCtx()
  webCtx = makeWebCtx()

  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    tools: {
      register(def) {
        toolDefs.set(def.name, def)
        return () => { if (toolDefs.get(def.name) === def) toolDefs.delete(def.name) }
      },
    },
    llm: { registerAdapter() { return () => {} } },
    get() { return undefined },
    on() { return () => {} },
    effect(effect) { return effect() },
    inject(deps, callback) {
      if (deps.includes('settings')) {
        settingsCallbacks.push(callback)
        callback(settingsCtx)
      }
      if (deps.includes('webServer')) {
        webCallbacks.push(callback)
        callback(webCtx)
      }
    },
  }

  return {
    ctx,
    toolDefs,
    get webRoutes() { return webRoutes },
    disposeSettings() {
      dispose(settingsCleanups)
      settingsCleanups = []
      watcher = undefined
    },
    restoreSettings(next) {
      settings = { ...next }
      watcher = undefined
      scope = makeScope()
      settingsCtx = makeSettingsCtx()
      for (const callback of settingsCallbacks) callback(settingsCtx)
    },
    cycleWebServer() {
      const previous = webRoutes
      dispose(webCleanups)
      webCleanups = []
      webCtx = makeWebCtx()
      for (const callback of webCallbacks) callback(webCtx)
      return { previous, current: webRoutes }
    },
  }
}

test('stabilizer releases a stale settings scope when the settings service unloads and rebinds on restore', () => {
  const harness = makeLifecycleHarness({ desktopScreenshot: true })
  const core = makeCore()
  const { ctx: stabilized } = installLocalVisionStabilizer(
    harness.ctx,
    { desktopScreenshot: false },
    core,
  )
  installSettingsLikeCore(stabilized)
  stabilized.tools.register({ name: 'vision_screenshot', execute() {} })
  assert.equal(harness.toolDefs.has('vision_screenshot'), true)

  harness.disposeSettings()
  assert.equal(harness.toolDefs.has('vision_screenshot'), false)

  harness.restoreSettings({ desktopScreenshot: true })
  assert.equal(harness.toolDefs.has('vision_screenshot'), true)
})

test('screenshot permission route follows webServer replacement instead of staying bound to the old server', () => {
  const harness = makeLifecycleHarness({ desktopScreenshot: true })
  const core = makeCore()
  const { ctx: stabilized } = installLocalVisionStabilizer(harness.ctx, {}, core)
  installSettingsLikeCore(stabilized)
  stabilized.inject(['webServer'], (webCtx) => { void webCtx.webServer })

  const path = '/_dsh/vision-router/request-screenshot-permission'
  assert.equal(harness.webRoutes.has(path), true)
  const { previous, current } = harness.cycleWebServer()
  assert.equal(previous.has(path), false)
  assert.equal(current.has(path), true)
})
'''
with Path('tests/local-vision-stabilizer.test.js').open('a') as handle:
    handle.write(stabilizer_tests)

print('lifecycle hardening patch applied')
