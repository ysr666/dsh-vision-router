import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { PACKAGE_NAME } from './update-check.js'

const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'
const PROFILE_RE = /^[A-Za-z0-9._-]+$/

function safeRealpath(value) {
  try {
    return realpathSync(value)
  } catch {
    return undefined
  }
}

function readPackageJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

export function profileFromArgv(argv = process.argv) {
  const list = Array.isArray(argv) ? argv : []
  for (let index = 2; index < list.length; index += 1) {
    const value = String(list[index] ?? '')
    if (value === '--profile') {
      const next = String(list[index + 1] ?? '')
      return PROFILE_RE.test(next) ? next : undefined
    }
    if (value.startsWith('--profile=')) {
      const next = value.slice('--profile='.length)
      return PROFILE_RE.test(next) ? next : undefined
    }
  }
  // This updater is exposed by the Web settings card. When DSH did not pass
  // an explicit --profile, use the documented Web profile default.
  return 'web'
}

export function findDshPackageRoot(cliEntry, { maxParents = 12 } = {}) {
  const resolved = safeRealpath(cliEntry)
  if (!resolved) return undefined
  let directory = path.dirname(resolved)
  for (let depth = 0; depth <= maxParents; depth += 1) {
    const manifestPath = path.join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = readPackageJson(manifestPath)
      if (manifest && manifest.name === DSH_PACKAGE_NAME) {
        return {
          packageRoot: directory,
          manifestPath,
          version: typeof manifest.version === 'string' ? manifest.version : undefined,
        }
      }
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/**
 * Detect whether the running process exposes a DSH CLI entry we can safely
 * re-use. This deliberately does not infer npm/pnpm/npx/bun: the updater calls
 * the exact DSH CLI package that is already running and lets DSH own plugin
 * installation semantics.
 */
export function detectDshSelfUpdatePlan({
  argv = process.argv,
  execPath = process.execPath,
} = {}) {
  const cliArg = Array.isArray(argv) ? argv[1] : undefined
  if (typeof cliArg !== 'string' || cliArg.trim() === '') {
    return { available: false, reason: 'cli-entry-missing' }
  }
  const cliEntry = safeRealpath(cliArg)
  if (!cliEntry) return { available: false, reason: 'cli-entry-unresolved' }

  // Running a raw TS/TSX source entry with plain Node may require a loader
  // owned by the source workspace. Do not guess that loader; fall back to the
  // manual update instructions instead.
  const extension = path.extname(cliEntry).toLowerCase()
  if (extension === '.ts' || extension === '.tsx') {
    return { available: false, reason: 'source-cli-needs-loader' }
  }

  const owner = findDshPackageRoot(cliEntry)
  if (!owner) return { available: false, reason: 'unverified-dsh-cli' }
  const profile = profileFromArgv(argv)
  if (!profile) return { available: false, reason: 'profile-unresolved' }
  if (typeof execPath !== 'string' || execPath.trim() === '') {
    return { available: false, reason: 'node-entry-missing' }
  }

  return {
    available: true,
    method: 'current-dsh-cli',
    execPath,
    cliEntry,
    profile,
    dshVersion: owner.version,
    packageRoot: owner.packageRoot,
  }
}

function outputDetail(error) {
  const parts = [
    error && error.stderr,
    error && error.stdout,
    error && error.message,
  ]
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim())
  return (parts[0] || 'unknown update error').slice(0, 1200)
}

/**
 * Run the documented DSH plugin updater through the exact DSH CLI entry that
 * is already hosting this plugin. No shell is involved and no package-manager
 * command is guessed.
 */
export async function runDshPluginUpdate(plan, {
  execFileImpl,
  timeoutMs = 180000,
  env = process.env,
} = {}) {
  if (!plan || plan.available !== true) {
    throw new Error(`automatic update unavailable (${plan?.reason || 'unknown reason'})`)
  }
  const runner = execFileImpl || promisify(execFile)
  const args = [
    plan.cliEntry,
    'plugin',
    '--profile',
    plan.profile,
    'update',
    PACKAGE_NAME,
  ]
  try {
    const result = await runner(plan.execPath, args, {
      env,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      shell: false,
    })
    return {
      ok: true,
      method: plan.method,
      profile: plan.profile,
      stdout: typeof result?.stdout === 'string' ? result.stdout.trim().slice(-2000) : '',
      stderr: typeof result?.stderr === 'string' ? result.stderr.trim().slice(-2000) : '',
      restartRequired: true,
    }
  } catch (error) {
    throw new Error(`DSH plugin update failed: ${outputDetail(error)}`)
  }
}
