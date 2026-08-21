import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os, { homedir } from 'node:os'
import path from 'node:path'
import { CURRENT_VERSION } from './update-check.js'

export const DEFAULT_RUNTIME_URL = 'http://127.0.0.1:3080'
const SAFE_RUNTIME_ROUTES = [
  { route: '/_dsh/vision-router/logs', allow: ['GET', 'POST'] },
  { route: '/_dsh/vision-router/model-capabilities', allow: ['GET'] },
  { route: '/_dsh/vision-router/update-check', allow: ['GET'] },
  { route: '/_dsh/vision-router/test-connection', allow: ['GET'] },
  { route: '/_dsh/vision-router/settings-save-diagnostics', allow: ['POST'] },
  { route: '/_dsh/vision-router/self-update', allow: ['POST'] },
]

function timeoutSignal(ms) {
  return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined
}

function normalizeAllow(value) {
  return String(value ?? '')
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean)
    .sort()
}

function safeRuntimeBase(value) {
  let url
  try {
    url = new URL(String(value ?? ''))
  } catch {
    throw new TypeError('runtime URL must be a valid absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('runtime URL must use http or https')
  }
  if (url.username || url.password) {
    // Credentials in the probe target are never needed and are too easy to leak
    // through support reports or fetch diagnostics.
    throw new TypeError('runtime URL must not contain credentials')
  }
  url.hash = ''
  return url
}

export async function probeRuntime({
  baseUrl = DEFAULT_RUNTIME_URL,
  requestedProfile,
  dshHome,
  applicableProfiles = [],
  timeoutMs = 800,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('runtime probe requires fetch')
  const base = safeRuntimeBase(baseUrl)
  const routes = await Promise.all(SAFE_RUNTIME_ROUTES.map(async ({ route, allow: expectedAllow }) => {
    const url = new URL(route, base).href
    try {
      // DELETE is unsupported by every plugin-owned route and each handler
      // rejects it before any read/mutation behavior. Exact 405 + Allow proves
      // the route exists while keeping this probe side-effect-free.
      const response = await fetchImpl(url, {
        method: 'DELETE',
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: timeoutSignal(timeoutMs),
      })
      const expected = [...expectedAllow].sort()
      const actual = normalizeAllow(response.headers?.get?.('allow'))
      const registered = response.status === 405
        && actual.length === expected.length
        && actual.every((value, index) => value === expected[index])
      return {
        route,
        status: response.status,
        registered,
        ok: registered,
        expectedAllow: expected.join(', '),
        allow: actual.join(', '),
      }
    } catch (error) {
      return {
        route,
        ok: false,
        registered: false,
        unreachable: true,
        errorCode: error instanceof Error ? error.name : 'Error',
      }
    }
  }))

  const reachable = routes.some((item) => !item.unreachable)
  const routeOk = !reachable || routes.every((item) => item.ok)
  let ownership = { verified: false, requestedProfile, reason: requestedProfile ? 'profile-unknown' : 'not-requested' }

  // A DELETE contract proves route registration but not which DSH profile owns
  // the process. Reuse the existing GET-only log metadata route as a read-only
  // home identity proof. It never opens the log folder (that is POST only).
  // Only a unique applicable profile in that same DSH_HOME may be attributed.
  if (reachable && routeOk && requestedProfile && typeof dshHome === 'string') {
    try {
      const response = await fetchImpl(new URL('/_dsh/vision-router/logs', base).href, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: timeoutSignal(timeoutMs),
      })
      if (response.status === 200) {
        const text = typeof response.text === 'function' ? await response.text() : ''
        if (Buffer.byteLength(text) <= 16 * 1024) {
          const body = text ? JSON.parse(text) : undefined
          const expectedDirectory = path.resolve(dshHome, 'logs', 'vision-router')
          const actualDirectory = typeof body?.directory === 'string' ? path.resolve(body.directory) : undefined
          const candidates = [...new Set(applicableProfiles.filter((name) => typeof name === 'string'))]
          if (body?.local === true && actualDirectory === expectedDirectory && candidates.length === 1 && candidates[0] === requestedProfile) {
            ownership = { requestedProfile, verified: true, profile: requestedProfile, source: 'log-home+unique-profile' }
          } else if (body?.local === true && actualDirectory === expectedDirectory) {
            ownership = { requestedProfile, verified: false, reason: 'profile-ambiguous', candidateProfiles: candidates }
          }
        }
      }
    } catch {
      // Ownership is advisory/fail-closed; route health above remains available.
    }
  }

  return {
    baseUrl: base.href,
    reachable,
    routes,
    ownership,
    routeOk,
    ok: !reachable || (routeOk && (!requestedProfile || ownership.verified)),
  }
}

function commandVersion(command, args = ['--version']) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 2_000, windowsHide: true })
    if (result.error) return undefined
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
    if (result.status !== 0 && output === '') return undefined
    return { command, status: result.status, version: output.split(/\r?\n/)[0]?.trim() || undefined }
  } catch {
    return undefined
  }
}

