import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const dvrRoot = resolve(process.env.DVR_SOURCE_ROOT || join(here, '..'))
const dshRoot = resolve(process.env.DSH_SOURCE_ROOT || '')
if (!process.env.DSH_SOURCE_ROOT) throw new Error('DSH_SOURCE_ROOT is required')

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const dshVersion = readJson(join(dshRoot, 'apps/desktop/package.json')).version
const freshActivation = process.env.DVR_DIAG_MODE === 'fresh-activation'
const expectedVersion = process.env.DSH_EXPECTED_VERSION
if (expectedVersion && dshVersion !== expectedVersion) {
  throw new Error(`expected DSH ${expectedVersion}, found ${dshVersion}`)
}

const importDsh = (path) => import(pathToFileURL(join(dshRoot, path)).href)
const { prepareDevelopmentProject } = await importDsh('apps/desktop/scripts/development-project.ts')
const { DesktopProjectManager } = await importDsh('apps/desktop/src/project-manager.ts')
const { resolveDesktopPaths } = await importDsh('apps/desktop/src/paths.ts')
const { DesktopHostProcess } = await importDsh('apps/desktop/src/host-process.ts')
const { DESKTOP_HOST_PROTOCOL_VERSION } = await importDsh('apps/desktop/src/host-protocol.ts')

const target = process.platform === 'win32'
  ? 'win-x64'
  : process.platform === 'darwin' && process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
const pnpmVersion = readJson(join(dshRoot, 'apps/desktop/node_modules/pnpm/package.json')).version
const root = mkdtempSync(join(tmpdir(), 'dvr-017-desktop-host-'))
const home = join(root, 'home')
const project = join(root, 'project')
const previousEnv = new Map(['DSH_HOME', 'DSH_TELEMETRY_MODE', 'DSH_CLIENT_VERSION', 'DEEPSEEK_API_KEY']
  .map((name) => [name, process.env[name]]))
// This is a CI-only diagnostic fixture, never shipped in DVR's package.
function writeProbeFixture(root) {
  const dir = join(root, 'dvr-issue-877-probe')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dvr-issue-877-probe', version: '0.0.1', type: 'module',
    main: './index.js', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(join(dir, 'cordis.patch.yml'),
    '- insert:\n    - id: dvr-issue-877-probe\n      name: dvr-issue-877-probe\n')
  writeFileSync(join(dir, 'index.js'), "export function apply(ctx) {\n  const events = []\n  const updatePhases = []\n  const requestId = 'issue-877-isolated-upgrade'\n  ctx.on('plugin-manager/update-state', (state) => {\n    if (state?.requestId !== requestId) return\n    updatePhases.push(String(state?.step ?? 'unknown'))\n  }, { global: true })\n  ctx.on('internal/status', (fiber, previous) => {\n    const entryId = fiber?.entry?.options?.id || fiber?.name || ''\n    if (String(entryId).includes('vision-router')) {\n      const error = fiber?._error\n      const stack = error?.stack || (error ? String(error) : null)\n      events.push({ entryId: String(entryId), from: previous, to: fiber?.state,\n        stack: typeof stack === 'string' ? stack.slice(0, 6000) : null })\n      if (events.length > 80) events.splice(0, events.length - 80)\n    }\n  }, { global: true })\n  ctx.inject(['webServer', 'pluginManager', 'connection'], (scope) => {\n    scope.effect(() => scope.webServer.register({\n      kind: 'exact', path: '/__dvr_issue_877_upgrade', auth: 'required',\n      async handler(req, res, peer) {\n        // Prefer the Host-admitted Peer on 0.2.3+ WebServer. Its\n        // Connection.admit() also exists, but re-authenticating the raw\n        // request inside a registered route can throw and cause blank HTTP 400.\n        // Legacy 0.2.2 WebServer passes no Peer; validate via Connection.admit.\n        const admission = peer?.principal?.kind === 'owner'\n          ? { peer }\n          : typeof scope.connection?.admit === 'function'\n            ? scope.connection.admit(req)\n            : { rejection: 403 }\n        const verified = 'peer' in admission\n          && admission.peer?.principal?.kind === 'owner'\n        if (!verified || (req.method !== 'GET' && req.method !== 'POST')) {\n          res.writeHead(403, { 'content-type': 'application/json' })\n          res.end(JSON.stringify({\n            error: 'authenticated owner GET/POST required',\n            method: req.method,\n            rejection: 'rejection' in admission ? admission.rejection : null,\n          }))\n          return\n        }\n        if (req.method === 'GET') {\n          let loaderState\n          try {\n            const entry = scope.loader?.resolve?.('vision-router')\n            const fiber = entry?.fiber ?? entry?.subtree?.fiber\n            loaderState = {\n              found: !!entry,\n              entryId: entry?.options?.id,\n              state: fiber?.state,\n              error: fiber?._error?.stack ?? (fiber?._error ? String(fiber._error) : null),\n            }\n          } catch (error) {\n            loaderState = { lookupError: String(error) }\n          }\n          res.writeHead(200, { 'content-type': 'application/json' })\n          res.end(JSON.stringify({ events, loaderState, hmr: scope.get('hmr') !== undefined }))\n          return\n        }\n        const hmrVisibleToProbe = scope.get('hmr') !== undefined\n        const hmrVisibleToPluginManager = scope.pluginManager.ctx?.get?.('hmr') !== undefined\n        try {\n          const result = await scope.pluginManager.updateBundle('dsh-vision-router', '3.4.0', { requestId })\n          res.writeHead(200, { 'content-type': 'application/json' })\n          res.end(JSON.stringify({ result, events, updatePhases, hmrVisibleToProbe, hmrVisibleToPluginManager }))\n        } catch (error) {\n          res.writeHead(500, { 'content-type': 'application/json' })\n          res.end(JSON.stringify({ error: String(error), stack: error?.stack, events, updatePhases, hmrVisibleToProbe, hmrVisibleToPluginManager }))\n        }\n      }\n    }), 'issue-877 isolated upgrade evidence endpoint')\n  })\n}\n")
  return dir
}

