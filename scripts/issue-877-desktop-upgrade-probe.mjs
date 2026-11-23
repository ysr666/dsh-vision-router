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
  writeFileSync(join(dir, 'index.js'), "export function apply(ctx) {\n  const events = []\n  const updatePhases = []\n  const requestId = 'issue-877-isolated-upgrade'\n  const firstFailures = []\n  ctx.on('plugin-manager/update-state', (state) => {\n    if (state?.requestId !== requestId) return\n    updatePhases.push(String(state?.step ?? 'unknown'))\n  }, { global: true })\n  ctx.on('internal/status', (fiber, previous) => {\n    const entryId = fiber?.entry?.options?.id || fiber?.name || ''\n    if (String(entryId).includes('vision-router')) {\n      const error = fiber?._error\n      const stack = error?.stack || (error ? String(error) : null)\n      const event = { entryId: String(entryId), from: previous, to: fiber?.state,\n        stack: typeof stack === 'string' ? stack.slice(0, 6000) : null }\n      if (event.stack && firstFailures.length < 5) firstFailures.push(event)\n      events.push(event)\n      if (events.length > 80) events.splice(0, events.length - 80)\n    }\n  }, { global: true })\n  ctx.inject(['webServer', 'pluginManager', 'connection'], (scope) => {\n    scope.effect(() => scope.webServer.register({\n      kind: 'exact', path: '/__dvr_issue_877_upgrade', auth: 'required',\n      async handler(req, res, peer) {\n        // Prefer the Host-admitted Peer on 0.2.3+ WebServer. Its\n        // Connection.admit() also exists, but re-authenticating the raw\n        // request inside a registered route can throw and cause blank HTTP 400.\n        // Legacy 0.2.2 WebServer passes no Peer; validate via Connection.admit.\n        const admission = peer?.principal?.kind === 'owner'\n          ? { peer }\n          : typeof scope.connection?.admit === 'function'\n            ? scope.connection.admit(req)\n            : { rejection: 403 }\n        const verified = 'peer' in admission\n          && admission.peer?.principal?.kind === 'owner'\n        if (!verified || req.method !== 'POST') {\n          res.writeHead(403, { 'content-type': 'application/json' })\n          res.end(JSON.stringify({\n            error: 'owner POST required',\n            method: req.method,\n            rejection: 'rejection' in admission ? admission.rejection : null,\n          }))\n          return\n        }\n        const hmrVisibleToProbe = scope.get('hmr') !== undefined\n        const hmrVisibleToPluginManager = scope.pluginManager.ctx?.get?.('hmr') !== undefined\n        const outcomes = []\n        try {\n          // Install Shop through the Host's own package/lockfile operations,\n          // not by editing profile dependencies directly. Otherwise the\n          // next pnpm update may rematerialize Shop and fail the post-install\n          // expected-package guard before DVR's activation is tested.\n          if (process.env.DVR_DIAG_WITH_SHOP === '1') {\n            const shop = await scope.pluginManager.installBundle('dsh-plugin-shop@0.9.4', { enabled: true })\n            outcomes.push({ prerequisite: 'host-install-shop', shop })\n            if (shop?.application !== 'applied') {\n              throw new Error('Host-managed Shop setup failed: ' + JSON.stringify(shop))\n            }\n            // Set up the baseline through Host-owned operations too: a\n            // separately pnpm-edited DVR dependency would be discarded when\n            // Host installs Shop and reconciles its own package inventory.\n            const baseline = await scope.pluginManager.installBundle('dsh-vision-router@3.2.1', { enabled: true })\n            outcomes.push({ prerequisite: 'host-install-dvr-3.2.1', baseline })\n            if (baseline?.application !== 'applied') {\n              throw new Error('Host-managed DVR baseline failed: ' + JSON.stringify(baseline))\n            }\n          }\n          const cycles = Math.min(5, Math.max(1, Number(process.env.DVR_DIAG_STRESS_CYCLES ?? '1')))\n          for (let i = 0; i < cycles; i++) {\n            const result = await scope.pluginManager.updateBundle('dsh-vision-router', '3.4.0', { requestId })\n            outcomes.push({ cycle: i + 1, upgrade: result })\n            if (result?.result?.application !== 'applied' || result?.restore) break\n            if (i + 1 >= cycles) break\n            const removed = await scope.pluginManager.removeBundle('dsh-vision-router')\n            outcomes.push({ cycle: i + 1, removed })\n            if (removed?.application !== 'applied') break\n            const reset = await scope.pluginManager.installBundle('dsh-vision-router@3.2.1', { enabled: true })\n            outcomes.push({ cycle: i + 1, reset })\n            if (reset?.application !== 'applied') break\n          }\n          const result = outcomes.filter(x => x.upgrade).at(-1)?.upgrade\n          res.writeHead(200, { 'content-type': 'application/json' })\n          res.end(JSON.stringify({ result, outcomes, events, firstFailures, updatePhases, hmrVisibleToProbe, hmrVisibleToPluginManager }))\n        } catch (error) {\n          res.writeHead(500, { 'content-type': 'application/json' })\n          res.end(JSON.stringify({ error: String(error), stack: error?.stack, outcomes, events, firstFailures, updatePhases, hmrVisibleToProbe, hmrVisibleToPluginManager }))\n        }\n      }\n    }), 'issue-877 isolated upgrade evidence endpoint')\n  })\n}\n")
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
  if (process.env.DVR_DIAG_WITH_SHOP !== '1') {
    manifest.dependencies['dsh-vision-router'] = '3.2.1'
  }
  // Install Shop and DVR through PluginManager AFTER the Host has started,
  // following the actual marketplace package and lockfile state machine.
  // Link the diagnostic fixture instead of packing it as a file: dependency.
  // PluginManager's expected-package guard rejects an unrelated dependency
  // if pnpm rematerializes its package.json during DVR's version update.
  manifest.dependencies['dvr-issue-877-probe'] = `link:${writeProbeFixture(root)}`
  if (process.env.DVR_DIAG_WITH_SHOP !== '1') manifest.dsh.profile.bundles.push('dsh-vision-router')
  manifest.dsh.profile.bundles.push('dvr-issue-877-probe')
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

  // Update via the exact Host PluginManager path used by the Shop/market
  // after starting from the real published 3.2.1 Desktop profile.
  const upgrade = await fetch(hostUrl(ready.url, '/__dvr_issue_877_upgrade'), {
    method: 'POST',
    headers: { cookie },
    signal: AbortSignal.timeout(540_000),
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
    outcomes: upgradeBody.outcomes,
    firstFailures: upgradeBody.firstFailures,
  }))
  const upgradeResult = upgradeBody.result
  const badOutcome = upgradeBody.outcomes?.find(record =>
    record.upgrade?.result?.application !== undefined && record.upgrade.result.application !== 'applied'
    || record.removed?.application !== undefined && record.removed.application !== 'applied'
    || record.reset?.application !== undefined && record.reset.application !== 'applied')
  if (badOutcome || (upgradeBody.outcomes?.filter(v => v.upgrade).length || 0) !==
      Number(process.env.DVR_DIAG_STRESS_CYCLES ?? '1')) {
    throw new Error('Multi-cycle upgrade/reset failure: ' + JSON.stringify(upgradeBody))
  }
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
  // ready.injections is a startup-only DesktopHostProcess snapshot. In the
  // Shop coexistence scenario, DVR is deliberately absent at Host boot and
  // added later through PluginManager; it must NOT be expected in that snapshot.
  const expectedBootstrapRows = process.env.DVR_DIAG_WITH_SHOP === '1' ? 0 : 1
  if (rows.length !== expectedBootstrapRows) {
    throw new Error(`expected ${expectedBootstrapRows} startup DVR bootstrap injection(s), found ${rows.length}`)
  }
  if (rows.length === 1) {
    const [row] = rows
    if (row.placement !== 'head') throw new Error(`DVR Desktop bootstrap injection is not in <head>: ${String(row.placement)}`)
    if (!row.text.includes('__visionRouterSettings017Compat')) {
      throw new Error('DVR Desktop bootstrap injection is missing the 0.1.7 settings compatibility prelude')
    }
    if (/<\/script/i.test(row.text)) {
      throw new Error('DVR Desktop bootstrap injection contains a literal closing script tag')
    }
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
} finally {
  try { await host?.stop() } catch (error) { console.error('Desktop Host stop failed:', error) }
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(root, { recursive: true, force: true })
}