function firstCommand(candidates) {
  for (const [command, args] of candidates) {
    const result = commandVersion(command, args)
    if (result) return result
  }
  return undefined
}

function resolvePackageVersion(profileDir, packageName) {
  const file = path.join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json')
  if (!existsSync(file)) return undefined
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof value?.version === 'string') return { version: value.version, file }
  } catch { /* advisory only */ }
  return undefined
}

function existingExecutableCandidates(candidates) {
  return candidates.filter(([command]) => !path.isAbsolute(command) || existsSync(command))
}

function tesseractCandidates(env = process.env) {
  const candidates = [['tesseract', ['--version']]]
  if (process.platform === 'win32') {
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      candidates.push([path.join(root, 'Tesseract-OCR', 'tesseract.exe'), ['--version']])
    }
  }
  return existingExecutableCandidates(candidates)
}

function chromiumCandidates(env = process.env) {
  if (process.platform === 'win32') {
    const candidates = [
      ['msedge.exe', ['--version']],
      ['chrome.exe', ['--version']],
      ['chromium.exe', ['--version']],
    ]
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(
        [path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), ['--version']],
        [path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), ['--version']],
        [path.join(root, 'Chromium', 'Application', 'chrome.exe'), ['--version']],
      )
    }
    return existingExecutableCandidates(candidates)
  }
  if (process.platform === 'darwin') {
    return existingExecutableCandidates([
      ['google-chrome', ['--version']],
      ['chromium', ['--version']],
      ['microsoft-edge', ['--version']],
      ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--version']],
      ['/Applications/Chromium.app/Contents/MacOS/Chromium', ['--version']],
      ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', ['--version']],
    ])
  }
  return [
    ['google-chrome', ['--version']],
    ['chromium', ['--version']],
    ['chromium-browser', ['--version']],
    ['microsoft-edge', ['--version']],
  ]
}

const HOST_PACKAGES = [
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-attachment-local',
  '@deepseek-ai/dsh-llm-deepseek',
]

function supportedNodeVersion(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number)
  return (major === 22 && minor >= 19) || major >= 24
}

export function inspectPlatform({ profileDirs = [], env = process.env } = {}) {
  const tesseract = firstCommand(tesseractCandidates(env))
  const chromium = firstCommand(chromiumCandidates(env))
  const sharp = profileDirs.map((profileDir) => ({ profileDir, package: resolvePackageVersion(profileDir, 'sharp') }))
  const hostPackages = profileDirs.map((profileDir) => ({
    profileDir,
    packages: Object.fromEntries(HOST_PACKAGES.map((name) => [name, resolvePackageVersion(profileDir, name)?.version])),
  }))
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    nodeSupported: supportedNodeVersion(),
    nodeRequirement: '^22.19.0 || >=24.0.0',
    release: os.release(),
    tesseract: tesseract ?? { available: false },
    chromium: chromium ?? { available: false },
    sharp,
    hostPackages,
  }
}

export function redactPath(value, home = homedir()) {
  if (typeof value !== 'string') return value
  const normalizedHome = path.resolve(home)
  const normalized = path.resolve(value)
  return normalized === normalizedHome
    ? '~'
    : normalized.startsWith(`${normalizedHome}${path.sep}`)
      ? `~${path.sep}${path.relative(normalizedHome, normalized)}`
      : '<external-path>'
}

function redactUrl(value) {
  if (typeof value !== 'string') return value
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return `${url.origin}${url.pathname}`.replace(/\/$/, '')
  } catch {
    return '<invalid-url>'
  }
}

