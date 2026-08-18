import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveDshHome } from './doctor.js'
import { classifyProfilePnpmFailure } from './profile-pnpm-diagnostics.js'
import { CURRENT_VERSION, PACKAGE_NAME, compareSemver, parseSemver } from './update-check.js'

const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'
const PROFILE_RE = /^[A-Za-z0-9._-]+$/

// Specifiers pnpm resolves outside the npm registry: git/hosted repos, local
// paths, workspace links and tarballs. Those must keep `update` semantics;
// only plain registry specs are safe to re-install explicitly.
const NON_REGISTRY_SPEC_RE = /^(?:git\+|github:|gitlab:|bitbucket:|file:|link:|workspace:|https?:|[./\\])/

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
  const profile = profileFromArgv(argv)
  if (!profile) return { available: false, reason: 'profile-unresolved' }

  // Running a raw TS/TSX source entry with plain Node may require a loader
  // owned by the source workspace. Do not guess that loader; fall back to the
  // manual update instructions instead. Preserve the profile so the UI can
  // print the exact pnpm command the user should run.
  const extension = path.extname(cliEntry).toLowerCase()
  if (extension === '.ts' || extension === '.tsx') {
    return { available: false, reason: 'source-cli-needs-loader', profile }
  }

  const owner = findDshPackageRoot(cliEntry)
  if (!owner) return { available: false, reason: 'unverified-dsh-cli' }
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

function profileDirOf(dshHome, profile) {
  return path.join(dshHome, 'profiles', profile)
}

/** Version of the plugin manifest pnpm actually materialized under the profile. */
function readInstalledPluginVersion({ dshHome, profile }) {
  const manifestPath = path.join(
    profileDirOf(dshHome, profile),
    'node_modules',
    PACKAGE_NAME,
    'package.json',
  )
  const manifest = readPackageJson(manifestPath)
  return manifest && typeof manifest.version === 'string' ? manifest.version : undefined
}

/** How the profile declares this plugin (e.g. `^1.2.0` or a git/file spec). */
function readProfilePluginSpec({ dshHome, profile }) {
  const manifest = readPackageJson(path.join(profileDirOf(dshHome, profile), 'package.json'))
  const spec = manifest?.dependencies?.[PACKAGE_NAME]
  return typeof spec === 'string' ? spec : undefined
}

/**
 * Whether the update actually moved the installed version. A package-manager
 * exit code of 0 proves nothing: pnpm >= 11 silently keeps the current
 * version when the target release is younger than `minimumReleaseAge` and
 * still exits 0 ("Already up to date").
 */
export function updateTookEffect({
  installedVersion,
  targetVersion,
  currentVersion = CURRENT_VERSION,
} = {}) {
  if (!installedVersion || parseSemver(installedVersion) === undefined) {
    return { effect: false, reason: 'unreadable-installed-version' }
  }
  if (targetVersion && parseSemver(targetVersion) !== undefined) {
    const precedence = compareSemver(installedVersion, targetVersion)
    if (precedence === undefined || precedence < 0) {
      return { effect: false, reason: 'installed-version-behind-target' }
    }
    return { effect: true }
  }
  const precedence = compareSemver(installedVersion, currentVersion)
  if (precedence === undefined || precedence <= 0) {
    return { effect: false, reason: 'installed-version-unchanged' }
  }
  return { effect: true }
}

function releaseAgeHint({ profile, targetVersion }) {
  const target = targetVersion && parseSemver(targetVersion) !== undefined
    ? targetVersion
    : '<latest>'
  return (
    'pnpm 11 withholds releases younger than 24h via its `minimumReleaseAge` policy ' +
    '(default 1440 minutes) while still exiting 0, which looks like a successful update. ' +
    'Retry once the release has aged past the policy window, or run ' +
    `\`npx @deepseek-ai/dsh plugin --profile ${profile} add ${PACKAGE_NAME}@${target}\` ` +
    'to install the version explicitly (pnpm auto-exempts it). If the profile carries a ' +
    'version-pinned `minimumReleaseAgeExclude` entry, `npx dsh-vision-router repair` rewrites ' +
    'it to a bare name so future releases resolve again.'
  )
}

