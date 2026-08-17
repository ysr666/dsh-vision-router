from pathlib import Path

# ---- index.js: move multi-local test-connection fallback into core ----
index = Path('index.js')
text = index.read_text()
import_marker = "import { createCachedUpdateChecker } from './lib/update-check.js'\n"
assert import_marker in text
text = text.replace(
    import_marker,
    import_marker + "import { probeLocalBackends } from './lib/local-connection-probe.js'\n",
    1,
)
old_local = """        const localFirst = localProvidersOf(current())[0]
        if (localFirst !== undefined) {
          return probeModels(localFirst.baseURL, localFirst.model)
        }
"""
new_local = """        const localProbe = await probeLocalBackends(
          localProvidersOf(current()),
          (provider) => probeModels(provider.baseURL, provider.model),
          started,
        )
        if (localProbe !== undefined) return localProbe
"""
assert text.count(old_local) == 1, text.count(old_local)
text = text.replace(old_local, new_local, 1)
index.write_text(text)

# ---- stabilizer: never proxy injected webServer child contexts ----
stab = Path('lib/local-vision-stabilizer.js')
s = stab.read_text()

probe_start = s.index('  const probeLocal = async (provider, signal) => {')
probe_end = s.index('  const releaseScreenshotPermissionRoute =', probe_start)
s = s[:probe_start] + s[probe_end:]

wrap_start = s.index('  const wrapWebServer = (webServer, ownerCtx) => {')
wrap_end = s.index('  const inject = rawInject', wrap_start)
dedicated = """  // Register the screenshot-permission endpoint from its own raw webServer
  // injection. Do not proxy core webServer child contexts: DSH 0.1.0-rc.6
  // associates effect ownership with the original injected child context, and
  // substituting a Proxy caused later route effects (update/self-update/model
  // capabilities) to disappear while the first route survived (#160).
  try {
    rawInject?.(['webServer'], (ownerCtx) => {
      ensureScreenshotPermissionRoute(ownerCtx?.webServer, ownerCtx)
    })
  } catch (error) {
    ctx.logger?.warn(
      'vision-router: screenshot permission route injection failed: %s',
      error && error.message ? error.message : String(error),
    )
  }

"""
s = s[:wrap_start] + dedicated + s[wrap_end:]

web_branch = """          if (Array.isArray(deps) && deps.includes('webServer') && childCtx?.webServer) {
            const parent = wrapped
            wrapped = new Proxy(parent, {
              get(target, property) {
                if (property === 'webServer') return wrapWebServer(target.webServer, childCtx)
                const value = Reflect.get(target, property, target)
                return typeof value === 'function' ? value.bind(target) : value
              },
            })
          }
"""
assert s.count(web_branch) == 1, s.count(web_branch)
s = s.replace(web_branch, '', 1)
assert 'wrapWebServer' not in s
assert 'probeLocal' not in s
stab.write_text(s)

# ---- tests: permission route is now mounted directly; webServer child stays identical ----
test_path = Path('tests/local-vision-stabilizer.test.js')
t = test_path.read_text()

old_harness = """  const scope = {
    get: () => settings,
    watch(fn) { watcher = fn; return () => { if (watcher === fn) watcher = undefined } },
  }
  const ctx = {
"""
new_harness = """  const scope = {
    get: () => settings,
    watch(fn) { watcher = fn; return () => { if (watcher === fn) watcher = undefined } },
  }
  const settingsCtx = { settings: { register: () => scope }, effect() {} }
  const webCtx = {
    webServer: {
      register(spec) {
        webRoutes.set(spec.path, spec)
        return () => webRoutes.delete(spec.path)
      },
    },
    effect(fn) { return fn() },
  }
  const ctx = {
"""
assert t.count(old_harness) == 1, t.count(old_harness)
t = t.replace(old_harness, new_harness, 1)

old_inject = """    inject(deps, callback) {
      if (deps.includes('settings')) callback({ settings: { register: () => scope }, effect() {} })
      if (deps.includes('webServer')) callback({ webServer: { register(spec) { webRoutes.set(spec.path, spec); return () => webRoutes.delete(spec.path) } }, effect(fn) { return fn() } })
    },
"""
new_inject = """    inject(deps, callback) {
      if (deps.includes('settings')) callback(settingsCtx)
      if (deps.includes('webServer')) callback(webCtx)
    },
"""
assert t.count(old_inject) == 1, t.count(old_inject)
t = t.replace(old_inject, new_inject, 1)
t = t.replace(
    '    ctx, scope, handlers, toolDefs, adapters, webRoutes,\n',
    '    ctx, scope, handlers, toolDefs, adapters, webRoutes, webCtx,\n',
    1,
)

old_permission_trigger = """  installSettingsLikeCore(stabilized)
  stabilized.inject(['webServer'], (webCtx) => {
    // Accessing the wrapped web server installs the plugin-owned permission route.
    void webCtx.webServer
  })
  const route = harness.webRoutes.get('/_dsh/vision-router/request-screenshot-permission')
"""
new_permission_trigger = """  installSettingsLikeCore(stabilized)
  const route = harness.webRoutes.get('/_dsh/vision-router/request-screenshot-permission')
"""
assert t.count(old_permission_trigger) == 1, t.count(old_permission_trigger)
t = t.replace(old_permission_trigger, new_permission_trigger, 1)

old_conn_start = t.index("test('connection probe falls through Ollama failure to LM Studio success'")
old_conn_end = t.index('\n\nfunction makeLifecycleHarness', old_conn_start)
new_test = """test('webServer child contexts pass through unchanged for DSH rc.6 route ownership', () => {
  const harness = makeHarness({})
  const core = makeCore()
  const { ctx: stabilized } = installLocalVisionStabilizer(harness.ctx, {}, core)
  let seen
  stabilized.inject(['webServer'], (webCtx) => { seen = webCtx })
  assert.equal(seen, harness.webCtx)
})
"""
t = t[:old_conn_start] + new_test + t[old_conn_end:]
test_path.write_text(t)
