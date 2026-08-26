import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  cleanupArtifactRuns,
  retainArtifactRun,
} from '../lib/artifact-retention.js'
import { ImageResourceGovernor } from '../lib/image-resource-governor.js'

async function exists(target) {
  try { await access(target); return true } catch { return false }
}

test('image governor bypasses a blocked large request only within a bounded fairness window', async () => {
  const governor = new ImageResourceGovernor({ maxBytes: 100, maxConcurrent: 3, maxBypasses: 2 })
  const releaseA = await governor.acquire(80)

  let grantedB = false
  let grantedC = false
  let grantedD = false
  let grantedE = false
  const b = governor.acquire(40).then((release) => { grantedB = true; return release })
  const c = governor.acquire(10).then((release) => { grantedC = true; return release })
  const d = governor.acquire(10).then((release) => { grantedD = true; return release })
  const e = governor.acquire(10).then((release) => { grantedE = true; return release })

  await Promise.resolve()
  assert.equal(grantedB, false)
  assert.equal(grantedC, true)
  assert.equal(grantedD, true)
  assert.equal(grantedE, false, 'after two bypasses the large head becomes a fairness barrier')

  const releaseC = await c
  const releaseD = await d
  releaseC()
  releaseD()
  await Promise.resolve()
  assert.equal(grantedE, false, 'releasing bypassed small work must not keep starving the large head')

  releaseA()
  const releaseB = await b
  const releaseE = await e
  assert.equal(grantedB, true)
  assert.equal(grantedE, true)
  releaseB()
  releaseE()
  assert.equal(governor.stats().activeCount, 0)
})

test('exclusive image work is an immediate queue barrier', async () => {
  const governor = new ImageResourceGovernor({ maxBytes: 100, maxConcurrent: 3, maxBypasses: 8 })
  const releaseA = await governor.acquire(10)
  let grantedExclusive = false
  let grantedSmall = false
  const exclusive = governor.acquire(1000).then((release) => {
    grantedExclusive = true
    return release
  })
  const small = governor.acquire(10).then((release) => {
    grantedSmall = true
    return release
  })

  await Promise.resolve()
  assert.equal(grantedExclusive, false)
  assert.equal(grantedSmall, false)
  releaseA()
  const releaseExclusive = await exclusive
  assert.equal(grantedExclusive, true)
  assert.equal(grantedSmall, false, 'small work must not jump an exclusive barrier')
  releaseExclusive()
  const releaseSmall = await small
  assert.equal(grantedSmall, true)
  releaseSmall()
})

