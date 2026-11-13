import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dvrRoot = resolve(process.env.DVR_SOURCE_ROOT || join(here, '..'))
const dshRoot = resolve(process.env.DSH_SOURCE_ROOT || '')
if (!process.env.DSH_SOURCE_ROOT) throw new Error('DSH_SOURCE_ROOT is required')

const dshRequire = createRequire(join(dshRoot, 'package.json'))
const tsxLoader = pathToFileURL(dshRequire.resolve('tsx')).href
const cli = join(dshRoot, 'apps/cli/src/bin.ts')
const candidateSpec = String(process.env.DVR_SMOKE_PACKAGE_SPEC ?? '').trim()
const publishedVersion = String(process.env.DVR_SMOKE_PUBLISHED_VERSION ?? '').trim()
const reviewedPublishedVersions = new Set(['3.2.0', '3.2.1'])
if (publishedVersion && !reviewedPublishedVersions.has(publishedVersion)) {
  throw new Error('DVR_SMOKE_PUBLISHED_VERSION must be an explicitly reviewed immutable published version')
}
if (candidateSpec && publishedVersion) throw new Error('select one package provenance')
if (candidateSpec) {
  const file = candidateSpec.startsWith('file:') ? candidateSpec.slice(5) : ''
  if (!isAbsolute(file) || !file.endsWith('.tgz') || !existsSync(file)) {
    throw new Error('DVR_SMOKE_PACKAGE_SPEC requires an existing absolute file:*.tgz candidate')
  }
}
const installSpec = candidateSpec || (publishedVersion ? `dsh-vision-router@${publishedVersion}` : `file:${dvrRoot}`)


async function assertBundleInsertRecoversFromLoaderMutation() {
  const webRequire = createRequire(join(dshRoot, 'packages/bundle/web-app/package.json'))
  const includeEntry = webRequire.resolve('@deepseek-ai/cordis-plugin-include')
  const includeUrl = pathToFileURL(includeEntry).href
  const { applyEntryPatches, entryListSchema } = await import(includeUrl)
  const includeRequire = createRequire(includeEntry)
  const yaml = includeRequire('js-yaml')
  const patchText = readFileSync(join(dvrRoot, 'cordis.patch.yml'), 'utf8')
  const patches = yaml.load(patchText, { schema: entryListSchema })
  const warnings = []
  const apply = () => applyEntryPatches([], patches, (message, ...args) => warnings.push([message, ...args]))

  const first = apply()
  const row = first.find((entry) => entry?.id === 'vision-router')
  if (!row) throw new Error('bundle composition did not insert vision-router')

  // Exact reproduction of cordis-plugin-loader's self-dispose write. Because
  // Include pushes insert rows by reference, this also dirties patches[].insert
  // on affected Hosts (#2854 / #547).
  row.disabled = true

  const second = apply()
  const recovered = second.find((entry) => entry?.id === 'vision-router')
  if (!recovered || recovered.disabled === true) {
    throw new Error('bundle recompose inherited loader-mutated disabled=true')
  }
  if (warnings.some(([message]) => String(message).includes('vision-router'))) {
    throw new Error(`vision-router self-heal overlay was skipped: ${JSON.stringify(warnings)}`)
  }
}

function installCurrentPlugin(env) {
  const result = spawnSync(process.execPath,
    ['--import', tsxLoader, cli, 'plugin', '--profile', 'web', 'add', installSpec],
    { cwd: dshRoot, env, encoding: 'utf8', stdio: 'pipe' })
  if (result.status !== 0) {
    throw new Error(`plugin install failed (${result.status})\n${result.stdout}\n${result.stderr}`)
  }
}

function waitForReady(child) {
  return new Promise((resolveReady, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`dsh web not ready in 90s\n${output}`)), 90_000)
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /dsh web: (http:\/\/[^\s]+)/.exec(output)
      if (!match?.[1]) return
      clearTimeout(timer)
      resolveReady(match[1])
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`dsh web exited before ready: code=${code} signal=${signal}\n${output}`))
    })
  })
}

async function authenticatedWeb(launchUrl) {
  const response = await fetch(launchUrl, { redirect: 'manual' })
  const setCookie = response.headers.get('set-cookie')
  if (response.status !== 303 || setCookie === null) {
    throw new Error(`dsh web authentication returned HTTP ${response.status}`)
  }
  return { origin: new URL(launchUrl).origin, cookie: setCookie.split(';', 1)[0] }
}

async function assertLocalSettingsBridge(auth) {
  const response = await fetch(new URL('/_dsh/vision-router/local-settings', auth.origin), {
    headers: { cookie: auth.cookie },
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  })
  try {
    if (response.status !== 200) {
      throw new Error(`local-settings HTTP ${response.status}: published DVR ${publishedVersion} has no verified native settings bridge on DSH ${process.env.DSH_EXPECTED_VERSION || 'unknown'}`)
    }
    const body = await response.json()
    if (body?.ok !== true) throw new Error('local-settings response did not contain ok:true')
  } finally {
    await response.body?.cancel().catch(() => {})
  }
}

async function assertDvrRoute(auth, phase) {
  const response = await fetch(new URL('/_dsh/vision-router/logs', auth.origin), {
    cache: 'no-store',
    headers: { cookie: auth.cookie },
  })
  if (response.status !== 200) {
    throw new Error(`${phase}: DVR diagnostics route returned HTTP ${response.status}`)
  }
  const body = await response.json()
  if (body?.ok !== true) throw new Error(`${phase}: DVR diagnostics route is not healthy`)
}

const root = mkdtempSync(join(tmpdir(), 'dvr-017-recompose-'))
mkdirSync(join(root, 'workspace'))
const env = {
  ...process.env,
  DSH_HOME: join(root, '.dsh'),
  DSH_AGENTS_HOME: join(root, '.agents'),
  DEEPSEEK_API_KEY: ['keyless', 'dvr', 'recompose', 'no-call'].join('-'),
  TSX_TSCONFIG_PATH: join(dshRoot, 'tsconfig.json'),
}
let child
try {
  await assertBundleInsertRecoversFromLoaderMutation()
  installCurrentPlugin(env)
  child = spawn(process.execPath,
    ['--import', tsxLoader, cli, 'web', '--no-open', '--port', '0'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const readyUrl = await waitForReady(child)
  const auth = await authenticatedWeb(readyUrl)
  await assertDvrRoute(auth, 'before recompose')
  if (publishedVersion) await assertLocalSettingsBridge(auth)

  const profilePatch = join(env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')
  for (let generation = 1; generation <= 3; generation += 1) {
    const progressiveTools = generation % 2 === 1
    writeFileSync(profilePatch,
      `# DVR HMR generation ${generation}\n- id: vision-router\n  config:\n    progressiveTools: ${progressiveTools}\n`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 3_000))
    if (child.exitCode !== null) {
      throw new Error(`generation ${generation}: dsh web exited with ${child.exitCode}`)
    }
    await assertDvrRoute(auth, `after recompose ${generation}`)
  }

  console.log(JSON.stringify({
    ok: true,
    dsh: process.env.DSH_EXPECTED_VERSION || 'unknown',
    recomposes: 3,
    processStable: true,
    dvrRouteStable: true,
    installForm: candidateSpec ? 'packed-tarball' : publishedVersion ? 'published-npm' : 'source-directory',
  }))
} finally {
  if (child && child.exitCode === null) {
    const closed = new Promise((resolveClose) => child.once('close', resolveClose))
    child.kill('SIGTERM')
    await closed
  }
  rmSync(root, { recursive: true, force: true })
}
