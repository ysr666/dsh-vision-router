import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const packageJson = require('../package.json')

export const PACKAGE_NAME = 'dsh-vision-router'
export const CURRENT_VERSION = String(packageJson.version ?? '')
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org'
export const RELEASES_URL = 'https://github.com/ysr666/dsh-vision-router/releases/latest'

function parseIdentifier(value) {
  return /^\d+$/.test(value) ? { numeric: true, value: Number(value) } : { numeric: false, value }
}

/** Parse the SemVer subset npm package versions use. Build metadata is ignored. */
export function parseSemver(value) {
  const match = String(value ?? '')
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.').map(parseIdentifier) : [],
  }
}

/** Return -1 / 0 / 1 using SemVer precedence rules. */
export function compareSemver(left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) return undefined
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < length; i++) {
    const ai = a.prerelease[i]
    const bi = b.prerelease[i]
    if (ai === undefined) return -1
    if (bi === undefined) return 1
    if (ai.numeric && bi.numeric) {
      if (ai.value !== bi.value) return ai.value < bi.value ? -1 : 1
      continue
    }
    if (ai.numeric !== bi.numeric) return ai.numeric ? -1 : 1
    if (ai.value !== bi.value) return ai.value < bi.value ? -1 : 1
  }
  return 0
}

export function normalizeRegistryBase(value) {
  const fallback = DEFAULT_NPM_REGISTRY
  try {
    const url = new URL(String(value ?? '').trim() || fallback)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback
    url.search = ''
    url.hash = ''
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString().replace(/\/$/, '')
  } catch {
    return fallback
  }
}

/** Respect a user's npm registry when the DSH process inherited one; otherwise use npmjs. */
export function registryBaseFromEnv(env = process.env) {
  return normalizeRegistryBase(
    env?.npm_config_registry ?? env?.NPM_CONFIG_REGISTRY ?? DEFAULT_NPM_REGISTRY,
  )
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error)
}

async function fetchLatestVersion({ fetchImpl, registryBase, signal, timeoutMs }) {
  const endpoint = `${registryBase}/${encodeURIComponent(PACKAGE_NAME)}/latest`
  // Give every registry attempt its own timeout. In particular, a slow mirror
  // must not consume the signal used by the npmjs fallback attempt.
  const requestSignal = signal ?? AbortSignal.timeout(timeoutMs)
  const response = await fetchImpl(endpoint, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: requestSignal,
  })
  if (!response.ok) throw new Error(`update registry returned HTTP ${response.status}`)
  const body = await response.json().catch(() => undefined)
  const latestVersion = body && typeof body.version === 'string' ? body.version.trim() : ''
  if (!parseSemver(latestVersion)) throw new Error('update registry returned an invalid version')
  return latestVersion
}

/**
 * Check only; never installs or mutates anything. This deliberately stays
 * independent of whether DSH/plugin was installed via npx, a global CLI,
 * pnpm source checkout, bun, or another wrapper.
 *
 * A pnpm/npm-launched process may inherit npm_config_registry. We respect that
 * registry first, but mirrors and local registries can be unavailable even
 * while the public npm registry is reachable. In that case we retry the same
 * read-only metadata request against npmjs instead of showing a false failure.
 */
export async function checkPackageUpdate({
  fetchImpl = globalThis.fetch,
  currentVersion = CURRENT_VERSION,
  registry = registryBaseFromEnv(),
  fallbackRegistry = DEFAULT_NPM_REGISTRY,
  signal,
  timeoutMs = 10_000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')
  const primaryRegistry = normalizeRegistryBase(registry)
  const fallbackBase = normalizeRegistryBase(fallbackRegistry)
  const registries = [primaryRegistry]
  if (fallbackBase !== primaryRegistry) registries.push(fallbackBase)

  const failures = []
  for (const registryBase of registries) {
    if (signal?.aborted) throw signal.reason ?? new Error('update check aborted')
    try {
      const latestVersion = await fetchLatestVersion({
        fetchImpl,
        registryBase,
        signal,
        timeoutMs,
      })
      const precedence = compareSemver(currentVersion, latestVersion)
      return {
        ok: true,
        packageName: PACKAGE_NAME,
        currentVersion,
        latestVersion,
        updateAvailable: precedence === -1,
        aheadOfRegistry: precedence === 1,
        checkedAt: Date.now(),
        registry: registryBase,
        registryFallbackFrom: registryBase !== primaryRegistry ? primaryRegistry : undefined,
        releasesUrl: RELEASES_URL,
        packageSpec: `${PACKAGE_NAME}@latest`,
        // Important: intentionally no guessed install/update command here.
        // The caller should tell users to update through the same DSH installation
        // path they originally used.
        installMethodAgnostic: true,
      }
    } catch (error) {
      // A caller-provided abort means "stop", not "try another network".
      if (signal?.aborted) throw error
      failures.push({ registry: registryBase, error: errorMessage(error) })
    }
  }

  throw new Error(
    'update check failed: ' +
      failures.map((item) => `${item.registry} (${item.error})`).join(' -> '),
  )
}

/**
 * One process-local cache: startup checks run once per DSH launch, opening the
 * settings card reuses that result, and the manual button can force a refresh.
 */
export function createCachedUpdateChecker({
  fetchImpl = (...args) => globalThis.fetch(...args),
  currentVersion = CURRENT_VERSION,
  registry = registryBaseFromEnv(),
  fallbackRegistry = DEFAULT_NPM_REGISTRY,
  successTtlMs = 6 * 60 * 60 * 1000,
  failureTtlMs = 5 * 60 * 1000,
  timeoutMs = 10_000,
} = {}) {
  let cached
  let inFlight

  const check = (force = false) => {
    const now = Date.now()
    const ttl = cached && cached.ok === true ? successTtlMs : failureTtlMs
    if (!force && cached && now - cached.checkedAt < ttl) return Promise.resolve(cached)
    // Even a force request joins the currently active request. The settings
    // button is disabled while checking, and this prevents startup/card-open
    // overlap from creating duplicate registry traffic or stale cache races.
    if (inFlight) return inFlight

    const task = checkPackageUpdate({
      fetchImpl,
      currentVersion,
      registry,
      fallbackRegistry,
      timeoutMs,
    }).catch((error) => ({
      ok: false,
      currentVersion,
      checkedAt: Date.now(),
      registry: normalizeRegistryBase(registry),
      releasesUrl: RELEASES_URL,
      packageSpec: `${PACKAGE_NAME}@latest`,
      installMethodAgnostic: true,
      error: errorMessage(error),
    }))

    const pending = task.then((result) => {
      cached = result
      return result
    })
    inFlight = pending
    void pending.finally(() => {
      if (inFlight === pending) inFlight = undefined
    })
    return pending
  }

  return {
    check,
    peek() {
      return cached
    },
  }
}
