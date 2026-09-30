import { lstat, opendir, rm } from 'node:fs/promises'
import path from 'node:path'

export const ARTIFACT_RUN_PREFIX = '.vision-run-'
export const DEFAULT_ARTIFACT_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const DEFAULT_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const DEFAULT_ARTIFACT_MAX_RUNS = 512
export const DEFAULT_ARTIFACT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000
export const DEFAULT_ARTIFACT_SCAN_MAX_ENTRIES = 8_192
export const DEFAULT_ARTIFACT_SCAN_MAX_DEPTH = 32
export const DEFAULT_ARTIFACT_SCAN_MAX_MS = 2_000

const cleanupState = new Map()
const activeArtifactRuns = new Map()
const MAX_TRACKED_ROOTS = 64

export function isManagedArtifactRunName(name) {
  return typeof name === 'string' && /^\.vision-run-[A-Za-z0-9._-]+$/.test(name)
}

/** Keep one run protected for the entire vision-tool lifetime. */
export function retainArtifactRun(runId) {
  if (!isManagedArtifactRunName(runId)) return () => {}
  activeArtifactRuns.set(runId, (activeArtifactRuns.get(runId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (activeArtifactRuns.get(runId) ?? 1) - 1
    if (remaining <= 0) activeArtifactRuns.delete(runId)
    else activeArtifactRuns.set(runId, remaining)
  }
}

function finitePositive(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function finitePositiveInteger(value, fallback) {
  return Math.max(1, Math.floor(finitePositive(value, fallback)))
}

function createScanBudget({ maxEntries, maxDepth, maxMs, clock }) {
  const startedAt = Number(clock())
  return {
    maxEntries: finitePositiveInteger(maxEntries, DEFAULT_ARTIFACT_SCAN_MAX_ENTRIES),
    maxDepth: finitePositiveInteger(maxDepth, DEFAULT_ARTIFACT_SCAN_MAX_DEPTH),
    maxMs: finitePositive(maxMs, DEFAULT_ARTIFACT_SCAN_MAX_MS),
    clock,
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    entries: 0,
    limited: false,
    exhausted: false,
  }
}

function createScanBudgets(options = {}) {
  const clock = typeof options.scanClock === 'function' ? options.scanClock : Date.now
  return {
    discovery: createScanBudget({
      maxEntries: options.maxDiscoveryEntries ?? options.maxScanEntries,
      maxDepth: 1,
      maxMs: options.maxDiscoveryMs ?? options.maxScanMs,
      clock,
    }),
    measurement: createScanBudget({
      maxEntries: options.maxScanEntries,
      maxDepth: options.maxScanDepth,
      maxMs: options.maxScanMs,
      clock,
    }),
  }
}

function scanTimedOut(budget) {
  const current = Number(budget.clock())
  if (!Number.isFinite(current)) return false
  return current - budget.startedAt >= budget.maxMs
}

function admitScanEntry(budget) {
  if (budget.exhausted) return false
  if (budget.entries >= budget.maxEntries || scanTimedOut(budget)) {
    budget.exhausted = true
    budget.limited = true
    return false
  }
  budget.entries += 1
  return true
}

function protectedRunSet(options = {}) {
  const shared = options.protectRunIds instanceof Set
    ? options.protectRunIds
    : new Set(Array.isArray(options.protectRunIds) ? options.protectRunIds : [])
  if (isManagedArtifactRunName(options.protectRunId)) shared.add(options.protectRunId)
  return shared
}

function runProtected(name, protectedRuns) {
  return protectedRuns.has(name) || activeArtifactRuns.has(name)
}

async function collectManagedRuns(root, budget) {
  let directory
  try {
    directory = await opendir(root)
  } catch (error) {
    const missing = error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
    if (!missing) budget.limited = true
    return { runs: [], complete: missing }
  }
  const runs = []
  let complete = true
  try {
    for await (const entry of directory) {
      if (!admitScanEntry(budget)) {
        complete = false
        break
      }
      if (!entry.isDirectory() || !isManagedArtifactRunName(entry.name)) continue
      const target = path.join(root, entry.name)
      let info
      try {
        info = await lstat(target)
      } catch {
        budget.limited = true
        complete = false
        continue
      }
      if (!info.isDirectory() || info.isSymbolicLink()) continue
      runs.push({
        name: entry.name,
        target,
        mtimeMs: Number(info.mtimeMs) || 0,
        bytes: 0,
        scanComplete: false,
      })
    }
  } catch {
    budget.limited = true
    complete = false
  }
  return { runs, complete }
}

/**
 * Measure one managed run with a bounded streaming traversal. `complete=false`
 * means the size is unknown; callers must never reinterpret uncertainty as
 * evidence that destructive byte eviction is safe.
 */
async function treeBytesBounded(target, budget, byteCeiling) {
  const stack = [{ target, depth: 0 }]
  let total = 0
  let complete = true

  while (stack.length > 0) {
    if (budget.exhausted || scanTimedOut(budget)) {
      budget.exhausted = true
      budget.limited = true
      return { bytes: total, complete: false }
    }
    const current = stack.pop()
    let directory
    try {
      directory = await opendir(current.target)
    } catch {
      budget.limited = true
      return { bytes: total, complete: false }
    }

    try {
      for await (const entry of directory) {
        if (!admitScanEntry(budget)) return { bytes: total, complete: false }
        if (entry.isSymbolicLink()) continue
        const child = path.join(current.target, entry.name)
        let info
        try {
          info = await lstat(child)
        } catch {
          budget.limited = true
          complete = false
          continue
        }
        if (info.isSymbolicLink()) continue
        if (info.isDirectory()) {
          const nextDepth = current.depth + 1
          if (nextDepth > budget.maxDepth) {
            complete = false
            budget.limited = true
            continue
          }
          stack.push({ target: child, depth: nextDepth })
          continue
        }
        total += Math.max(0, Number(info.size) || 0)
        if (total > byteCeiling) {
          return { bytes: byteCeiling + 1, complete: true, saturated: true }
        }
      }
    } catch {
      complete = false
      budget.limited = true
    }
  }

  return { bytes: total, complete }
}

function cleanupResult(scanned, removed, bytes, scan, includeScanDiagnostics) {
  const result = { scanned, removed, bytes: Math.max(0, bytes) }
  if (includeScanDiagnostics === true) {
    result.scan = {
      entries: scan.discovery.entries + scan.measurement.entries,
      limited: scan.discovery.limited === true || scan.measurement.limited === true,
      exhausted: scan.discovery.exhausted === true || scan.measurement.exhausted === true,
      discoveryEntries: scan.discovery.entries,
      measurementEntries: scan.measurement.entries,
      discoveryComplete: scan.discoveryComplete === true,
      bytesComplete: scan.bytesComplete === true,
    }
  }
  return result
}

/**
 * Delete only Vision Router run directories. Unknown files, legacy artifacts,
 * symlinks and user-created directories are intentionally outside this policy.
 *
 * TTL can act on each discovered run independently. maxRuns and maxBytes are
 * global policies, so they run only when discovery is complete; byte eviction
 * additionally requires every surviving run size to be known. Uncertainty is
 * therefore fail-safe for user data rather than being treated as over-budget.
 */
export async function cleanupArtifactRuns(root, options = {}) {
  const ttlMs = finitePositive(options.ttlMs, DEFAULT_ARTIFACT_TTL_MS)
  const maxBytes = finitePositive(options.maxBytes, DEFAULT_ARTIFACT_MAX_BYTES)
  const maxRuns = finitePositiveInteger(options.maxRuns, DEFAULT_ARTIFACT_MAX_RUNS)
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const protectedRuns = protectedRunSet(options)
  const budgets = createScanBudgets(options)

  const discovery = await collectManagedRuns(root, budgets.discovery)
  const runs = discovery.runs
  let bytesComplete = discovery.complete
  if (runs.length === 0) {
    return cleanupResult(0, 0, 0, {
      ...budgets,
      discoveryComplete: discovery.complete,
      bytesComplete,
    }, options.includeScanDiagnostics)
  }

  runs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const remove = new Set()
  const byteEvictions = new Set()
  for (const run of runs) {
    if (!runProtected(run.name, protectedRuns) && now - run.mtimeMs >= ttlMs) remove.add(run)
  }

  const survivors = () => runs.filter((run) => !remove.has(run))
  let live = survivors()
  if (discovery.complete) {
    while (live.length > maxRuns) {
      const candidate = [...live].reverse().find((run) => !runProtected(run.name, protectedRuns))
      if (!candidate) break
      remove.add(candidate)
      live = survivors()
    }
  }

  let totalBytes = 0
  if (discovery.complete) {
    for (const run of live) {
      const measured = await treeBytesBounded(run.target, budgets.measurement, maxBytes)
      run.bytes = measured.bytes
      run.scanComplete = measured.complete === true
      if (!run.scanComplete) bytesComplete = false
    }
    totalBytes = live.reduce((sum, run) => sum + run.bytes, 0)

    if (bytesComplete) {
      while (totalBytes > maxBytes) {
        const candidate = [...live].reverse().find((run) => !runProtected(run.name, protectedRuns))
        if (!candidate) break
        remove.add(candidate)
        byteEvictions.add(candidate)
        totalBytes -= candidate.bytes
        live = survivors()
      }
    }
  }

  let removed = 0
  for (const run of remove) {
    // Protection is checked again immediately before deletion so a concurrent
    // tool that became active after cleanup started cannot lose its run.
    if (runProtected(run.name, protectedRuns)) {
      if (byteEvictions.has(run)) totalBytes += run.bytes
      else bytesComplete = false
      continue
    }
    try {
      await rm(run.target, { recursive: true, force: true })
      removed += 1
    } catch {
      if (byteEvictions.has(run)) totalBytes += run.bytes
      else bytesComplete = false
      // Retention is best-effort and must never make the foreground tool fail.
    }
  }

  return cleanupResult(runs.length, removed, totalBytes, {
    ...budgets,
    discoveryComplete: discovery.complete,
    bytesComplete,
  }, options.includeScanDiagnostics)
}

function addScheduledProtection(state, options = {}) {
  if (isManagedArtifactRunName(options.protectRunId)) state.protectedRunIds.add(options.protectRunId)
  if (options.protectRunIds instanceof Set || Array.isArray(options.protectRunIds)) {
    for (const runId of options.protectRunIds) {
      if (isManagedArtifactRunName(runId)) state.protectedRunIds.add(runId)
    }
  }
}

function trimCleanupState() {
  while (cleanupState.size > MAX_TRACKED_ROOTS) {
    let evicted
    for (const [root, state] of cleanupState) {
      if (state.promise) continue
      evicted = root
      break
    }
    if (evicted === undefined) break
    cleanupState.delete(evicted)
  }
}

/** Coalesce cleanup work per artifact root so foreground tools only schedule it. */
export function scheduleArtifactRetention(root, options = {}) {
  if (typeof root !== 'string' || root === '') return
  const now = Date.now()
  let state = cleanupState.get(root)
  if (!state) {
    state = { lastStartedAt: 0, promise: undefined, protectedRunIds: new Set() }
    cleanupState.set(root, state)
  }

  if (state.promise) {
    addScheduledProtection(state, options)
    return
  }

  const intervalMs = finitePositive(options.intervalMs, DEFAULT_ARTIFACT_CLEANUP_INTERVAL_MS)
  if (now - state.lastStartedAt < intervalMs) return

  addScheduledProtection(state, options)
  state.lastStartedAt = now
  state.promise = cleanupArtifactRuns(root, {
    ...options,
    protectRunIds: state.protectedRunIds,
  })
    .catch(() => undefined)
    .finally(() => {
      state.promise = undefined
      state.protectedRunIds.clear()
    })

  cleanupState.delete(root)
  cleanupState.set(root, state)
  trimCleanupState()
}
