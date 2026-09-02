import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { inspectCoexistingVisionPlugins } from './profile-pnpm-diagnostics.js'
import { compareSemver, parseSemver } from './update-check.js'

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const PLUGIN_NAME = 'dsh-vision-router'
const HOST_PATTERN = /^@deepseek-ai\/.+/
const WORKSPACE_FILENAME = 'pnpm-workspace.yaml'
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'
const LOG_RELATIVE_PATH = path.join('logs', 'vision-router', 'vision-router.log')
const LOG_BACKUP_RELATIVE_PATH = path.join('logs', 'vision-router', 'vision-router.1.log')
const PROFILE_INPUT_MAX_BYTES = 1024 * 1024
const INSTALLED_MANIFEST_MAX_BYTES = 256 * 1024
const LOG_LINE_LIMIT = 800
const STARTUP_MARKER = 'vision-router: diagnostics log enabled at '

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

function readFileBounded(filePath, maxBytes = PROFILE_INPUT_MAX_BYTES) {
  const stat = statSync(filePath)
  if (stat.size > maxBytes) {
    const error = new Error(`file exceeds the ${maxBytes}-byte doctor safety limit`)
    error.code = 'DOCTOR_INPUT_TOO_LARGE'
    throw error
  }
  return readFileSync(filePath)
}

