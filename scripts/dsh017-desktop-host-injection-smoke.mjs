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
const previousEnv = new Map(['DSH_HOME', 'DSH_TELEMETRY_MODE', 'DEEPSEEK_API_KEY']
  .map((name) => [name, process.env[name]]))
let host

try {
  mkdirSync(home)
  process.env.DSH_HOME = home
  process.env.DSH_TELEMETRY_MODE = 'DISABLED'
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
  manifest.dependencies['dsh-vision-router'] = `file:${dvrRoot}`
  manifest.dsh.profile.bundles.push('dsh-vision-router')
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
    profile: 'desktop',
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    structuredInjections: ready.injections.length,
    dvrSettingsPreludeRows: rows.length,
  }))
} finally {
  try { await host?.stop() } catch (error) { console.error('Desktop Host stop failed:', error) }
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(root, { recursive: true, force: true })
}