function safeCommand(result) {
  if (!result || typeof result !== 'object') return result
  return {
    status: result.status,
    version: result.version,
    ...(typeof result.command === 'string' ? { command: path.isAbsolute(result.command) ? redactPath(result.command) : result.command } : {}),
  }
}

function safeInstallation(value) {
  if (!value || typeof value !== 'object') return value
  return {
    applicable: value.applicable,
    mode: value.mode,
    ok: value.ok,
    errors: Array.isArray(value.errors) ? value.errors.map(() => 'diagnostic') : [],
    warnings: Array.isArray(value.warnings) ? value.warnings.map(() => 'diagnostic') : [],
    declaredSpecKind: value.declaredSpecKind,
    installedVersion: value.installedVersion,
  }
}

function safeRuntime(runtime) {
  if (!runtime) return undefined
  return {
    baseUrl: redactUrl(runtime.baseUrl),
    reachable: runtime.reachable,
    ok: runtime.ok,
    routeOk: runtime.routeOk,
    ownership: runtime.ownership ? {
      requestedProfile: runtime.ownership.requestedProfile,
      verified: runtime.ownership.verified,
      profile: runtime.ownership.profile,
      version: runtime.ownership.version,
      reason: runtime.ownership.reason,
    } : undefined,
    routes: (runtime.routes ?? []).map((item) => ({
      route: item.route,
      status: item.status,
      registered: item.registered,
      unreachable: item.unreachable,
      errorCode: item.errorCode,
      expectedAllow: item.expectedAllow,
      allow: item.allow,
    })),
  }
}

export function supportReport({ profileReport, runtime, platform, sessions }) {
  const safeProfiles = profileReport.profiles.map((item) => ({
    name: item.name,
    exists: item.exists,
    validJson: item.validJson,
    hasBom: item.hasBom,
    dependencyDeclared: Boolean(item.pluginDependency),
    dependencySpecKind: item.installation?.declaredSpecKind,
    pluginBundle: item.pluginBundle,
    installedVersion: item.installedPlugin?.version,
    installation: safeInstallation(item.installation),
    workspacePinnedCount: item.workspace?.pinned?.length ?? 0,
    patch: item.patch ? {
      visionRouterRows: item.patch.visionRouterRows,
      manualVisionRouter: item.patch.manualVisionRouter,
      disablesOfficialDeepSeek: item.patch.disablesOfficialDeepSeek,
    } : undefined,
  }))
  return {
    schemaVersion: 1,
    doctorVersion: CURRENT_VERSION,
    generatedAt: new Date().toISOString(),
    ok: profileReport.ok && (runtime?.ok ?? true) && (sessions?.ok ?? true),
    dshHome: redactPath(profileReport.dshHome),
    profiles: safeProfiles,
    log: {
      exists: profileReport.log?.exists,
      currentSettingsFailureCount: profileReport.log?.settingsSaveFailures?.length ?? 0,
      historicalSettingsFailureCount: profileReport.log?.historicalSettingsSaveFailures?.length ?? 0,
      recentErrorCount: profileReport.log?.recentErrors?.length ?? 0,
      startupScoped: profileReport.log?.startupScoped,
      startupVersion: profileReport.log?.startupVersion,
    },
    runtime: safeRuntime(runtime),
    sessions: sessions ? {
      scanned: sessions.scanned,
      affected: sessions.affected,
      repaired: sessions.repaired,
      errorCount: sessions.errors?.length ?? 0,
      advisoryCount: sessions.advisories?.length ?? 0,
      repairs: sessions.reports?.flatMap((item) => (item.repairs ?? []).map((repair) => ({ kind: repair.kind }))) ?? [],
    } : undefined,
    platform: {
      platform: platform.platform,
      arch: platform.arch,
      node: platform.node,
      nodeSupported: platform.nodeSupported,
      nodeRequirement: platform.nodeRequirement,
      release: platform.release,
      tesseract: safeCommand(platform.tesseract),
      chromium: safeCommand(platform.chromium),
      sharp: platform.sharp.map((entry) => ({
        profile: safeProfiles.find((profile) => entry.profileDir?.endsWith(path.sep + profile.name))?.name,
        version: entry.package?.version,
      })),
      hostPackages: (platform.hostPackages ?? []).map((entry) => ({
        profile: safeProfiles.find((profile) => entry.profileDir?.endsWith(path.sep + profile.name))?.name,
        packages: entry.packages,
      })),
    },
  }
}
