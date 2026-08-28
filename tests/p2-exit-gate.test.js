import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { cleanupArtifactRuns, retainArtifactRun } from '../lib/artifact-retention.js'
import { ARTIFACT_RUNS_DIR } from '../lib/artifact-io.js'

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function withTempDir(prefix, fn) {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('P2 Exit Gate: .runs cleanup remains complete with many unknown root entries', async () => {
  await withTempDir('dvr-p2-exit-unknown-', async (root) => {
    const runsRoot = path.join(root, ARTIFACT_RUNS_DIR)
    await mkdir(runsRoot)

    // Deliberately place far more unknown/user entries than managed runs in the
    // same root. Discovery must examine them without treating them as owned or
    // allowing them to hide expired managed runs behind directory order.
    const unknownCount = 256
    for (let index = 0; index < unknownCount; index++) {
      if (index % 2 === 0) {
        await writeFile(path.join(runsRoot, `user-note-${index}.txt`), `keep-${index}`)
      } else {
        const dir = path.join(runsRoot, `user-folder-${index}`)
        await mkdir(dir)
        await writeFile(path.join(dir, 'keep.txt'), `keep-${index}`)
      }
    }

    const oldA = path.join(runsRoot, '.vision-run-old-a')
    const oldB = path.join(runsRoot, '.vision-run-old-b')
    await mkdir(oldA)
    await mkdir(oldB)
    await writeFile(path.join(oldA, 'a.bin'), 'a')
    await writeFile(path.join(oldB, 'b.bin'), 'b')
    await utimes(oldA, 1, 1)
    await utimes(oldB, 1, 1)

    const result = await cleanupArtifactRuns(runsRoot, {
      now: 10_000,
      ttlMs: 1_000,
      maxRuns: 512,
      maxBytes: 1024 * 1024,
      maxDiscoveryEntries: 1_024,
      maxScanEntries: 1_024,
      maxScanMs: 60_000,
      includeScanDiagnostics: true,
    })

    assert.equal(result.scan.discoveryComplete, true)
    assert.equal(result.scanned, 2, 'only managed run directories count as owned runs')
    assert.equal(result.removed, 2, 'all expired managed runs must be found despite unknown-entry noise')
    assert.equal(await exists(oldA), false)
    assert.equal(await exists(oldB), false)

    for (let index = 0; index < unknownCount; index++) {
      if (index % 2 === 0) {
        assert.equal(
          await readFile(path.join(runsRoot, `user-note-${index}.txt`), 'utf8'),
          `keep-${index}`,
        )
      } else {
        assert.equal(
          await readFile(path.join(runsRoot, `user-folder-${index}`, 'keep.txt'), 'utf8'),
          `keep-${index}`,
        )
      }
    }
  })
})

test('P2 Exit Gate: an active run is never removed by TTL, maxRuns or maxBytes pressure', async () => {
  await withTempDir('dvr-p2-exit-active-', async (root) => {
    const activeName = '.vision-run-active'
    const staleName = '.vision-run-stale'
    const active = path.join(root, activeName)
    const stale = path.join(root, staleName)
    await mkdir(active)
    await mkdir(stale)
    await writeFile(path.join(active, 'large.bin'), Buffer.alloc(64))
    await writeFile(path.join(stale, 'small.bin'), Buffer.alloc(8))
    await utimes(active, 1, 1)
    await utimes(stale, 1, 1)

    const release = retainArtifactRun(activeName)
    try {
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
      assert.equal(await exists(active), true)
      assert.equal(await exists(stale), false)
      assert.equal(result.removed, 1)
    } finally {
      release()
    }
  })
})

test('P2 Exit Gate: legacy direct managed artifacts can age out while the new .runs namespace is preserved', async () => {
  await withTempDir('dvr-p2-exit-legacy-', async (root) => {
    const legacy = path.join(root, '.vision-run-legacy')
    const runsRoot = path.join(root, ARTIFACT_RUNS_DIR)
    await mkdir(legacy)
    await mkdir(runsRoot)
    await writeFile(path.join(legacy, 'legacy.bin'), 'old')
    await writeFile(path.join(runsRoot, 'user-marker.txt'), 'keep')
    await utimes(legacy, 1, 1)

    const result = await cleanupArtifactRuns(root, {
      now: 10_000,
      ttlMs: 1_000,
      maxRuns: 512,
      maxBytes: 1024 * 1024,
      maxDiscoveryEntries: 64,
      maxScanEntries: 64,
      maxScanMs: 60_000,
      includeScanDiagnostics: true,
    })

    assert.equal(result.removed, 1)
    assert.equal(await exists(legacy), false)
    assert.equal(await readFile(path.join(runsRoot, 'user-marker.txt'), 'utf8'), 'keep')
  })
})
