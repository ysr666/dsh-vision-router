import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  currentVisionTurnBudget,
  currentVisionTurnBudgetSignal,
} from './turn-budget-context.js'
import {
  isManagedArtifactRunName,
  scheduleArtifactRetention,
} from './artifact-retention.js'

export const DEFAULT_ARTIFACTS_DIR = '.dsh-vision-router/artifacts'

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function isMissing(error) {
  return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function artifactAbortError() {
  const error = new Error('vision-router: artifact publication aborted')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

function throwIfVisionAborted() {
  if (currentVisionTurnBudgetSignal()?.aborted) throw artifactAbortError()
}

function currentArtifactRunId() {
  const value = currentVisionTurnBudget()?.artifactRunId
  return isManagedArtifactRunName(value) ? value : undefined
}

export function normalizeArtifactsDir(value) {
  if (typeof value !== 'string' || value.trim() === '') return DEFAULT_ARTIFACTS_DIR
  const raw = value.trim()
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw)) return DEFAULT_ARTIFACTS_DIR
  const parts = raw.split(/[\\/]+/)
  if (parts.some((part) => part === '..')) return DEFAULT_ARTIFACTS_DIR
  const normalized = path.normalize(raw)
  if (normalized === '' || normalized === '.' || normalized === path.sep) return DEFAULT_ARTIFACTS_DIR
  return normalized
}

function normalizeRelativeArtifactPath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('vision-router: artifact path must be a non-empty relative path')
  }
  const raw = value.trim()
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new Error('vision-router: artifact path must stay inside the artifacts directory')
  }
  const parts = raw.split(/[\\/]+/)
  if (parts.some((part) => part === '..')) {
    throw new Error('vision-router: artifact path must stay inside the artifacts directory')
  }
  const normalized = path.normalize(raw)
  if (normalized === '' || normalized === '.' || normalized === path.sep) {
    throw new Error('vision-router: artifact path must name a file')
  }
  return normalized
}

async function realpathNearestExisting(candidate, realpathImpl) {
  let current = candidate
  while (true) {
    try {
      return await realpathImpl(current)
    } catch (error) {
      if (!isMissing(error)) throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

async function safeLstat(target, lstatImpl) {
  try {
    return await lstatImpl(target)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/**
 * Resolve an artifact target without treating lexical workspace containment as
 * authority. Existing ancestors are canonicalized before mkdir runs, then the
 * completed parent and artifact root are canonicalized again.
 */
export async function resolveArtifactTarget(workspace, artifactsDir, relativePath, deps = {}) {
  const realpathImpl = deps.realpath ?? realpath
  const mkdirImpl = deps.mkdir ?? mkdir
  const lstatImpl = deps.lstat ?? lstat

  throwIfVisionAborted()
  const workspaceReal = await realpathImpl(path.resolve(String(workspace ?? '')))
  throwIfVisionAborted()
  const relativeBase = normalizeArtifactsDir(artifactsDir)
  const runId = currentArtifactRunId()
  const requestedTarget = normalizeRelativeArtifactPath(relativePath)
  const relativeTarget = runId
    ? normalizeRelativeArtifactPath(path.join(runId, requestedTarget))
    : requestedTarget
  const lexicalBase = path.resolve(workspaceReal, relativeBase)
  if (!isPathInside(workspaceReal, lexicalBase)) {
    throw new Error('vision-router: artifactsDir must stay inside the session workspace')
  }
  const lexicalTarget = path.resolve(lexicalBase, relativeTarget)
  if (!isPathInside(lexicalBase, lexicalTarget)) {
    throw new Error('vision-router: artifact target must stay inside the artifacts directory')
  }

  const lexicalParent = path.dirname(lexicalTarget)
  const existingAncestorReal = await realpathNearestExisting(lexicalParent, realpathImpl)
  throwIfVisionAborted()
  if (!isPathInside(workspaceReal, existingAncestorReal)) {
    throw new Error('vision-router: artifact parent escapes the session workspace through a symlink')
  }

  await mkdirImpl(lexicalParent, { recursive: true })
  throwIfVisionAborted()
  const parentReal = await realpathImpl(lexicalParent)
  const artifactsBaseReal = await realpathImpl(lexicalBase)
  throwIfVisionAborted()
  if (!isPathInside(workspaceReal, parentReal) || !isPathInside(workspaceReal, artifactsBaseReal)) {
    throw new Error('vision-router: artifact parent escapes the session workspace through a symlink')
  }

  const target = path.join(parentReal, path.basename(lexicalTarget))
  const existing = await safeLstat(target, lstatImpl)
  throwIfVisionAborted()
  if (existing?.isDirectory?.()) {
    throw new Error('vision-router: artifact target is a directory')
  }
  return { target, parentReal, artifactsBaseReal, existing, runId }
}

/**
 * Publish artifact bytes without ever opening the final target for writing.
 * A temp file is written in the canonical parent and renamed over the target;
 * an existing symlink is unlinked as a directory entry rather than followed.
 */
export async function writeArtifactFile(workspace, artifactsDir, relativePath, data, deps = {}) {
  const writeFileImpl = deps.writeFile ?? writeFile
  const renameImpl = deps.rename ?? rename
  const unlinkImpl = deps.unlink ?? unlink
  const resolved = await resolveArtifactTarget(workspace, artifactsDir, relativePath, deps)
  const temp = path.join(
    resolved.parentReal,
    `.dsh-vision-router-${process.pid}-${randomUUID()}.tmp`,
  )
  let published = false
  try {
    throwIfVisionAborted()
    await writeFileImpl(temp, data, { mode: 0o600 })
    throwIfVisionAborted()
    if (resolved.existing !== undefined) {
      try {
        await unlinkImpl(resolved.target)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
      throwIfVisionAborted()
    }
    await renameImpl(temp, resolved.target)
    published = true
    if (resolved.runId) {
      scheduleArtifactRetention(resolved.artifactsBaseReal, { protectRunId: resolved.runId })
    }
    return resolved.target
  } finally {
    if (!published) {
      try { await unlinkImpl(temp) } catch { /* best effort */ }
    }
  }
}
