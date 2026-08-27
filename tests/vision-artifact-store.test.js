import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
} from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { writeArtifactFile } from '../lib/artifact-boundary.js'
import { cleanupArtifactRuns } from '../lib/artifact-retention.js'
import { createVisionArtifactStore } from '../lib/vision-artifact-store.js'
import { runWithVisionTurnBudget } from '../lib/turn-budget-context.js'

async function withTempDir(prefix, fn) {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function relativeToWorkspace(workspace, target) {
  return path.relative(workspace, target).split(path.sep).join('/')
}

test('VisionArtifactStore publish preserves the hardened writer path, bytes and return contract', async () => {
  await withTempDir('dvr-artifact-store-', async (root) => {
    const legacyWorkspace = path.join(root, 'legacy')
    const facadeWorkspace = path.join(root, 'facade')
    await mkdir(legacyWorkspace)
    await mkdir(facadeWorkspace)

    const data = Buffer.from('p2-artifact-parity')
    const relativePath = 'nested/output.txt'
    const legacy = await writeArtifactFile(
      legacyWorkspace,
      '.dsh-vision-router/artifacts',
      relativePath,
      data,
    )
    const store = createVisionArtifactStore({
      workspace: facadeWorkspace,
      artifactsDir: '.dsh-vision-router/artifacts',
    })
    const next = await store.publish(relativePath, data)

    assert.equal(
      relativeToWorkspace(legacyWorkspace, legacy),
      relativeToWorkspace(facadeWorkspace, next),
    )
    assert.deepEqual(await readFile(next), data)
    assert.deepEqual(await readFile(legacy), data)
  })
})

test('VisionArtifactStore reads live workspace/artifactsDir values instead of capturing stale settings', async () => {
  await withTempDir('dvr-artifact-live-', async (root) => {
    const first = path.join(root, 'first')
    const second = path.join(root, 'second')
    await mkdir(first)
    await mkdir(second)
    let workspace = first
    let artifactsDir = 'artifacts-a'
    const store = createVisionArtifactStore({
      workspace: () => workspace,
      artifactsDir: () => artifactsDir,
    })

    const a = await store.publish('a.txt', 'a')
    workspace = second
    artifactsDir = 'artifacts-b'
    const b = await store.publish('b.txt', 'b')

    assert.equal(relativeToWorkspace(first, a), 'artifacts-a/a.txt')
    assert.equal(relativeToWorkspace(second, b), 'artifacts-b/b.txt')
  })
})

test('publishTemporary keeps the current managed-run layout exactly unchanged during P2-A', async () => {
  await withTempDir('dvr-artifact-temp-', async (root) => {
    const runId = '.vision-run-p2-parity'
    const store = createVisionArtifactStore({
      workspace: root,
      artifactsDir: 'artifacts',
    })
    const target = await runWithVisionTurnBudget(
      { artifactRunId: runId },
      () => store.publishTemporary('preview.png', Buffer.from('png')),
    )

    assert.equal(relativeToWorkspace(root, target), `artifacts/${runId}/preview.png`)
    assert.deepEqual(await readFile(target), Buffer.from('png'))
  })
})

test('facade resolve/publish retain the existing traversal and symlink safety policy', async () => {
  await withTempDir('dvr-artifact-security-', async (root) => {
    const outside = path.join(root, 'outside')
    const workspace = path.join(root, 'workspace')
    await mkdir(outside)
    await mkdir(workspace)
    const store = createVisionArtifactStore({ workspace, artifactsDir: 'artifacts' })

    await assert.rejects(
      () => store.resolve('../escape.txt'),
      /artifact path must stay inside|artifact target must stay inside/,
    )

    const artifacts = path.join(workspace, 'artifacts')
    await mkdir(artifacts)
    await symlink(outside, path.join(artifacts, 'linked'))
    await assert.rejects(
      () => store.publish('linked/escape.txt', 'nope'),
      /escapes the session workspace through a symlink/,
    )
  })
})

test('facade run ownership protects an active run until release', async () => {
  await withTempDir('dvr-artifact-retain-', async (root) => {
    const runId = '.vision-run-p2-active'
    const target = path.join(root, runId)
    await mkdir(target)
    const old = new Date(Date.now() - 60_000)
    await utimes(target, old, old)

    const store = createVisionArtifactStore({ workspace: root, artifactsDir: '.' })
    const release = store.retainRun(runId)
    try {
      const protectedCleanup = await cleanupArtifactRuns(root, {
        ttlMs: 1,
        now: Date.now(),
      })
      assert.equal(protectedCleanup.removed, 0)
      assert.equal((await lstat(target)).isDirectory(), true)
    } finally {
      release()
    }

    const afterRelease = await cleanupArtifactRuns(root, {
      ttlMs: 1,
      now: Date.now(),
    })
    assert.equal(afterRelease.removed, 1)
    await assert.rejects(() => lstat(target), { code: 'ENOENT' })
  })
})