function readJsonIfPresent(filePath, maxBytes = INSTALLED_MANIFEST_MAX_BYTES) {
  if (!existsSync(filePath)) return undefined
  try {
    const value = JSON.parse(readFileBounded(filePath, maxBytes).toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

function dependencySpecKind(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const spec = value.trim()
  if (/^(?:file|link):/i.test(spec) || /^[./\\]/.test(spec)) return 'local-path'
  if (/^(?:https?|git(?:\+https?)?|ssh):/i.test(spec) || spec.startsWith('git@')) return 'remote-vcs'
  if (/^(?:github|gitlab|bitbucket):/i.test(spec)) return 'hosted-vcs'
  if (/^(?:workspace:|npm:)/i.test(spec)) return 'npm-alias'
  return 'registry'
}

function compareParsed(a, b) {
  return compareSemver(`${a.major}.${a.minor}.${a.patch}${a.prerelease?.length ? '-' + a.prerelease.map((x) => x.value).join('.') : ''}`,
    `${b.major}.${b.minor}.${b.patch}${b.prerelease?.length ? '-' + b.prerelease.map((x) => x.value).join('.') : ''}`)
}

function versionCore(value) {
  const parsed = parseSemver(value)
  return parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : undefined
}

function comparatorSatisfied(version, token) {
  const parsedVersion = parseSemver(version)
  if (!parsedVersion) return undefined
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?|\*|x|X)$/.exec(token)
  if (!match) return undefined
  const op = match[1] || '='
  const raw = match[2]
  if (/^(?:\*|x)$/i.test(raw)) return true
  const numericParts = raw.replace(/^v/i, '').split('-')[0].split('.')
  const normalized = numericParts.length === 1 ? `${numericParts[0]}.0.0`
    : numericParts.length === 2 ? `${numericParts[0]}.${numericParts[1]}.0`
      : raw.replace(/^v/i, '')
  const target = parseSemver(normalized)
  if (!target) return undefined
  const cmp = compareParsed(parsedVersion, target)
  if (cmp === undefined) return undefined
  if (op === '^') {
    const upper = target.major > 0
      ? { ...target, major: target.major + 1, minor: 0, patch: 0, prerelease: [] }
      : target.minor > 0
        ? { ...target, minor: target.minor + 1, patch: 0, prerelease: [] }
        : { ...target, patch: target.patch + 1, prerelease: [] }
    return cmp >= 0 && compareParsed(parsedVersion, upper) < 0
  }
  if (op === '~') {
    const upper = { ...target, minor: target.minor + 1, patch: 0, prerelease: [] }
    return cmp >= 0 && compareParsed(parsedVersion, upper) < 0
  }
  if (op === '>=') return cmp >= 0
  if (op === '<=') return cmp <= 0
  if (op === '>') return cmp > 0
  if (op === '<') return cmp < 0
  return cmp === 0
}

export function registrySpecSatisfiesVersion(spec, version) {
  if (dependencySpecKind(spec) !== 'registry' || !parseSemver(version)) return undefined
  const text = String(spec).trim()
  if (/^(?:latest|next|beta|alpha|canary)$/i.test(text)) return undefined
  const parsedVersion = parseSemver(version)
  const alternatives = text.split('||').map((part) => part.trim()).filter(Boolean)
  if (alternatives.length === 0) return undefined
  let understood = false
  const result = alternatives.some((alternative) => {
    // Wildcard forms such as 1.7.x and 1.x.
    const wildcard = /^(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/.exec(alternative)
    if (wildcard && [wildcard[2], wildcard[3]].some((v) => /^(?:x|X|\*)$/.test(v || ''))) {
      understood = true
      if (parsedVersion.prerelease.length > 0) return false
      if (parsedVersion.major !== Number(wildcard[1])) return false
      if (wildcard[2] && !/^(?:x|X|\*)$/.test(wildcard[2]) && parsedVersion.minor !== Number(wildcard[2])) return false
      return true
    }
    const tokens = alternative.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return false
    const outcomes = tokens.map((token) => comparatorSatisfied(version, token))
    if (outcomes.some((value) => value === undefined)) return false
    understood = true
    // npm does not admit a prerelease into a stable-only range unless the
    // range itself names a prerelease for the same core tuple.
    if (parsedVersion.prerelease.length > 0) {
      const core = versionCore(version)
      const namesSamePrereleaseCore = tokens.some((token) => {
        const match = token.match(/v?(\d+\.\d+\.\d+)-[0-9A-Za-z.-]+/)
        return match?.[1] === core
      })
      if (!namesSamePrereleaseCore) return false
    }
    return outcomes.every(Boolean)
  })
  return understood ? result : undefined
}

export function inspectProfileManifest(manifestPath, { fix = false } = {}) {
  let original
  try {
    original = readFileBounded(manifestPath)
  } catch (error) {
    return {
      path: manifestPath,
      hasBom: false,
      repaired: false,
      validJson: false,
      jsonError: error instanceof Error ? error.message : String(error),
      oversized: error?.code === 'DOCTOR_INPUT_TOO_LARGE',
      pluginBundleCount: 0,
      pluginBundle: false,
    }
  }
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
    pluginDependency: typeof dependencies?.[PLUGIN_NAME] === 'string'
      ? dependencies[PLUGIN_NAME]
      : undefined,
    pluginBundle: Array.isArray(bundles) && bundles.includes(PLUGIN_NAME),
    pluginBundleCount: Array.isArray(bundles) ? bundles.filter((name) => name === PLUGIN_NAME).length : 0,
  }
}

export function inspectProfileWorkspace(workspacePath, { fix = false } = {}) {
  if (!existsSync(workspacePath)) {
    return { path: workspacePath, exists: false, pinned: [], rewritten: false }
  }
  let original
  try {
    original = readFileBounded(workspacePath).toString('utf8')
  } catch (error) {
    return { path: workspacePath, exists: true, pinned: [], rewritten: false, error: error instanceof Error ? error.message : String(error), oversized: error?.code === 'DOCTOR_INPUT_TOO_LARGE' }
  }
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

function stripYamlComment(line) {
  let quote
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if ((char === '"' || char === "'") && line[index - 1] !== '\\') {
      quote = quote === char ? undefined : quote ?? char
      continue
    }
    if (char === '#' && quote === undefined) return line.slice(0, index)
  }
  return line
}

function yamlIndent(line) {
  return /^(\s*)/.exec(line)?.[1].length ?? 0
}

function rowIsInsideInsert(lines, rowIndex, rowIndent) {
  for (let cursor = rowIndex - 1; cursor >= 0; cursor -= 1) {
    const candidate = lines[cursor]
    if (/^\s*$/.test(candidate)) continue
    const indent = yamlIndent(candidate)
    if (indent >= rowIndent) continue
    return /^\s*-?\s*insert\s*:\s*$/.test(candidate)
  }
  return false
}

function inspectVisionRouterPatchRows(lines) {
  let mountRows = 0
  let overrideRows = 0

  for (let index = 0; index < lines.length; index += 1) {
    const idMatch = /^(\s*)-\s+id\s*:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(lines[index])
    if (!idMatch) continue
    const rowIndent = idMatch[1].length
    let pluginName
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]
      if (/^\s*$/.test(candidate)) continue
      const indent = yamlIndent(candidate)
      if (indent <= rowIndent) break
      const nameMatch = /^\s*name\s*:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(candidate)
      if (nameMatch) pluginName = nameMatch[1]
    }
    if (idMatch[2] !== 'vision-router' && pluginName !== PLUGIN_NAME) continue
    if (rowIsInsideInsert(lines, index, rowIndent)) mountRows += 1
    else overrideRows += 1
  }

  return { mountRows, overrideRows }
}

