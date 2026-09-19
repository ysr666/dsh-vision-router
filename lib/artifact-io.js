import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rename, unlink, utimes, writeFile } from 'node:fs/promises'
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
export const ARTIFACT_RUNS_DIR = '.runs'
export const ARTIFACT_HANDOFF_RUN_ID = '.vision-run-handoff'

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
 * Hardened artifact target primitive below VisionArtifactStore.
 *
 * P2-B gives managed tool-run artifacts their own `.runs/` namespace. The
 * namespace is treated as infrastructure, not user-controlled path data: an
 * existing symlink is rejected even when it points somewhere else inside the
 * workspace. Artifacts outside a managed run keep their original root layout.
 */
async function resolveArtifactTargetForRun(workspace, artifactsDir, relativePath, deps = {}, runId) {
  const realpathImpl = deps.realpath ?? realpath
  const mkdirImpl = deps.mkdir ?? mkdir
  const lstatImpl = deps.lstat ?? lstat

  throwIfVisionAborted()
  const workspaceReal = await realpathImpl(path.resolve(String(workspace ?? '')))
  throwIfVisionAborted()
  const relativeBase = normalizeArtifactsDir(artifactsDir)
  const requestedTarget = normalizeRelativeArtifactPath(relativePath)
  const relativeTarget = runId
    ? normalizeRelativeArtifactPath(path.join(ARTIFACT_RUNS_DIR, runId, requestedTarget))
    : requestedTarget
  const lexicalBase = path.resolve(workspaceReal, relativeBase)
  if (!isPathInside(workspaceReal, lexicalBase)) {
    throw new Error('vision-router: artifactsDir must stay inside the session workspace')
  }

  const lexicalRunsBase = runId ? path.resolve(lexicalBase, ARTIFACT_RUNS_DIR) : undefined
  const lexicalRunBase = runId ? path.resolve(lexicalRunsBase, runId) : undefined
  if (lexicalRunsBase && !isPathInside(lexicalBase, lexicalRunsBase)) {
    throw new Error('vision-router: managed artifact runs must stay inside the artifacts directory')
  }
  if (lexicalRunsBase) {
    const before = await safeLstat(lexicalRunsBase, lstatImpl)
    throwIfVisionAborted()
    if (before?.isSymbolicLink?.()) {
      throw new Error('vision-router: managed artifact runs directory must not be a symlink')
    }
    if (before !== undefined && !before.isDirectory?.()) {
      throw new Error('vision-router: managed artifact runs path must be a directory')
    }
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

  let runsBaseReal
  let runBaseReal
  if (lexicalRunsBase) {
    const after = await safeLstat(lexicalRunsBase, lstatImpl)
    throwIfVisionAborted()
    if (!after?.isDirectory?.() || after.isSymbolicLink?.()) {
      throw new Error('vision-router: managed artifact runs directory must be a real directory')
    }
    runsBaseReal = await realpathImpl(lexicalRunsBase)
    throwIfVisionAborted()
    if (!isPathInside(artifactsBaseReal, runsBaseReal)) {
      throw new Error('vision-router: managed artifact runs directory escapes the artifacts directory')
    }
    const runInfo = await safeLstat(lexicalRunBase, lstatImpl)
    throwIfVisionAborted()
    if (!runInfo?.isDirectory?.() || runInfo.isSymbolicLink?.()) {
      throw new Error('vision-router: managed artifact run must be a real directory')
    }
    runBaseReal = await realpathImpl(lexicalRunBase)
    throwIfVisionAborted()
    if (!isPathInside(runsBaseReal, runBaseReal)) {
      throw new Error('vision-router: managed artifact run escapes the runs directory')
    }
  }

  const target = path.join(parentReal, path.basename(lexicalTarget))
  const existing = await safeLstat(target, lstatImpl)
  throwIfVisionAborted()
  if (existing?.isDirectory?.()) {
    throw new Error('vision-router: artifact target is a directory')
  }
  return { target, parentReal, artifactsBaseReal, runsBaseReal, runBaseReal, existing, runId }
}

export function resolveArtifactTarget(workspace, artifactsDir, relativePath, deps = {}) {
  return resolveArtifactTargetForRun(
    workspace, artifactsDir, relativePath, deps, currentArtifactRunId(),
  )
}

/**
 * Resolve a stable cross-tool handoff artifact even when the caller is inside
 * a random managed per-tool run. Handoff files share one reserved managed run,
 * so their path is deterministic enough for later tool calls while existing
 * retention still bounds their lifetime and total bytes.
 */
export function resolvePersistentArtifactTarget(workspace, artifactsDir, relativePath, deps = {}) {
  return resolveArtifactTargetForRun(
    workspace, artifactsDir, relativePath, deps, ARTIFACT_HANDOFF_RUN_ID,
  )
}

async function writeArtifactFileForRun(workspace, artifactsDir, relativePath, data, deps, runId) {
  const writeFileImpl = deps.writeFile ?? writeFile
  const renameImpl = deps.rename ?? rename
  const unlinkImpl = deps.unlink ?? unlink
  const utimesImpl = deps.utimes ?? utimes
  const resolved = await resolveArtifactTargetForRun(workspace, artifactsDir, relativePath, deps, runId)
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
    if (resolved.runId === ARTIFACT_HANDOFF_RUN_ID && resolved.runBaseReal) {
      const touchedAt = new Date()
      await utimesImpl(resolved.runBaseReal, touchedAt, touchedAt)
      throwIfVisionAborted()
    }
    if (resolved.runId) {
      // New managed runs live under `.runs`, so retention scans that directory
      // directly. Also schedule the old artifact root so pre-P2-B direct
      // `.vision-run-*` directories continue to age out safely.
      if (resolved.runsBaseReal) {
        scheduleArtifactRetention(resolved.runsBaseReal, { protectRunId: resolved.runId })
      }
      scheduleArtifactRetention(resolved.artifactsBaseReal, { protectRunId: resolved.runId })
    }
    return resolved.target
  } finally {
    if (!published) {
      try { await unlinkImpl(temp) } catch { /* best effort */ }
    }
  }
}

/** Hardened atomic publication primitive used by VisionArtifactStore. */
export async function writeArtifactFile(workspace, artifactsDir, relativePath, data, deps = {}) {
  return writeArtifactFileForRun(
    workspace, artifactsDir, relativePath, data, deps, currentArtifactRunId(),
  )
}

/**
 * Publish a stable workspace handoff artifact under the reserved managed run
 * while preserving the exact same containment, symlink, cancellation, atomic
 * write and retention checks as writeArtifactFile.
 */
export async function writePersistentArtifactFile(workspace, artifactsDir, relativePath, data, deps = {}) {
  return writeArtifactFileForRun(
    workspace, artifactsDir, relativePath, data, deps, ARTIFACT_HANDOFF_RUN_ID,
  )
}