/**
 * Run the documented DSH plugin updater through the exact DSH CLI entry that
 * is already hosting this plugin. No shell is involved and no package-manager
 * command is guessed.
 *
 * When the registry-confirmed `targetVersion` is given (the settings-card
 * flow always provides one) and the profile declares this plugin with a plain
 * registry spec, the update installs that version explicitly —
 * `add <name>@<target>` — instead of `update <name>`. This is the reliable
 * path across pnpm >= 11's `minimumReleaseAge` policy, which makes plain
 * `update` silently keep the current version for releases younger than 24h.
 * Non-registry installs (git/file/link/workspace specs) keep `update`
 * semantics. Either way the installed manifest is verified afterwards: a zero
 * exit code alone is never reported as success.
 */
export async function runDshPluginUpdate(plan, {
  execFileImpl,
  timeoutMs = 180000,
  env = process.env,
  targetVersion,
  currentVersion = CURRENT_VERSION,
  dshHome = resolveDshHome(env),
} = {}) {
  if (!plan || plan.available !== true) {
    throw new Error(`automatic update unavailable (${plan?.reason || 'unknown reason'})`)
  }
  const runner = execFileImpl || promisify(execFile)
  const target = typeof targetVersion === 'string' && parseSemver(targetVersion) !== undefined
    ? targetVersion.trim()
    : undefined

  const profileSpec = readProfilePluginSpec({ dshHome, profile: plan.profile })
  const explicit = target !== undefined
    && (profileSpec === undefined || !NON_REGISTRY_SPEC_RE.test(profileSpec))
  const verb = explicit ? 'add' : 'update'
  const packageSpec = explicit ? `${PACKAGE_NAME}@${target}` : PACKAGE_NAME
  const args = [
    plan.cliEntry,
    'plugin',
    '--profile',
    plan.profile,
    verb,
    packageSpec,
  ]

  let result
  try {
    result = await runner(plan.execPath, args, {
      env,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      shell: false,
    })
  } catch (error) {
    const diagnosis = classifyProfilePnpmFailure(error, {
      profileDir: profileDirOf(dshHome, plan.profile),
      profile: plan.profile,
      packageName: PACKAGE_NAME,
    })
    if (diagnosis) {
      throw new Error(`${diagnosis.message} Original pnpm output: ${outputDetail(error)}`)
    }
    throw new Error(`DSH plugin update failed: ${outputDetail(error)}`)
  }

  const stdout = typeof result?.stdout === 'string' ? result.stdout.trim() : ''
  const stderr = typeof result?.stderr === 'string' ? result.stderr.trim() : ''

  // Exit code 0 does not prove the version moved (see above): verify the
  // manifest pnpm actually materialized under the profile.
  const installedVersion = readInstalledPluginVersion({ dshHome, profile: plan.profile })
  const verification = updateTookEffect({
    installedVersion,
    targetVersion: target,
    currentVersion,
  })
  if (!verification.effect) {
    const tail = (stdout || stderr).slice(-400)
    const output = tail ? ` Package manager output tail: ${tail}` : ''
    throw new Error(
      'update did not take effect: installed version is ' +
      `${installedVersion || 'unreadable'} (target ${target || `newer than ${currentVersion}`}).` +
      output +
      ' ' +
      releaseAgeHint({ profile: plan.profile, targetVersion: target }),
    )
  }

  return {
    ok: true,
    method: plan.method,
    profile: plan.profile,
    targetVersion: target,
    installedVersion,
    verified: true,
    stdout: stdout.slice(-2000),
    stderr: stderr.slice(-2000),
    restartRequired: true,
  }
}
