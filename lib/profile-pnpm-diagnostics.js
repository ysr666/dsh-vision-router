import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const VISION_ROUTER_PACKAGE = 'dsh-vision-router'

const KNOWN_VISION_PACKAGES = new Set([
  'dsh-vision-proxy',
  'dsh-vision-sidecar',
  'dsh-vision-provider',
])

function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function dependencyMap(profileDir) {
  const manifest = readJson(path.join(profileDir, 'package.json'))
  const dependencies = manifest?.dependencies
  return dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)
    ? dependencies
    : {}
}

function looksLikeOtherVisionPackage(name) {
  if (name === VISION_ROUTER_PACKAGE) return false
  return KNOWN_VISION_PACKAGES.has(name) || /^dsh-vision-(?!router(?:$|-))/.test(name)
}

function installedVersion(profileDir, packageName) {
  const manifest = readJson(path.join(profileDir, 'node_modules', packageName, 'package.json'))
  return typeof manifest?.version === 'string' && manifest.version.trim() !== ''
    ? manifest.version.trim()
    : undefined
}

/**
 * Return advisory-only metadata for other vision plugins declared in the same
 * DSH profile. Coexistence is not treated as a conflict by itself: these rows
 * exist so doctor can explain a profile-level pnpm failure when the log names
 * one of the already-installed plugins instead of Vision Router.
 */
export function inspectCoexistingVisionPlugins(profileDir) {
  const dependencies = dependencyMap(profileDir)
  return Object.entries(dependencies)
    .filter(([name]) => looksLikeOtherVisionPackage(name))
    .map(([name, spec]) => ({
      name,
      spec: typeof spec === 'string' ? spec : undefined,
      installedVersion: installedVersion(profileDir, name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function errorText(error) {
  return [error?.stderr, error?.stdout, error?.message]
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .join('\n')
}

function packageNameFromVersionedSpec(spec) {
  if (typeof spec !== 'string') return undefined
  const value = spec.trim().replace(/[),;]+$/, '')
  if (value.startsWith('@')) {
    const slash = value.indexOf('/')
    const marker = value.lastIndexOf('@')
    return slash > 0 && marker > slash ? value.slice(0, marker) : value
  }
  const marker = value.lastIndexOf('@')
  return marker > 0 ? value.slice(0, marker) : value
}

function ignoredBuildSpecs(text) {
  const found = []
  const linePattern = /Ignored build scripts:\s*([^\r\n]+)/gi
  for (const match of text.matchAll(linePattern)) {
    const line = match[1]
    const specs = line.match(/(?:@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)@[^\s,]+/g) ?? []
    for (const spec of specs) {
      if (!found.includes(spec)) found.push(spec)
    }
  }
  return found
}

function blockerLabel(blocker) {
  if (blocker.versionedSpec) return blocker.versionedSpec
  if (blocker.installedVersion) return `${blocker.name}@${blocker.installedVersion}`
  return blocker.name
}

/**
 * Classify pnpm failures that were caused by another dependency already
 * present in the DSH profile. `dsh plugin add/update` runs pnpm at the profile
 * root, so an existing package's blocked build or optional dependency can
 * abort a Vision Router update even though Vision Router itself is healthy.
 */
export function classifyProfilePnpmFailure(error, {
  profileDir,
  profile = 'web',
  packageName = VISION_ROUTER_PACKAGE,
} = {}) {
  const text = errorText(error)
  if (!text) return undefined

  const ignored = ignoredBuildSpecs(text)
  const dependencies = profileDir ? dependencyMap(profileDir) : {}
  const blockers = new Map()

  for (const versionedSpec of ignored) {
    const name = packageNameFromVersionedSpec(versionedSpec)
    if (!name || name === packageName) continue
    blockers.set(name, {
      name,
      versionedSpec,
      installedVersion: profileDir ? installedVersion(profileDir, name) : undefined,
      source: 'ignored-build',
    })
  }

  for (const name of Object.keys(dependencies)) {
    if (name === packageName || blockers.has(name) || !text.includes(name)) continue
    blockers.set(name, {
      name,
      installedVersion: profileDir ? installedVersion(profileDir, name) : undefined,
      source: 'profile-log-mention',
    })
  }

  if (blockers.size === 0) return undefined

  const list = [...blockers.values()]
  const labels = list.map(blockerLabel)
  const primary = list[0]
  const buildApproval = /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts:/i.test(text)
  const sharpArtifacts = /@img\/sharp-|sharp(?:@|-)/i.test(text)
  const destroyedRequest = /UND_ERR_DESTROYED/i.test(text)

  let message =
    `DSH plugin update was blocked by another dependency already present in profile "${profile}": ` +
    `${labels.join(', ')}. DSH runs pnpm for the whole profile, so this is a profile-level ` +
    `dependency/build failure, not evidence that ${packageName} itself failed.`

  if (buildApproval) {
    message += ' pnpm also reported an ignored build script; the profile-level build-approval policy may need repair.'
  }
  if (primary?.name) {
    message +=
      ` If it is safe to remove the blocker, try \`npx @deepseek-ai/dsh plugin --profile ${profile} remove ${primary.name}\` ` +
      `and then retry the Vision Router update. If remove fails with the same profile-level pnpm error, repair the ` +
      `profile manifest/lockfile instead of repeatedly retrying add/update.`
  }

  return {
    kind: 'existing-profile-dependency',
    blockers: list,
    buildApproval,
    sharpArtifacts,
    destroyedRequest,
    message,
  }
}