test('artifact retention removes expired runs before recursively measuring them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vision-retention-preselect-'))
  try {
    const oldRun = path.join(root, '.vision-run-old')
    const currentRun = path.join(root, '.vision-run-current')
    await mkdir(oldRun)
    await mkdir(currentRun)
    for (let index = 0; index < 32; index++) {
      await writeFile(path.join(oldRun, `${index}.bin`), Buffer.alloc(8))
    }
    await writeFile(path.join(currentRun, 'current.bin'), Buffer.alloc(8))
    await utimes(oldRun, 1, 1)

    const result = await cleanupArtifactRuns(root, {
      now: 10_000,
      ttlMs: 1_000,
      maxRuns: 512,
      maxBytes: 1024 * 1024,
      protectRunId: '.vision-run-current',
      maxDiscoveryEntries: 8,
      maxScanEntries: 1,
      maxScanMs: 60_000,
      includeScanDiagnostics: true,
    })

    assert.equal(result.removed, 1)
    assert.equal(result.scan.discoveryComplete, true)
    assert.equal(result.scan.measurementEntries, 1, 'expired run contents must never consume recursive measurement budget')
    assert.equal(result.scan.bytesComplete, true)
    assert.equal(await exists(oldRun), false)
    assert.equal(await exists(currentRun), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('partial byte measurement never authorizes destructive eviction of another managed run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vision-retention-partial-size-'))
  try {
    const currentRun = path.join(root, '.vision-run-current')
    const otherRun = path.join(root, '.vision-run-other')
    await mkdir(otherRun)
    await writeFile(path.join(otherRun, 'tiny.bin'), Buffer.alloc(1))
    await utimes(otherRun, 2, 2)
    await mkdir(currentRun)
    for (let index = 0; index < 32; index++) {
      await writeFile(path.join(currentRun, `${index}.bin`), Buffer.alloc(8))
    }

    const result = await cleanupArtifactRuns(root, {
      now: 3_000,
      ttlMs: 24 * 60 * 60 * 1000,
      maxRuns: 512,
      maxBytes: 16,
      protectRunId: '.vision-run-current',
      maxDiscoveryEntries: 64,
      maxScanEntries: 2,
      maxScanMs: 60_000,
      includeScanDiagnostics: true,
    })

    assert.equal(result.removed, 0, 'unknown size must fail safe instead of deleting known-good runs')
    assert.equal(result.scan.discoveryComplete, true)
    assert.equal(result.scan.bytesComplete, false)
    assert.equal(await exists(currentRun), true)
    assert.equal(await exists(otherRun), true, 'a tiny sibling run must not be sacrificed for an incompletely scanned protected run')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('incomplete root discovery skips global maxRuns and maxBytes eviction', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vision-retention-partial-discovery-'))
  try {
    const runA = path.join(root, '.vision-run-a')
    const runB = path.join(root, '.vision-run-b')
    await mkdir(runA)
    await mkdir(runB)
    await writeFile(path.join(runA, 'a.bin'), Buffer.alloc(32))
    await writeFile(path.join(runB, 'b.bin'), Buffer.alloc(32))

    const result = await cleanupArtifactRuns(root, {
      ttlMs: 24 * 60 * 60 * 1000,
      maxRuns: 1,
      maxBytes: 1,
      maxDiscoveryEntries: 1,
      maxScanEntries: 64,
      maxScanMs: 60_000,
      includeScanDiagnostics: true,
    })

    assert.equal(result.scan.discoveryComplete, false)
    assert.equal(result.removed, 0, 'global policies require a complete managed-run inventory')
    assert.equal(await exists(runA), true)
    assert.equal(await exists(runB), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('active artifact runs survive TTL cleanup while stale inactive runs are still removable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vision-retention-active-'))
  const activeName = '.vision-run-active'
  const releaseActive = retainArtifactRun(activeName)
  try {
    const activeRun = path.join(root, activeName)
    const staleRun = path.join(root, '.vision-run-stale')
    await mkdir(activeRun)
    await mkdir(staleRun)
    await writeFile(path.join(activeRun, 'active.bin'), Buffer.alloc(8))
    await writeFile(path.join(staleRun, 'stale.bin'), Buffer.alloc(8))
    await utimes(activeRun, 1, 1)
    await utimes(staleRun, 1, 1)

    const result = await cleanupArtifactRuns(root, {
      now: 10_000,
      ttlMs: 1_000,
      maxRuns: 1,
      maxBytes: 1,
      maxDiscoveryEntries: 64,
      maxScanEntries: 64,
      maxScanMs: 60_000,
      includeScanDiagnostics: true,
    })

    assert.equal(result.removed, 1)
    assert.equal(await exists(activeRun), true, 'an in-flight tool run must remain protected for its whole execution lifetime')
    assert.equal(await exists(staleRun), false)
  } finally {
    releaseActive()
    await rm(root, { recursive: true, force: true })
  }
})

test('complete byte accounting still evicts the oldest unprotected run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vision-retention-complete-bytes-'))
  try {
    const oldRun = path.join(root, '.vision-run-old')
    const newRun = path.join(root, '.vision-run-new')
    await mkdir(oldRun)
    await mkdir(newRun)
    await writeFile(path.join(oldRun, 'old.bin'), Buffer.alloc(8))
    await writeFile(path.join(newRun, 'new.bin'), Buffer.alloc(8))
    await utimes(oldRun, 1, 1)
    await utimes(newRun, 2, 2)

    const result = await cleanupArtifactRuns(root, {
      now: 2_500,
      ttlMs: 60_000,
      maxRuns: 512,
      maxBytes: 10,
      maxDiscoveryEntries: 64,
      maxScanEntries: 64,
      maxScanMs: 60_000,
      includeScanDiagnostics: true,
    })

    assert.equal(result.scan.discoveryComplete, true)
    assert.equal(result.scan.bytesComplete, true)
    assert.equal(result.removed, 1)
    assert.equal(await exists(oldRun), false)
    assert.equal(await exists(newRun), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('artifact retention depth limit preserves deeper managed content without treating unknown bytes as over-budget', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vision-retention-depth-'))
  try {
    const currentRun = path.join(root, '.vision-run-current')
    const deep = path.join(currentRun, 'a', 'b', 'c')
    await mkdir(deep, { recursive: true })
    await writeFile(path.join(deep, 'payload.bin'), Buffer.alloc(16))

    const result = await cleanupArtifactRuns(root, {
      ttlMs: 60_000,
      maxRuns: 512,
      maxBytes: 1,
      protectRunId: '.vision-run-current',
      maxDiscoveryEntries: 64,
      maxScanEntries: 64,
      maxScanDepth: 1,
      maxScanMs: 60_000,
      includeScanDiagnostics: true,
    })

    assert.equal(result.removed, 0)
    assert.equal(result.scan.discoveryComplete, true)
    assert.equal(result.scan.bytesComplete, false)
    assert.equal(await exists(path.join(deep, 'payload.bin')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
