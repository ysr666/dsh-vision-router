import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { lstat, mkdir, readFile, writeFile, copyFile, rename, rm, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname, delimiter } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { localNativeOcrInstallPaths } from './native-ocr-installation.js'
import { verifyExperimentalNativeOcrBinary } from './native-ocr-canary.js'
import { verifyNativeOcrAssets } from './native-ocr-integrity.js'

// Optional by design. Do not modify the DSH profile or global system packages.
// npm downloads happen only after a local user explicitly selects Install.
export const OPTIONAL_TESSERACT_PACKAGES = Object.freeze({
  'tesseract.js': ['7.0.0', 'sha512-exPBkd+z+wM1BuMkx/Bjv43OeLBxhL5kKWsz/9JY+DXcXdiBjiAch0V49QR3oAJqCaL5qURE0vx9Eo+G5YE7mA=='],
  '@tesseract.js-data/chi_sim': ['1.0.0', 'sha512-iuErURkPbECDUazgsLn/r3c+tU2y5o5S/w14d0A/YiagfsjYyZKgTo75RUpsGJ311qtu0dIX4hqnXAAjmqf2CA=='],
  '@tesseract.js-data/eng': ['1.0.0', 'sha512-mbTumm6KQPUHyzTPQaF3ObXYnx0SqqfV2nabqFVQBwD6Kl7PhGSLSzOlfFTWy0P3BjghaSKA2W9GB19Jk+ZcTg=='],
})
const TESS_LANGUAGES = Object.freeze({
  chi_sim: Object.freeze({ bytes: 1718768, sha256: 'b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c' }),
  eng: Object.freeze({ bytes: 2952873, sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91' }),
})
const MANAGED_MARK = 'dvr-tesseract-js-v1'
const TESS_VERSION = '7.0.0'
const MAX_BINARY_UPLOAD = 64 * 1024 * 1024
const TESS_INSTALL_TIMEOUT_MS = 180_000
let mutating = false
let activeManagedRuns = 0
export const managedTesseractPaths = ({ home = homedir() } = {}) => {
  const root = join(home, '.dsh-vision-router', 'ocr', 'tesseract-js')
  return Object.freeze({ root, manifest: join(root, 'DVR-MANAGED.json'), models: join(root, 'models') })
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function installedLockRow(lock, name) {
  const key = 'node_modules/' + name
  // npm --prefix <absolute staging directory> can write canonicalized,
  // prefix-relative lockfile keys (not just 'node_modules/...'). The package
  // lock is moved atomically with the staged tree; resolve by exact suffix.
  const rows = Object.entries(lock?.packages ?? {}).filter(([path]) =>
    path === key || path.endsWith('/' + key))
  return rows.length === 1 ? rows[0][1] : undefined
}
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'))
async function regularFile(path, maxBytes = 20 * 1024 * 1024) {
  try {
    const st = await lstat(path)
    return st.isFile() && !st.isSymbolicLink() && st.size > 0 && st.size <= maxBytes
  } catch { return false }
}
async function directory(path) {
  try { const st = await lstat(path); return st.isDirectory() && !st.isSymbolicLink() }
  catch { return false }
}
async function ownedNativeDirectory(root) {
  if (!await directory(root)) return false
  const notice = join(root, 'SOURCE-NOTICE.md')
  if (!await regularFile(notice, 32 * 1024)) return false
  try {
    const contents = await readFile(notice, 'utf8')
    return contents.startsWith('# Locally installed native OCR assets\n') &&
      contents.includes('Runtime: Tencent/ncnn @')
  } catch { return false }
}
async function verifyManaged(root) {
  const manifest = join(root, 'DVR-MANAGED.json')
  if (!await directory(root) || !await regularFile(manifest, 4096)) return false
  let marker
  try { marker = await readJSON(manifest) } catch { return false }
  if (marker?.kind !== MANAGED_MARK || marker.version !== TESS_VERSION) return false
  const pkgs = marker.packages
  for (const [name, [version, integrity]] of Object.entries(OPTIONAL_TESSERACT_PACKAGES)) {
    if (pkgs?.[name]?.version !== version || pkgs?.[name]?.integrity !== integrity) return false
    const base = join(root, 'node_modules', ...name.split('/'))
    if (!await directory(base) || !await regularFile(join(base, 'package.json'), 200_000)) return false
    let pkg
    try { pkg = await readJSON(join(base, 'package.json')) } catch { return false }
    if (pkg?.name !== name || pkg?.version !== version) return false
  }
  const lock = await readJSON(join(root, 'package-lock.json')).catch(() => null)
  if (!lock?.packages) return false
  for (const [name, [version, integrity]] of Object.entries(OPTIONAL_TESSERACT_PACKAGES)) {
    const row = installedLockRow(lock, name)
    if (row?.version !== version || row?.integrity !== integrity) return false
  }
  for (const [name, expected] of Object.entries(TESS_LANGUAGES)) {
    const file = join(root, 'models', name + '.traineddata.gz')
    if (!await regularFile(file, 10 * 1024 * 1024)) return false
    const bytes = await readFile(file)
    if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) return false
  }
  return true
}
export async function systemTesseract() {
  const probe = spawnSync('tesseract', ['--list-langs'], { encoding: 'utf8', timeout: 3000, windowsHide: true, maxBuffer: 16384 })
  const names = (probe.stdout ?? '') + '\n' + (probe.stderr ?? '')
  return probe.status === 0 && /(?:^|\s)chi_sim(?:\s|$)/.test(names) && /(?:^|\s)eng(?:\s|$)/.test(names)
}
export async function optionalOcrStatus({
  home = homedir(),
  probeSystem = systemTesseract,
  resolveNativePaths = localNativeOcrInstallPaths,
} = {}) {
  const tess = managedTesseractPaths({ home })
  const pp = resolveNativePaths({ home })
  const [managedTesseract, nativeReady, systemReady, nativeOwned] = await Promise.all([
    verifyManaged(tess.root).catch(() => false),
    pp && await directory(pp.root)
      ? Promise.all([verifyExperimentalNativeOcrBinary(pp.binaryPath), verifyNativeOcrAssets(pp.modelDir)]).then(() => true, () => false)
      : false,
    Promise.resolve().then(() => probeSystem()).catch(() => false),
    pp ? ownedNativeDirectory(pp.root) : false,
  ])
  return {
    ok: true,
    busy: mutating,
    tesseract: { managedInstalled: managedTesseract, systemInstalled: !!systemReady, installed: managedTesseract || !!systemReady, canInstall: !mutating && !managedTesseract && !systemReady, canUninstall: !mutating && managedTesseract && activeManagedRuns === 0 },
    ppocrv6: { installed: nativeReady, damaged: nativeOwned && !nativeReady, supported: !!pp, canInstallFromFile: !mutating && !!pp, canUninstall: !mutating && nativeOwned },
  }
}
export function nodeChildEnvironment({ env = process.env, electron = process.versions?.electron } = {}) {
  // Electron's process.execPath is the app executable. It must be launched
  // with the supported Node mode; never inherit Host runtime preload flags.
  return {
    ...env, NODE_OPTIONS: '',
    ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  }
}
async function npmCommand() {
  if (process.platform !== 'win32') return { exe: 'npm', prefix: [] }
  const searchDirs = [dirname(process.execPath),
    ...String(process.env.PATH ?? '').split(delimiter)
      .map(path => path.replace(/^["']|["']$/g, '').trim()).filter(Boolean)]
  for (const base of [...new Set(searchDirs)]) {
    const candidate = join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (await regularFile(candidate, 100_000))
      return { exe: process.execPath, prefix: [candidate] }
  }
  throw Error('npm CLI unavailable for portable Tesseract installation')
}
function execBounded(exe, args, { cwd, timeout = TESS_INSTALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...nodeChildEnvironment({ electron: exe === process.execPath ? process.versions?.electron : undefined }), npm_config_update_notifier: 'false', npm_config_audit: 'false' } })
    let log = ''
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    child.stderr.on('data', chunk => { log = (log + String(chunk)).slice(-1200) })
    child.on('error', error => finish(Error('optional OCR installer unavailable: ' + error.message)))
    child.on('close', code => finish(code === 0 ? null : Error('optional OCR install failed (' + code + '): ' + log.slice(-400))))
    const timer = setTimeout(() => {
      child.kill()
      finish(Error('optional OCR package installation timed out'))
    }, timeout)
    timer.unref?.()
  })
}
async function assertOwned(root) {
  if (!await directory(root)) throw Error('the OCR directory is not a real managed directory')
  if (!await regularFile(join(root, 'DVR-MANAGED.json'), 4096)) throw Error('refusing to remove unowned OCR directory')
  const marker = await readJSON(join(root, 'DVR-MANAGED.json'))
  if (marker?.kind !== MANAGED_MARK) throw Error('refusing to remove unowned OCR installation')
}
export async function installTesseract({ home = homedir(), npm = npmCommand, exec = execBounded, probeSystem = systemTesseract } = {}) {
  // A valid system installation already meets this optional capability.
  // Do not download a second Tesseract implementation or touch system files.
  if (await probeSystem()) return { ok: true, installed: false, reusedSystem: true, engine: 'tesseract' }
  const dest = managedTesseractPaths({ home })
  if (await directory(dest.root)) throw Error('Tesseract managed directory already exists; refusing to overwrite')
  const parent = dirname(dest.root)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const stage = join(parent, '.tesseract-stage-' + randomUUID())
  await mkdir(stage, { mode: 0o700 })
  try {
    const cli = await npm()
    const packages = Object.entries(OPTIONAL_TESSERACT_PACKAGES).map(([name, [version]]) => name + '@' + version)
    await exec(cli.exe, [...cli.prefix, 'install', ...packages, '--prefix', stage,
      '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund',
      '--registry=https://registry.npmjs.org/', '--no-progress'], { cwd: stage })
    await mkdir(join(stage, 'models'), { mode: 0o700 })
    for (const [language, expected] of Object.entries(TESS_LANGUAGES)) {
      const input = join(stage, 'node_modules', '@tesseract.js-data', language,
        '4.0.0_best_int', language + '.traineddata.gz')
      if (!await regularFile(input, 10 * 1024 * 1024)) throw Error('missing Tesseract language model: ' + language)
      const raw = await readFile(input)
      if (raw.length !== expected.bytes || hash(raw) !== expected.sha256) throw Error('Tesseract model integrity mismatch: ' + language)
      const out = join(stage, 'models', language + '.traineddata.gz')
      await copyFile(input, out)
      await chmod(out, 0o600)
    }
    const packagesLock = await readJSON(join(stage, 'package-lock.json'))
    for (const [name, [version, integrity]] of Object.entries(OPTIONAL_TESSERACT_PACKAGES)) {
      const row = installedLockRow(packagesLock, name)
      if (row?.version !== version || row?.integrity !== integrity) throw Error('untrusted npm package identity: ' + name)
    }
    await writeFile(join(stage, 'DVR-MANAGED.json'), JSON.stringify({
      kind: MANAGED_MARK, version: TESS_VERSION,
      packages: Object.fromEntries(Object.entries(OPTIONAL_TESSERACT_PACKAGES).map(([name, [version, integrity]]) => [name, { version, integrity }])),
    }), { mode: 0o600 })
    if (!await verifyManaged(stage)) throw Error('Tesseract installation verification failed')
    await rename(stage, dest.root)
    return { ok: true, installed: true, engine: 'tesseract' }
  } finally { await rm(stage, { recursive: true, force: true }) }
}
export async function uninstallTesseract({ home = homedir() } = {}) {
  if (activeManagedRuns > 0) throw Error('Tesseract is busy; retry after OCR completes')
  const dest = managedTesseractPaths({ home })
  await assertOwned(dest.root)
  const tomb = dest.root + '.removing-' + randomUUID()
  await rename(dest.root, tomb)
  await rm(tomb, { recursive: true, force: true })
  return { ok: true, installed: false, engine: 'tesseract' }
}
function nativeInstallerPath() {
  // source checkout: src/lib -> repo/scripts; packed runtime: lib -> repo/scripts
  const adjacent = fileURLToPath(new URL('../scripts/install-native-ocr.mjs', import.meta.url))
  if (existsSync(adjacent)) return adjacent
  return fileURLToPath(new URL('../../scripts/install-native-ocr.mjs', import.meta.url))
}
export async function installNativeBundle(bytes, { home = homedir(), exec = execBounded } = {}) {
  const dest = localNativeOcrInstallPaths({ home })
  if (!dest) throw Error('PP-OCRv6 is not approved for this platform')
  if (!Buffer.isBuffer(bytes) || bytes.length < 128 || bytes.length > MAX_BINARY_UPLOAD) throw Error('invalid PP-OCRv6 archive')
  const archive = join(tmpdir(), 'dvr-ocr-bundle-' + randomUUID() + '.tar.gz')
  try {
    await writeFile(archive, bytes, { mode: 0o600, flag: 'wx' })
    await exec(process.execPath, [nativeInstallerPath(), '--bundle', archive], { timeout: 180_000 })
    await verifyExperimentalNativeOcrBinary(dest.binaryPath)
    await verifyNativeOcrAssets(dest.modelDir)
    return { ok: true, installed: true, engine: 'ppocrv6' }
  } finally { await rm(archive, { force: true }) }
}
export async function uninstallNative({
  home = homedir(),
  resolvePaths = localNativeOcrInstallPaths,
} = {}) {
  const dest = resolvePaths({ home })
  if (!dest || !await directory(dest.root)) throw Error('PP-OCRv6 is not installed')
  // A corrupt model/worker is precisely when the user must still be able
  // to remove an optional installation. Require the installer-created
  // owner notice and exact managed directory instead of full model hashes.
  // Never mutate a system binary, a symlink, or an arbitrary caller path.
  if (!await ownedNativeDirectory(dest.root))
    throw Error('refusing to remove unowned PP-OCRv6 installation')
  const tomb = dest.root + '.removing-' + randomUUID()
  await rename(dest.root, tomb)
  await rm(tomb, { recursive: true, force: true })
  return { ok: true, installed: false, engine: 'ppocrv6' }
}
export async function mutateOptionalOcr({ engine, action, archive, adapters = {} }) {
  if (mutating) throw Error('another OCR installation operation is already running')
  if (!['tesseract', 'ppocrv6'].includes(engine) || !['install', 'uninstall'].includes(action)) throw Error('invalid OCR operation')
  if (engine === 'ppocrv6' && action === 'install' && !Buffer.isBuffer(archive)) throw Error('a local PP-OCRv6 bundle is required')
  mutating = true
  try {
    if (engine === 'tesseract') {
      return action === 'install' ? await (adapters.installTesseract ?? installTesseract)()
        : await (adapters.uninstallTesseract ?? uninstallTesseract)()
    }
    return action === 'install'
      ? await (adapters.installNativeBundle ?? installNativeBundle)(archive)
      : await (adapters.uninstallNative ?? uninstallNative)()
  } finally { mutating = false }
}
export async function runManagedTesseractOcr(bytes, { timeoutMs = 12000, signal } = {}) {
  const dest = managedTesseractPaths()
  if (!await verifyManaged(dest.root)) throw Error('managed Tesseract unavailable')
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8 || bytes.byteLength > 24 * 1024 * 1024)
    throw Error('OCR image outside managed Tesseract bounds')
  if (signal?.aborted) throw Error('OCR aborted')
  if (activeManagedRuns >= 2) throw Error('managed Tesseract busy')
  activeManagedRuns++
  try {
    const script = fileURLToPath(new URL('./managed-tesseract-child.js', import.meta.url))
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, dest.root], {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...nodeChildEnvironment(), DVR_OCR_CHILD: '1' },
      })
      let output = ''
      let expired = false
      let done = false
      const finish = (error, result) => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(result)
      }
      const onAbort = () => {
        expired = true
        child.kill()
        finish(Error('OCR aborted'))
      }
      const timer = setTimeout(() => {
        expired = true
        child.kill()
        finish(Error('managed Tesseract timeout'))
      }, Math.max(1, Math.min(120000, timeoutMs)))
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', part => {
        output += String(part)
        if (output.length > 128 * 1024) {
          child.kill()
          finish(Error('managed Tesseract output too large'))
        }
      })
      child.stderr.resume()
      child.on('error', () => finish(Error('managed Tesseract could not start')))
      child.on('close', code => {
        if (expired || done) return
        if (code !== 0) return finish(Error('managed Tesseract worker failed'))
        try {
          const data = JSON.parse(output)
          if (typeof data?.text !== 'string' || !Number.isFinite(data.confidence)) throw Error('invalid result')
          finish(null, { engine: 'tesseract', text: data.text.trim(), confidence: data.confidence })
        } catch { finish(Error('managed Tesseract output invalid')) }
      })
      child.stdin.on('error', () => {})
      child.stdin.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    })
  } finally { activeManagedRuns-- }
}
