import { lstat, readdir, rm } from 'node:fs/promises'
import path from 'node:path'

export const ARTIFACT_RUN_PREFIX = '.vision-run-'
export const DEFAULT_ARTIFACT_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const DEFAULT_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const DEFAULT_ARTIFACT_MAX_RUNS = 512
export const DEFAULT_ARTIFACT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000

const cleanupState = new Map()
const MAX_TRACKED_ROOTS = 64

export function isManagedArtifactRunName(name) {
  return typeof name === 'string' && /^\.vision-run-[A-Za-z0-9._-]+$/.test(name)
}

async function treeBytes(target) {
  let info
  try { info = await lstat(target) } catch { return 0 }
  if (info.isSymbolicLink()) return 0
  if (!info.isDirectory()) return Number(info.size) || 0
  let total = 0
  let entries
  try { entries = await readdir(target, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    total += await treeBytes(path.join(target, entry.name))
  }
  return total
}

function finitePositive(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

/**
 * Delete only Vision Router run directories. Unknown files, legacy artifacts,
 * symlinks and user-created directories are intentionally outside this policy.
 */
export async function cleanupArtifactRuns(root, options = {}) {
  const ttlMs = finitePositive(options.ttlMs, DEFAULT_ARTIFACT_TTL_MS)
  const maxBytes = finitePositive(options.maxBytes, DEFAULT_ARTIFACT_MAX_BYTES)
  const maxRuns = Math.max(1, Math.floor(finitePositive(options.maxRuns, DEFAULT_ARTIFACT_MAX_RUNS)))
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const protect = typeof options.protectRunId === 'string' ? options.protectRunId : undefined

  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return { scanned: 0, removed: 0, bytes: 0 } }
  const runs = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !isManagedArtifactRunName(entry.name)) continue
    const target = path.join(root, entry.name)
    let info
    try { info = await lstat(target) } catch { continue }
    if (!info.isDirectory() || info.isSymbolicLink()) continue
    runs.push({
      name: entry.name,
      target,
      mtimeMs: Number(info.mtimeMs) || 0,
      bytes: await treeBytes(target),
      protected: entry.name === protect,
    })
  }

  runs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const remove = new Set()
  for (const run of runs) {
    if (!run.protected && now - run.mtimeMs >= ttlMs) remove.add(run)
  }

  const survivors = () => runs.filter((run) => !remove.has(run))
  let live = survivors()
  while (live.length > maxRuns) {
    const candidate = [...live].reverse().find((run) => !run.protected)
    if (!candidate) break
    remove.add(candidate)
    live = survivors()
  }

  let totalBytes = live.reduce((sum, run) => sum + run.bytes, 0)
  while (totalBytes > maxBytes) {
    const candidate = [...live].reverse().find((run) => !run.protected)
    if (!candidate) break
    remove.add(candidate)
    totalBytes -= candidate.bytes
    live = survivors()
  }

  let removed = 0
  for (const run of remove) {
    try {
      await rm(run.target, { recursive: true, force: true })
      removed += 1
    } catch {
      // Retention is best-effort and must never make the foreground tool fail.
    }
  }
  return { scanned: runs.length, removed, bytes: Math.max(0, totalBytes) }
}

/** Coalesce cleanup work per artifact root so foreground tools only schedule it. */
export function scheduleArtifactRetention(root, options = {}) {
  if (typeof root !== 'string' || root === '') return
  const now = Date.now()
  let state = cleanupState.get(root)
  if (!state) {
    state = { lastStartedAt: 0, promise: undefined }
    cleanupState.set(root, state)
  }
  const intervalMs = finitePositive(options.intervalMs, DEFAULT_ARTIFACT_CLEANUP_INTERVAL_MS)
  if (state.promise || now - state.lastStartedAt < intervalMs) return
  state.lastStartedAt = now
  state.promise = cleanupArtifactRuns(root, options)
    .catch(() => undefined)
    .finally(() => { state.promise = undefined })

  cleanupState.delete(root)
  cleanupState.set(root, state)
  while (cleanupState.size > MAX_TRACKED_ROOTS) {
    const oldest = cleanupState.keys().next().value
    if (oldest === undefined) break
    cleanupState.delete(oldest)
  }
}
