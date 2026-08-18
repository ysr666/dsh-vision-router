import { readFileSync } from 'node:fs'
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
  return KNOWN_VISION_PACKAGES.has(name) || /^dsh-vision-(?!router(?:[A-Za-z0-9._-]*))/.test(name)
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
    // pnpm lists entries comma-separated, bare (esbuild) or versioned
    // (sharp@0.33.5), and may append guidance after the last entry
    // ("...core-js. Run \"pnpm approve-builds\"..."). Take the leading token of
    // each comma chunk so both bare and versioned names are captured.
    for (const chunk of line.split(',')) {
      const token = (chunk.trim().split(/\s+/)[0] ?? '').replace(/[.),;]+$/, '')
      if (token === '' || !/^@?[A-Za-z0-9._@/-]+$/.test(token)) continue
      const name = packageNameFromVersionedSpec(token)
      if (name && !found.includes(token)) found.push(token)
    }
  }
  return found
}

function dependencyAppearsInFailureContext(text, packageName) {
  // Word-boundary match on the package name: `dsh-vision-proxy` must not
  // match `dsh-vision-proxy-core`, `sharp` must not match `@img/sharp-*`, and
  // a package name inside a registry URL must not count. Scoped names treat
  // @, /, - and . as name characters.
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const namePattern = new RegExp(`(?:^|[^\\w@./-])${escaped}(?:$|[^\\w./-])`, 'i')
  const failurePattern =
    /ERR_PNPM_|postinstall.*(?:failed|error)|preinstall.*(?:failed|error)|prepare.*(?:failed|error)|(?:build|install) script.*(?:failed|error)|ELIFECYCLE|command failed|failed to build|failed to run/i
  return text
    .split(/\r?\n/)
    .some((line) => namePattern.test(line) && failurePattern.test(line))
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
  const unattributable = []

  for (const versionedSpec of ignored) {
    const name = packageNameFromVersionedSpec(versionedSpec)
    if (!name || name === packageName) continue
    // Only blame an ignored build when the package is a plugin already
    // declared in this profile (or a known coexisting vision package).
    // Vision Router's own transitive dependencies (sharp and its platform
    // binaries) are not removable blockers: their ignored build is a profile
    // build-approval policy issue, and suggesting `remove` for them is wrong.
    const declared = Object.prototype.hasOwnProperty.call(dependencies, name)
    if (!declared && !looksLikeOtherVisionPackage(name)) {
      if (!unattributable.includes(versionedSpec)) unattributable.push(versionedSpec)
      continue
    }
    blockers.set(name, {
      name,
      versionedSpec,
      installedVersion: profileDir ? installedVersion(profileDir, name) : undefined,
      source: 'ignored-build',
    })
  }

  // A package name appearing in ordinary pnpm progress output is not enough
  // to blame it. Only use a declared dependency when the same log line carries
  // clear failure/build context; ignored-build diagnostics above remain the
  // strongest signal and do not need this heuristic.
  for (const name of Object.keys(dependencies)) {
    if (
      name === packageName
      || blockers.has(name)
      || !dependencyAppearsInFailureContext(text, name)
    ) continue
    blockers.set(name, {
      name,
      installedVersion: profileDir ? installedVersion(profileDir, name) : undefined,
      source: 'profile-failure-line',
    })
  }

  const buildApproval = /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts:/i.test(text)
  const sharpArtifacts = /@img\/sharp-|sharp(?:@|-)/i.test(text)
  const destroyedRequest = /UND_ERR_DESTROYED/i.test(text)

  if (blockers.size === 0 && unattributable.length === 0) return undefined

  if (blockers.size === 0) {
    // pnpm ignored build scripts for packages that are not declared profile
    // plugins — almost always this plugin's own transitive dependencies. Do
    // not frame them as removable blockers; point at the approval policy.
    let message =
      `pnpm ignored build scripts for ${unattributable.join(', ')} while updating ${packageName} in profile "${profile}". ` +
      `These are not other plugins, so removing them is not the fix: the profile-level build-approval policy is. ` +
      `Run \`pnpm approve-builds\` in the profile (or list them under the profile's onlyBuiltDependencies) and retry the update.`
    if (sharpArtifacts) {
      message +=
        ` The ignored list includes sharp, which ${packageName} itself needs at runtime; ` +
        `approve its build instead of removing it.`
    }
    return {
      kind: 'ignored-build-policy',
      blockers: [],
      buildApproval,
      sharpArtifacts,
      destroyedRequest,
      message,
    }
  }

  const list = [...blockers.values()]
  const labels = list.map(blockerLabel)
  const primary = list[0]

  let message =
    `DSH plugin update was blocked by another dependency already present in profile "${profile}": ` +
    `${labels.join(', ')}. DSH runs pnpm for the whole profile, so this is a profile-level ` +
    `dependency/build failure, not evidence that ${packageName} itself failed.`

  if (buildApproval) {
    message += ' pnpm also reported an ignored build script; the profile-level build-approval policy may need repair.'
  }
  if (sharpArtifacts) {
    message +=
      ` The ignored list includes sharp, which ${packageName} itself needs at runtime; ` +
      `approve its build instead of removing it.`
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
