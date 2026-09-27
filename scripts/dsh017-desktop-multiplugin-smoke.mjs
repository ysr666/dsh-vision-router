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
if (expectedVersion && dshVersion !== expectedVersion) throw new Error(`expected DSH ${expectedVersion}, found ${dshVersion}`)

const importDsh = (path) => import(pathToFileURL(join(dshRoot, path)).href)
const { prepareDevelopmentProject } = await importDsh('apps/desktop/scripts/development-project.ts')
const { DesktopProjectManager } = await importDsh('apps/desktop/src/project-manager.ts')
const { resolveDesktopPaths } = await importDsh('apps/desktop/src/paths.ts')
const { DesktopHostProcess } = await importDsh('apps/desktop/src/host-process.ts')
const { DESKTOP_HOST_PROTOCOL_VERSION } = await importDsh('apps/desktop/src/host-protocol.ts')

const REQUEST_DEADLINE_MS = 6000
const fixtureNames = ['dvr-fixture-rpc', 'dvr-fixture-waterfall']
const orders = [
  ['dsh-vision-router', 'dvr-fixture-rpc', 'dvr-fixture-waterfall'],
  ['dsh-vision-router', 'dvr-fixture-waterfall', 'dvr-fixture-rpc'],
  ['dvr-fixture-rpc', 'dsh-vision-router', 'dvr-fixture-waterfall'],
  ['dvr-fixture-rpc', 'dvr-fixture-waterfall', 'dsh-vision-router'],
  ['dvr-fixture-waterfall', 'dsh-vision-router', 'dvr-fixture-rpc'],
  ['dvr-fixture-waterfall', 'dvr-fixture-rpc', 'dsh-vision-router'],
]

function writeFixture(root, name, source) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name,
    version: '1.0.0',
    type: 'module',
    main: './index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, undefined, 2)}\n`)
  writeFileSync(join(dir, 'index.js'), source)
  writeFileSync(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: ${name}\n      name: ${name}\n`)
  return dir
}

const rpcFixtureSource = `export function apply(ctx) {
  ctx.inject(['connection', 'webServer'], (scope) => {
    scope.effect(
      () => scope.connection.rpc.handle('/fixture-rpc', async (method, payload) => ({
        ok: true,
        value: { fixture: 'rpc', method, payload },
      })),
      'fixture: independent connection rpc consumer',
    )
  })
}
`

const waterfallFixtureSource = `export function apply(ctx) {
  ctx.on('connection/request', async (_request, _response, next) => {
    await Promise.resolve()
    return next()
  })
}
`

function hostUrl(base, pathname) {
  const url = new URL(base)
  url.pathname = pathname
  url.search = ''
  url.hash = ''
  return url
}

async function readCookie(readyUrl) {
  const response = await fetch(readyUrl, {
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
  })
  const setCookie = response.headers.get('set-cookie')
  const status = response.status
  await response.body?.cancel()
  if (status !== 303 || setCookie === null) {
    throw new Error(`Desktop Host token exchange failed: status=${status} cookie=${String(setCookie !== null)}`)
  }
  return setCookie.split(';', 1)[0]
}

async function requireStatus(base, pathname, cookie, expected) {
  const response = await fetch(hostUrl(base, pathname), {
    headers: { cookie },
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
  })
  const status = response.status
  await response.body?.cancel()
  if (status !== expected) throw new Error(`${pathname} expected ${expected}, found ${status}`)
  return status
}

async function rpcProbe(base, cookie, channel, method) {
  const rpcId = `${channel.replaceAll('/', '-')}-${Date.now()}-${Math.random()}`
  const response = await fetch(hostUrl(base, `${channel}/${method}`), {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { probe: true } }),
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
  })
  const status = response.status
  let body
  try { body = await response.json() } catch { body = undefined }
  if (status !== 200 || body?.type !== 'server-response' || body?.rpcId !== rpcId) {
    throw new Error(`${channel}/${method} RPC failed: status=${status} body=${JSON.stringify(body)}`)
  }
  return status
}

async function runScenario(order, sequence) {
  const root = mkdtempSync(join(tmpdir(), `dvr-017-multiplugin-${sequence}-`))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const target = process.platform === 'win32'
    ? 'win-x64'
    : process.platform === 'darwin' && process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  const pnpmVersion = readJson(join(dshRoot, 'apps/desktop/node_modules/pnpm/package.json')).version
  let host
  try {
    mkdirSync(home)
    process.env.DSH_HOME = home
    process.env.DSH_TELEMETRY_MODE = 'DISABLED'
    process.env.DEEPSEEK_API_KEY = ['keyless', 'dvr', 'desktop', 'multiplugin', 'no-call'].join('-')

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

    const fixturesRoot = join(root, 'fixtures')
    const fixtureDirs = new Map([
      ['dvr-fixture-rpc', writeFixture(fixturesRoot, 'dvr-fixture-rpc', rpcFixtureSource)],
      ['dvr-fixture-waterfall', writeFixture(fixturesRoot, 'dvr-fixture-waterfall', waterfallFixtureSource)],
    ])

    const manifestPath = join(paths.profile, 'package.json')
    const manifest = readJson(manifestPath)
    manifest.dependencies['dsh-vision-router'] = `file:${dvrRoot}`
    for (const name of fixtureNames) manifest.dependencies[name] = `file:${fixtureDirs.get(name)}`
    manifest.dsh.profile.bundles.push(...order)
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

    host = new DesktopHostProcess(process.execPath, project, paths.profile)
    const ready = await host.start()
    const cookie = await readCookie(ready.url)
    const indexStatus = await requireStatus(ready.url, '/', cookie, 200)
    const apiMissing = await requireStatus(ready.url, '/api/__dvr_multiplugin_missing__', cookie, 404)
    const apiHealth = await requireStatus(ready.url, '/api/health', cookie, 404)
    const dvrRpc = await rpcProbe(ready.url, cookie, '/vision-router-settings', 'describe')
    const fixtureRpc = await rpcProbe(ready.url, cookie, '/fixture-rpc', 'ping')
    const rows = ready.injections.filter((row) => row?.kind === 'script'
      && typeof row.text === 'string'
      && row.text.includes('data-vision-router-settings-017-compat'))
    if (rows.length !== 1) throw new Error(`expected one DVR structured prelude, found ${rows.length}`)

    return {
      sequence,
      order,
      indexStatus,
      apiMissing,
      apiHealth,
      dvrRpc,
      fixtureRpc,
      structuredPreludeRows: rows.length,
    }
  } finally {
    try { await host?.stop() } catch (error) { console.error('Desktop Host stop failed:', error) }
    rmSync(root, { recursive: true, force: true })
  }
}

const previousEnv = new Map(['DSH_HOME', 'DSH_TELEMETRY_MODE', 'DEEPSEEK_API_KEY']
  .map((name) => [name, process.env[name]]))
const results = []
try {
  for (let index = 0; index < orders.length; index += 1) {
    results.push(await runScenario(orders[index], index + 1))
  }
  console.log(JSON.stringify({
    ok: true,
    dsh: dshVersion,
    node: process.version,
    platform: process.platform,
    scenarios: results,
  }))
} finally {
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}