export function inspectProfilePatch(patchPath) {
  if (!existsSync(patchPath)) {
    return {
      path: patchPath,
      exists: false,
      visionRouterRows: 0,
      visionRouterOverrideRows: 0,
      manualVisionRouter: false,
      disablesOfficialDeepSeek: false,
    }
  }
  let text
  try {
    text = readFileBounded(patchPath).toString('utf8')
  } catch (error) {
    return { path: patchPath, exists: true, visionRouterRows: 0, visionRouterOverrideRows: 0, manualVisionRouter: false, disablesOfficialDeepSeek: false, error: error instanceof Error ? error.message : String(error), oversized: error?.code === 'DOCTOR_INPUT_TOO_LARGE' }
  }
  const lines = text.split(/\r?\n/).map(stripYamlComment)
  const { mountRows: visionRouterRows, overrideRows: visionRouterOverrideRows } = inspectVisionRouterPatchRows(lines)
  let disablesOfficialDeepSeek = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!/^\s*-?\s*id\s*:\s*['"]?llm-deepseek['"]?\s*$/.test(line)) continue
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 12); cursor += 1) {
      if (/^\s*-\s+id\s*:/.test(lines[cursor])) break
      if (/^\s*disabled\s*:\s*true\s*$/.test(lines[cursor])) {
        disablesOfficialDeepSeek = true
        break
      }
    }
  }
  return {
    path: patchPath,
    exists: true,
    visionRouterRows,
    visionRouterOverrideRows,
    manualVisionRouter: visionRouterRows > 0,
    disablesOfficialDeepSeek,
  }
}

