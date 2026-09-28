import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const dvrRoot = resolve(process.env.DVR_SOURCE_ROOT || join(here, '..'))
const dshRoot = resolve(process.env.DSH_SOURCE_ROOT || '')
if (!process.env.DSH_SOURCE_ROOT) throw new Error('DSH_SOURCE_ROOT is required')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const dshVersion = readJson(join(dshRoot, 'apps/desktop/package.json')).version
const expectedVersion = process.env.DSH_EXPECTED_VERSION
if (expectedVersion && dshVersion !== expectedVersion) throw new Error(`expected DSH ${expectedVersion}, found ${dshVersion}`)

const importDsh = path => import(pathToFileURL(join(dshRoot, path)).href)
const { DesktopHostProcess } = await importDsh('apps/desktop/src/host-process.ts')
const { createPluginProfile } = await importDsh('apps/desktop/src/project-manager.ts')
const { desktopNodeEnvironment } = await importDsh('apps/desktop/src/node-environment.ts')
const { resolveDesktopTargetBuildPaths } = await importDsh('apps/desktop/scripts/desktop-build-paths.mjs')
const buildPaths = resolveDesktopTargetBuildPaths()
const application = join(buildPaths.unsignedArtifacts, 'win-unpacked')
const resources = join(application, 'resources')
const executable = join(application, 'DeepSeek Harness.exe')
const runtimeRoot = join(resources, 'app.asar', 'dsh')
const resourcesRuntime = join(resources, 'runtime')
if (!existsSync(executable) || !existsSync(join(resources, 'app.asar'))) throw new Error(`packaged Desktop application missing at ${application}`)

const root = mkdtempSync(join(tmpdir(), 'dvr-020-packaged-desktop-'))
const home = join(root, 'home')
const profile = join(home, 'profiles', 'desktop')
const fixture = join(root, 'observer-fixture')
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED', DEEPSEEK_API_KEY: 'keyless-dvr-packaged-audit' }
let host
const deadline = 10_000
function endpoint(base, pathname) { const url = new URL(base); url.pathname = pathname; url.search = ''; url.hash = ''; return url }

try {
  mkdirSync(home, { recursive: true })
  mkdirSync(fixture, { recursive: true })
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'dvr-packaged-observer', version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './bundle.yml' } } }))
  writeFileSync(join(fixture, 'bundle.yml'), '- insert:\n    - id: dvr-packaged-observer\n      name: dvr-packaged-observer\n      inject: [webServer]\n')
  writeFileSync(join(fixture, 'index.js'), `export function apply(ctx) {\n  const descriptor = Object.getOwnPropertyDescriptor(ctx.webServer, 'register')\n  const state = { ownRegister: descriptor !== undefined, registerName: descriptor?.value?.name ?? null }\n  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/dvr-packaged-observer', handler(_request, response) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(state)) } }))\n}\n`)

  createPluginProfile(profile)
  const manifestPath = join(profile, 'package.json')
  const manifest = readJson(manifestPath)
  manifest.dependencies['dsh-vision-router'] = `file:${dvrRoot}`
  manifest.dependencies['dvr-packaged-observer'] = `file:${fixture}`
  manifest.dsh.profile.bundles.push('dsh-vision-router', 'dvr-packaged-observer')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')

  const pnpm = join(resourcesRuntime, 'pnpm', 'bin', 'pnpm.cjs')
  const nodeBin = join(resourcesRuntime, 'bin')
  const install = spawnSync(executable, [pnpm, 'install', '--dir', profile, '--ignore-scripts'], {
    env: desktopNodeEnvironment(executable, nodeBin, env), encoding: 'utf8', stdio: 'pipe', timeout: 180_000,
  })
  if (install.status !== 0) throw new Error(`packaged Desktop profile install failed (${String(install.status)})\n${install.stdout}\n${install.stderr}`)

  host = new DesktopHostProcess(executable, runtimeRoot, profile, undefined, env, undefined,
    join(resourcesRuntime, 'primary-runtime'), { pnpm, nodeBin })
  const ready = await Promise.race([host.start(), new Promise((_, reject) => setTimeout(() => reject(new Error('packaged Desktop Host readiness timed out')), 120_000))])
  const login = await fetch(ready.url, { redirect: 'manual', signal: AbortSignal.timeout(deadline) })
  const setCookie = login.headers.get('set-cookie')
  await login.body?.cancel()
  if (login.status !== 303 || setCookie === null) throw new Error(`packaged Desktop token exchange failed: ${login.status}`)
  const cookie = setCookie.split(';', 1)[0]
  const index = await fetch(endpoint(ready.url, '/'), { headers: { cookie }, signal: AbortSignal.timeout(deadline) })
  if (index.status !== 200) throw new Error(`packaged Desktop index expected 200, found ${index.status}`)
  await index.body?.cancel()
  const missing = await fetch(endpoint(ready.url, '/api/__dvr_missing__'), { headers: { cookie }, signal: AbortSignal.timeout(deadline) })
  if (missing.status !== 404) throw new Error(`packaged Desktop API missing expected 404, found ${missing.status}`)
  await missing.body?.cancel()

  const rpcId = `dvr-packaged-${Date.now()}`
  const rpc = await fetch(endpoint(ready.url, '/vision-router-settings/describe'), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method: 'describe', payload: {} }), signal: AbortSignal.timeout(deadline) })
  const rpcBody = await rpc.json().catch(() => undefined)
  if (rpc.status !== 200 || rpcBody?.type !== 'server-response' || rpcBody?.rpcId !== rpcId) throw new Error(`packaged Desktop DVR RPC failed: status=${rpc.status} body=${JSON.stringify(rpcBody)}`)

  const observer = await fetch(endpoint(ready.url, '/dvr-packaged-observer'), { headers: { cookie }, signal: AbortSignal.timeout(deadline) })
  const observerBody = await observer.json()
  if (observer.status !== 200 || observerBody.ownRegister !== false) throw new Error(`packaged Desktop foreign registrar leak: status=${observer.status} body=${JSON.stringify(observerBody)}`)
  const rows = (ready.injections ?? []).filter(row => row?.kind === 'script' && typeof row.text === 'string' && row.text.includes('data-vision-router-settings-017-compat'))
  if (rows.length !== 1) throw new Error(`packaged Desktop expected one DVR structured injection, found ${rows.length}`)
  console.log(JSON.stringify({ ok: true, dsh: dshVersion, packaged: true, auth: login.status, index: 200, apiMissing: 404, dvrRpc: rpc.status, observer: observerBody, dvrInjectionRows: rows.length }))
} finally {
  try { await host?.stop() } catch (error) { console.error('packaged Desktop Host stop failed:', error) }
  rmSync(root, { recursive: true, force: true })
}
