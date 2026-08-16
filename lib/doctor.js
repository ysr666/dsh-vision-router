import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const PLUGIN_NAME = 'dsh-vision-router'
const HOST_PATTERN = /^@deepseek-ai\/.+/
const WORKSPACE_FILENAME = 'pnpm-workspace.yaml'

function expandHome(value, home = homedir()) {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2))
  return value
}

export function resolveDshHome(env = process.env, home = homedir()) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return path.resolve(expandHome(configured || path.join(home, '.dsh'), home))
}

export function hasUtf8Bom(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= UTF8_BOM.length
    && buffer[0] === UTF8_BOM[0]
    && buffer[1] === UTF8_BOM[1]
    && buffer[2] === UTF8_BOM[2]
}

export function inspectProfileManifest(manifestPath, { fix = false } = {}) {
  const original = readFileSync(manifestPath)
  const bom = hasUtf8Bom(original)
  const bytes = bom ? original.subarray(UTF8_BOM.length) : original
  let repaired = false

  if (bom && fix) {
    writeFileSync(manifestPath, bytes)
    repaired = true
  }

  let manifest
  let jsonError
  try {
    manifest = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    jsonError = error instanceof Error ? error.message : String(error)
  }

  const dependencies = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    ? manifest.dependencies ?? {}
    : {}
  const bundles = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    ? manifest.dsh?.profile?.bundles ?? []
    : []

  return {
    path: manifestPath,
    hasBom: bom,
    repaired,
    validJson: jsonError === undefined,
    jsonError,
    manifest,
    pluginDependency: typeof dependencies?.['dsh-vision-router'] === 'string'
      ? dependencies['dsh-vision-router']
      : undefined,
    pluginBundle: Array.isArray(bundles) && bundles.includes('dsh-vision-router'),
  }
}

/**
 * Check a profile's pnpm-workspace.yaml for version-pinned
 * `minimumReleaseAgeExclude` entries. pnpm v11 defaults `minimumReleaseAge`
 * to 1440 minutes, so versions published less than 24h ago are not resolved
 * and `update` silently keeps the previous version. An exemption entry with a
 * pinned version (`dsh-vision-router@1.2.0`) only exempts that one version
 * and goes stale on the next release; a bare name or org pattern exempts
 * every future version. With `fix`, version-pinned entries for this plugin
 * and the `@deepseek-ai/*` host packages are rewritten to the bare name or
 * org pattern (duplicates are dropped); every other line is left untouched.
 */
export function inspectProfileWorkspace(workspacePath, { fix = false } = {}) {
  if (!existsSync(workspacePath)) {
    return { path: workspacePath, exists: false, pinned: [], rewritten: false }
  }
  const original = readFileSync(workspacePath, 'utf8')
  const lines = original.split('\n')
  const items = []
  let blockIndent = -1
  let inBlock = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const keyMatch = /^(\s*)minimumReleaseAgeExclude\s*:\s*$/.exec(line)
    if (keyMatch) {
      blockIndent = keyMatch[1].length
      inBlock = true
      continue
    }
    if (!inBlock) continue
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
    if (/^(\s*)/.exec(line)[1].length <= blockIndent) {
      inBlock = false
      continue
    }
    const itemMatch = /^(\s*)-\s+(.+?)\s*$/.exec(line)
    if (!itemMatch) continue
    const raw = itemMatch[2].replace(/\s+#.*$/, '')
    const value = raw.replace(/^(['"])(.*)\1$/, '$2').trim()
    const spec = /^(@?[^@\s]+)(?:@(.+))?$/.exec(value)
    items.push({
      line: index,
      indent: itemMatch[1],
      raw,
      name: spec?.[1],
      version: spec?.[2],
    })
  }

  const targetFor = (name) => {
    if (name === PLUGIN_NAME) return PLUGIN_NAME
    if (HOST_PATTERN.test(name)) return '@deepseek-ai/*'
    return undefined
  }
  const pinned = items.filter((item) =>
    item.version !== undefined && targetFor(item.name) !== undefined)
  const existingTargets = new Set(items
    .filter((item) => item.version === undefined)
    .map((item) => targetFor(item.name))
    .filter((target) => target !== undefined))

  let rewritten = false
  if (fix && pinned.length > 0) {
    const claimed = new Set(existingTargets)
    const removals = new Set()
    for (const item of pinned) {
      const target = targetFor(item.name)
      if (claimed.has(target)) {
        removals.add(item.line)
      } else {
        claimed.add(target)
        const quote = /^(['"])/.test(item.raw) ? item.raw[0] : ''
        lines[item.line] = `${item.indent}- ${quote}${target}${quote}`
      }
    }
    if (removals.size > 0 || claimed.size > existingTargets.size) {
      writeFileSync(workspacePath, lines
        .filter((_, index) => !removals.has(index))
        .join('\n'))
      rewritten = true
    }
  }

  return {
    path: workspacePath,
    exists: true,
    pinned: pinned.map((item) => item.name && item.version !== undefined
      ? `${item.name}@${item.version}`
      : String(item.raw)).filter((value) => value !== undefined),
    rewritten,
  }
}

export function listProfileNames(dshHome, requestedProfile) {
  if (requestedProfile) return [requestedProfile]
  const profilesDir = path.join(dshHome, 'profiles')
  if (!existsSync(profilesDir)) return []
  return readdirSync(profilesDir)
    .filter((name) => name !== 'node_modules')
    .filter((name) => {
      const full = path.join(profilesDir, name)
      try {
        return statSync(full).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
}

export function doctorProfiles({
  dshHome = resolveDshHome(),
  profile,
  fix = false,
} = {}) {
  const names = listProfileNames(dshHome, profile)
  const profiles = []

  for (const name of names) {
    const manifestPath = path.join(dshHome, 'profiles', name, 'package.json')
    const workspacePath = path.join(dshHome, 'profiles', name, WORKSPACE_FILENAME)
    if (!existsSync(manifestPath)) {
      profiles.push({
        name,
        path: manifestPath,
        exists: false,
        validJson: false,
        jsonError: 'profile package.json does not exist',
      })
      continue
    }
    profiles.push({
      name,
      exists: true,
      ...inspectProfileManifest(manifestPath, { fix }),
      workspace: inspectProfileWorkspace(workspacePath, { fix }),
    })
  }

  return {
    dshHome,
    requestedProfile: profile,
    fix,
    profiles,
    ok: profiles.length > 0 && profiles.every((item) =>
      item.exists && item.validJson && (!item.hasBom || item.repaired)
      && (!item.workspace || item.workspace.pinned.length === 0 || item.workspace.rewritten)),
  }
}