function inspectInstalledPackage(profileDir) {
  const packageDir = path.join(profileDir, 'node_modules', PLUGIN_NAME)
  const manifestPath = path.join(packageDir, 'package.json')
  if (!existsSync(packageDir)) return { present: false, packageDir, manifestPath, errors: [] }
  const errors = []
  let manifest
  try {
    manifest = JSON.parse(readFileBounded(manifestPath, INSTALLED_MANIFEST_MAX_BYTES).toString('utf8'))
  } catch (error) {
    errors.push(`installed package manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (manifest && manifest.name !== PLUGIN_NAME) errors.push(`installed package identity is ${String(manifest.name ?? 'missing')}, expected ${PLUGIN_NAME}`)
  const version = typeof manifest?.version === 'string' ? manifest.version : undefined
  if (manifest && !version) errors.push('installed package manifest has no version')
  const entry = typeof manifest?.main === 'string' && manifest.main !== '' ? manifest.main : undefined
  if (entry && !existsSync(path.resolve(packageDir, entry))) errors.push(`installed package main target is missing (${entry})`)
  const bundlePatch = typeof manifest?.dsh?.bundle?.patch === 'string' && manifest.dsh.bundle.patch !== ''
    ? manifest.dsh.bundle.patch
    : undefined
  if (bundlePatch && !existsSync(path.resolve(packageDir, bundlePatch))) errors.push(`installed bundle patch target is missing (${bundlePatch})`)
  let realPath
  try { realPath = realpathSync(packageDir) } catch { realPath = packageDir }
  return { present: true, packageDir, manifestPath, realPath, version, name: manifest?.name, entry, bundlePatch, errors }
}

export function classifyProfileInstallation(profile, { requested = false } = {}) {
  const dependency = Boolean(profile?.pluginDependency)
  const bundle = profile?.pluginBundle === true
  const manual = profile?.patch?.manualVisionRouter === true
  const installed = profile?.installedPlugin?.present === true
  const evidence = dependency || bundle || manual || installed
  const applicable = requested || evidence
  const errors = []
  const warnings = []
  let mode = 'not-installed'

  if (!applicable) return { applicable: false, mode, ok: true, errors, warnings }
  if (!profile?.exists) errors.push('profile package.json does not exist')
  else if (!profile?.validJson) errors.push('profile manifest is not usable')
  if (profile?.patch?.error) errors.push(`cordis.patch.yml is not usable: ${profile.patch.error}`)
  if (profile?.workspace?.error) errors.push(`pnpm-workspace.yaml is not usable: ${profile.workspace.error}`)

  if (requested && !evidence) errors.push('Vision Router is not installed or mounted in the requested profile')
  if (bundle && manual) {
    mode = 'duplicate'
    errors.push('Vision Router is registered by both dsh.profile.bundles and cordis.patch.yml; this can activate the plugin twice')
  } else if (bundle) {
    mode = 'bundle'
  } else if (manual) {
    mode = 'manual'
  } else if (dependency || installed) {
    mode = 'unmounted'
    errors.push('Vision Router is installed/declared but is not registered as a bundle or manual cordis.patch.yml row')
  }

  if (bundle && !dependency) errors.push('Vision Router bundle is registered but package.json does not declare the dependency')
  if (manual && !dependency) errors.push('Vision Router has a manual cordis.patch.yml row but package.json does not declare the dependency')
  if (Number(profile?.pluginBundleCount ?? 0) > 1) errors.push(`dsh.profile.bundles contains Vision Router ${profile.pluginBundleCount} times`)
  if (dependency && !installed) errors.push('Vision Router is declared in package.json but node_modules/dsh-vision-router is missing')
  if (profile?.patch?.visionRouterRows > 1) errors.push(`cordis.patch.yml contains ${profile.patch.visionRouterRows} Vision Router rows`)
  for (const error of profile?.installedPlugin?.errors ?? []) errors.push(error)
  if (dependency && installed && profile.installedPlugin?.version) {
    const satisfies = registrySpecSatisfiesVersion(profile.pluginDependency, profile.installedPlugin.version)
    if (satisfies === false) {
      errors.push(`declared Vision Router version ${profile.pluginDependency} does not match installed ${profile.installedPlugin.version}`)
    }
  }
  if (profile?.patch?.disablesOfficialDeepSeek) {
    warnings.push('cordis.patch.yml statically disables llm-deepseek; legacy stealth patches can make the official model disappear when Vision Router is disabled')
  }
  return {
    applicable,
    mode,
    ok: errors.length === 0,
    errors,
    warnings,
    declaredSpecKind: dependencySpecKind(profile?.pluginDependency),
    installedVersion: profile?.installedPlugin?.version,
    installTarget: profile?.installedPlugin?.realPath,
  }
}

function readTail(file, maxBytes) {
  if (!existsSync(file)) return { file, exists: false, text: '' }
  let fd
  try {
    const stat = statSync(file)
    const size = Math.min(stat.size, maxBytes)
    const buffer = Buffer.alloc(size)
    fd = openSync(file, 'r')
    if (size > 0) readSync(fd, buffer, 0, size, Math.max(0, stat.size - size))
    let text = buffer.toString('utf8')
    if (stat.size > maxBytes) {
      const newline = text.indexOf('\n')
      if (newline >= 0) text = text.slice(newline + 1)
    }
    return { file, exists: true, text, truncated: stat.size > maxBytes }
  } catch (error) {
    return { file, exists: true, text: '', readError: error instanceof Error ? error.message : String(error) }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function structuredLogDiagnostics(lines, latestStartupIndex) {
  const currentSettingsSaveFailures = []
  const historicalSettingsSaveFailures = []
  const recentErrors = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const save = /settings save failed\s+field=([^\s]+)\s+operation=([^\s]+)\s+reason=([^\s]+)/i.exec(line)
    if (save) {
      const item = { field: save[1], operation: save[2], reason: save[3] }
      if (latestStartupIndex >= 0 && index > latestStartupIndex) currentSettingsSaveFailures.push(item)
      else historicalSettingsSaveFailures.push(item)
    }
    if (/\b(?:ERROR|FATAL)\b/i.test(line)) {
      const code = /\b(?:code|reason)=([^\s]+)/i.exec(line)?.[1]
      recentErrors.push({ code })
    }
  }
  return {
    settingsSaveFailures: currentSettingsSaveFailures.slice(-20),
    historicalSettingsSaveFailures: historicalSettingsSaveFailures.slice(-20),
    recentErrors: recentErrors.slice(-20),
  }
}

export function inspectVisionRouterLog(dshHome, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const file = path.join(dshHome, LOG_RELATIVE_PATH)
  const backup = path.join(dshHome, LOG_BACKUP_RELATIVE_PATH)
  const older = readTail(backup, maxBytes)
  const current = readTail(file, maxBytes)
  if (!older.exists && !current.exists) {
    return { file, backup, exists: false, settingsSaveFailures: [], historicalSettingsSaveFailures: [], recentErrors: [] }
  }
  const lines = `${older.text}${older.text && current.text ? '\n' : ''}${current.text}`
    .split(/\r?\n/).filter(Boolean).slice(-LOG_LINE_LIMIT)
  let latestStartupIndex = -1
  let startupVersion
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes(STARTUP_MARKER)) continue
    latestStartupIndex = index
    startupVersion = /\(plugin=([^\s)]+)/.exec(lines[index])?.[1]
  }
  return {
    file,
    backup,
    exists: true,
    readError: current.readError ?? older.readError,
    startupScoped: latestStartupIndex >= 0,
    startupVersion,
    ...structuredLogDiagnostics(lines, latestStartupIndex),
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

export function doctorProfiles({ dshHome = resolveDshHome(), profile, fix = false } = {}) {
  const names = listProfileNames(dshHome, profile)
  const profiles = []

  for (const name of names) {
    const profileDir = path.join(dshHome, 'profiles', name)
    const manifestPath = path.join(profileDir, 'package.json')
    const workspacePath = path.join(profileDir, WORKSPACE_FILENAME)
    const patchPath = path.join(profileDir, PROFILE_PATCH_FILENAME)
    const patch = inspectProfilePatch(patchPath)
    const installedPlugin = inspectInstalledPackage(profileDir)
    const workspace = inspectProfileWorkspace(workspacePath, { fix })
    if (!existsSync(manifestPath)) {
      const item = {
        name,
        profileDir,
        path: manifestPath,
        exists: false,
        validJson: false,
        jsonError: 'profile package.json does not exist',
        patch,
        installedPlugin,
        workspace,
        pluginBundleCount: 0,
        pluginBundle: false,
      }
      item.installation = classifyProfileInstallation(item, { requested: profile === name })
      profiles.push(item)
      continue
    }
    const manifestReport = inspectProfileManifest(manifestPath, { fix })
    const item = {
      name,
      profileDir,
      exists: true,
      ...manifestReport,
      coexistingVisionPlugins: manifestReport.validJson ? inspectCoexistingVisionPlugins(profileDir) : [],
      workspace,
      patch,
      installedPlugin,
    }
    item.installation = classifyProfileInstallation(item, { requested: profile === name })
    profiles.push(item)
  }

  const applicable = profiles.filter((item) => item.installation?.applicable)
  const profileHealthy = (item) => item.exists
    && item.validJson
    && (!item.hasBom || item.repaired)
    && (!item.workspace || (item.workspace.error === undefined && (item.workspace.pinned.length === 0 || item.workspace.rewritten)))
    && item.patch?.error === undefined
    && item.installation?.ok !== false
  const log = inspectVisionRouterLog(dshHome)

  return {
    dshHome,
    requestedProfile: profile,
    fix,
    profiles,
    applicableProfiles: applicable.length,
    log,
    ok: applicable.length > 0
      && applicable.every(profileHealthy)
      && (log.settingsSaveFailures?.length ?? 0) === 0,
  }
}