const REQUEST_DEADLINE_MS = 6000
let host

function hostUrl(base, pathname) {
  const url = new URL(base)
  url.pathname = pathname
  url.search = ''
  url.hash = ''
  return url
}

async function statusProbe(base, pathname, cookie, expectedStatus) {
  const response = await fetch(hostUrl(base, pathname), {
    headers: { cookie },
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
  })
  const status = response.status
  await response.body?.cancel()
  if (status !== expectedStatus) {
    throw new Error(`Desktop Host ${pathname} expected HTTP ${expectedStatus}, found ${status}`)
  }
  return status
}

try {
  mkdirSync(home)
  process.env.DSH_HOME = home
  process.env.DSH_TELEMETRY_MODE = 'DISABLED'
  // The exact alpha Host's required desktop-product-telemetry row validates
  // serviceVersion from DSH_CLIENT_VERSION even when sending is disabled.
  // Real Desktop supplies this app-owned value; reproduce it in the isolated
  // Desktop fixture rather than suppressing the Host's required plugin.
  process.env.DSH_CLIENT_VERSION = dshVersion
  process.env.DEEPSEEK_API_KEY = ['keyless', 'dvr', 'desktop', 'structured', 'no-call'].join('-')

  prepareDevelopmentProject({
    projectDir: project,
    cliDir: join(dshRoot, 'apps/cli'),
    hostDir: join(dshRoot, 'apps/desktop-host'),
    dependencyDir: join(dshRoot, 'node_modules/.pnpm/node_modules'),
    release: {
      schemaVersion: 1,
      version: dshVersion,
      pnpmVersion,
      nodeVersion: process.versions.node,
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    },
    target,
  })

  cpSync(join(dshRoot, 'packages/skill/skill-office/assets'), join(root, 'runtime/office-skills'), { recursive: true })
  const bundledNodeDir = join(root, 'runtime/primary-runtime/dependencies/node/bin')
  mkdirSync(bundledNodeDir, { recursive: true })
  cpSync(process.execPath, join(bundledNodeDir, process.platform === 'win32' ? 'node.exe' : 'node'))

  const paths = resolveDesktopPaths(home)
  const manager = new DesktopProjectManager(paths, { dsh: project })
  await manager.applyRelease()

  // The CLI intentionally refuses to mutate profiles/desktop because Electron owns
  // that profile. Materialize the post-install state directly, then let the exact
  // rc.2 Desktop Host load it. This fixture tests the runtime boundary, not the UI
  // package-manager surface.
  const manifestPath = join(paths.profile, 'package.json')
  const manifest = readJson(manifestPath)
  // Actual immutable npm artifacts; this reproduces a live Host upgrade,
  // not a source-dir cold installation.
  manifest.dependencies['dsh-vision-router'] = freshActivation ? '3.4.0' : '3.2.1'
  // Link the diagnostic fixture instead of packing it as a file: dependency.
  // PluginManager's expected-package guard rejects an unrelated dependency
  // if pnpm rematerializes its package.json during DVR's version update.
  manifest.dependencies['dvr-issue-877-probe'] = `link:${writeProbeFixture(root)}`
  if (freshActivation) {
    // The diagnostic bundle must be active before loading DVR so its status
    // listener can capture the very first activation failure, without a
    // modifying lifecycle shim or a reporter's private logs.
    manifest.dsh.profile.bundles.push('dvr-issue-877-probe', 'dsh-vision-router')
  } else {
    manifest.dsh.profile.bundles.push('dsh-vision-router', 'dvr-issue-877-probe')
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)

  const pnpmEntry = join(dshRoot, 'apps/desktop/node_modules/pnpm/bin/pnpm.mjs')
  const install = spawnSync(process.execPath, [pnpmEntry, 'install', '--dir', paths.profile, '--ignore-scripts'], {
    env: process.env,
    encoding: 'utf8',
    stdio: 'pipe',
  })
  if (install.status !== 0) {
    throw new Error(`Desktop profile install failed (${String(install.status)})\n${install.stdout}\n${install.stderr}`)
  }

  // Keep the web port explicit so this contract can run beside the other Desktop
  // scenarios in one job instead of silently requiring 19387 to be free.
  writeFileSync(join(paths.profile, 'cordis.patch.yml'),
    `- id: webserver\n  config:\n    host: 127.0.0.1\n    port: ${String(Number.parseInt(process.env.DVR_DESKTOP_BASE_PORT ?? '19387', 10) || 19387)}\n`)
  host = new DesktopHostProcess(process.execPath, project, paths.profile)
  const ready = await host.start()

  // Mirror Desktop main's authenticateWebHost() boundary: exchange the owned
  // Host launch token for a cookie, then prove that cookie can immediately
  // authorize both the index and the authenticated /api waterfall. The latter
  // catches the field failure where unauthenticated /api requests return 401
  // immediately but authenticated requests never settle.
  let cookie = ready.authenticationCookie
  let authMode = 'desktop-owned-cookie'
  if (typeof cookie !== 'string' || cookie.length === 0) {
    const login = await fetch(ready.url, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_DEADLINE_MS) })
    const setCookie = login.headers.get('set-cookie')
    await login.body?.cancel()
    if (login.status !== 303 || setCookie === null) {
      throw new Error(`Desktop Host token exchange failed: status=${String(login.status)} cookie=${String(setCookie !== null)}`)
    }
    cookie = setCookie.split(';', 1)[0]
    authMode = 'legacy-launch-token'
  }
  const authenticatedStatus = await statusProbe(ready.url, '/', cookie, 200)
  const authenticatedApiMissing = await statusProbe(ready.url, '/api/__dvr_missing__', cookie, 404)
  const authenticatedApiHealth = await statusProbe(ready.url, '/api/health', cookie, 404)

  if (freshActivation) {
    // Fresh-pinned installation deliberately bypasses Shop compatibility
    // refusal, to determine what the older unsupported Host actually does
    // when a mismatched DVR package is forced into the bundle list.
    const reply = await fetch(hostUrl(ready.url, '/__dvr_issue_877_upgrade'), {
      headers: { cookie },
      signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
    })
    const raw = await reply.text()
    if (reply.status !== 200) throw new Error(
      'Activation probe denied: HTTP ' + reply.status + ' ' + raw.slice(0, 450))
    const status = JSON.parse(raw)
    console.log('ISSUE_877_FRESH_ACTIVATION=' + JSON.stringify({
      dsh: dshVersion, node: process.version, dvr: '3.4.0',
      hmr: status.hmr, loader: status.loaderState, events: status.events,
    }))
  } else {
    // Update via the exact Host PluginManager path used by the Shop/market
  // after starting from the real published 3.2.1 Desktop profile.
  const upgrade = await fetch(hostUrl(ready.url, '/__dvr_issue_877_upgrade'), {
    method: 'POST',
    headers: { cookie },
    signal: AbortSignal.timeout(180_000),
  })
  const upgradeStatus = upgrade.status
  const upgradeText = await upgrade.text()
  let upgradeBody
  try {
    upgradeBody = upgradeText ? JSON.parse(upgradeText) : undefined
  } catch {
    throw new Error('Host PluginManager probe returned invalid JSON: status='
      + String(upgradeStatus) + ' content-type=' + String(upgrade.headers.get('content-type'))
      + ' body=' + upgradeText.slice(0, 600))
  }
  if (upgradeStatus !== 200 || !upgradeBody) {
    throw new Error('Host PluginManager probe did not reach JSON handler: status='
      + String(upgradeStatus) + ' content-type=' + String(upgrade.headers.get('content-type'))
      + ' body=' + upgradeText.slice(0, 600))
  }
  console.log('ISSUE_877_UPGRADE_PROBE=' + JSON.stringify({
    hostVersion: dshVersion, node: process.version,
    upgrade: upgradeBody.result, timeline: upgradeBody.events,
    phases: upgradeBody.updatePhases,
    hmrVisibleToProbe: upgradeBody.hmrVisibleToProbe,
    hmrVisibleToPluginManager: upgradeBody.hmrVisibleToPluginManager,
  }))
  const upgradeResult = upgradeBody.result
  if (upgradeResult?.result?.application === 'failed' || upgradeResult?.restore !== undefined) {
    throw new Error('Upgrading npm DVR 3.2.1 to 3.4.0 failed or rolled back: ' + JSON.stringify(upgradeBody))
  }

  // Exercise DVR's dedicated Connection RPC channel separately from /api. This
  // distinguishes a shared connection/request-waterfall stall from a DVR RPC
  // registration/handler stall.
  const rpcId = `dvr-desktop-probe-${Date.now()}`
  const rpcResponse = await fetch(hostUrl(ready.url, '/vision-router-settings/describe'), {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: 'describe',
      payload: {},
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
  })
  const rpcStatus = rpcResponse.status
  let rpcBody
  try { rpcBody = await rpcResponse.json() } catch { rpcBody = undefined }
  if (rpcStatus !== 200 || rpcBody?.type !== 'server-response' || rpcBody?.rpcId !== rpcId) {
    throw new Error(`Desktop Host DVR RPC probe failed: status=${rpcStatus} body=${JSON.stringify(rpcBody)}`)
  }

  const rows = ready.injections.filter((row) => row?.kind === 'script'
    && typeof row.text === 'string'
    && row.text.includes('data-vision-router-settings-017-compat'))
  if (rows.length !== 1) {
    throw new Error(`expected exactly one DVR Desktop bootstrap injection, found ${rows.length}`)
  }
  const [row] = rows
  if (row.placement !== 'head') throw new Error(`DVR Desktop bootstrap injection is not in <head>: ${String(row.placement)}`)
  if (!row.text.includes('__visionRouterSettings017Compat')) {
    throw new Error('DVR Desktop bootstrap injection is missing the 0.1.7 settings compatibility prelude')
  }
  if (/<\/script/i.test(row.text)) {
    throw new Error('DVR Desktop bootstrap injection contains a literal closing script tag')
  }

    console.log(JSON.stringify({
    ok: true,
    dsh: dshVersion,
    node: process.version,
    profile: 'desktop',
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    structuredInjections: ready.injections.length,
    dvrSettingsPreludeRows: rows.length,
    authentication: authMode,
    authenticatedIndex: authenticatedStatus,
    authenticatedApiMissing,
    authenticatedApiHealth,
    dvrRpcDescribe: rpcStatus,
  }))
  }
} finally {
  try { await host?.stop() } catch (error) { console.error('Desktop Host stop failed:', error) }
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(root, { recursive: true, force: true })
}
