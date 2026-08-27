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
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { writeArtifactFile as compatibilityWriteArtifactFile } from '../lib/artifact-boundary.js'
import {
  ARTIFACT_RUNS_DIR,
  writeArtifactFile as primitiveWriteArtifactFile,
} from '../lib/artifact-io.js'
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

test('VisionArtifactStore publish preserves the hardened writer path, bytes and return contract outside a managed run', async () => {
  await withTempDir('dvr-artifact-store-', async (root) => {
    const primitiveWorkspace = path.join(root, 'primitive')
    const facadeWorkspace = path.join(root, 'facade')
    await mkdir(primitiveWorkspace)
    await mkdir(facadeWorkspace)

    const data = Buffer.from('p2-artifact-parity')
    const relativePath = 'nested/output.txt'
    const primitive = await primitiveWriteArtifactFile(
      primitiveWorkspace,
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
      relativeToWorkspace(primitiveWorkspace, primitive),
      relativeToWorkspace(facadeWorkspace, next),
    )
    assert.deepEqual(await readFile(next), data)
    await assert.rejects(
      () => lstat(path.join(facadeWorkspace, '.dsh-vision-router/artifacts', ARTIFACT_RUNS_DIR)),
      { code: 'ENOENT' },
    )
  })
})

test('legacy artifact boundary remains behavior-compatible after becoming a store shim', async () => {
  await withTempDir('dvr-artifact-shim-', async (root) => {
    const primitiveWorkspace = path.join(root, 'primitive')
    const shimWorkspace = path.join(root, 'shim')
    await mkdir(primitiveWorkspace)
    await mkdir(shimWorkspace)

    const data = Buffer.from('compatibility-shim')
    const relativePath = 'nested/compat.txt'
    const primitive = await primitiveWriteArtifactFile(
      primitiveWorkspace,
      'artifacts',
      relativePath,
      data,
    )
    const shim = await compatibilityWriteArtifactFile(
      shimWorkspace,
      'artifacts',
      relativePath,
      data,
    )

    assert.equal(
      relativeToWorkspace(primitiveWorkspace, primitive),
      relativeToWorkspace(shimWorkspace, shim),
    )
    assert.deepEqual(await readFile(shim), data)
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

test('managed run publication is isolated under the .runs namespace', async () => {
  await withTempDir('dvr-artifact-temp-', async (root) => {
    const runId = '.vision-run-p2-parity'
    const store = createVisionArtifactStore({ workspace: root, artifactsDir: 'artifacts' })
    const target = await runWithVisionTurnBudget(
      { artifactRunId: runId },
      () => store.publishTemporary('preview.png', Buffer.from('png')),
    )

    assert.equal(
      relativeToWorkspace(root, target),
      `artifacts/${ARTIFACT_RUNS_DIR}/${runId}/preview.png`,
    )
    assert.deepEqual(await readFile(target), Buffer.from('png'))
    await assert.rejects(() => lstat(path.join(root, 'artifacts', runId)), { code: 'ENOENT' })
  })
})

test('managed .runs namespace rejects symlink ownership even when the link stays inside the workspace', async () => {
  await withTempDir('dvr-artifact-runs-link-', async (root) => {
    const artifacts = path.join(root, 'artifacts')
    const redirected = path.join(root, 'redirected-runs')
    await mkdir(artifacts)
    await mkdir(redirected)
    await symlink(redirected, path.join(artifacts, ARTIFACT_RUNS_DIR), 'dir')

    const store = createVisionArtifactStore({ workspace: root, artifactsDir: 'artifacts' })
    await assert.rejects(
      () => runWithVisionTurnBudget(
        { artifactRunId: '.vision-run-p2-symlink' },
        () => store.publishTemporary('escape.png', Buffer.from('nope')),
      ),
      /managed artifact runs directory must not be a symlink/,
    )
    await assert.rejects(() => lstat(path.join(redirected, '.vision-run-p2-symlink')), { code: 'ENOENT' })
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

test('new .runs retention deletes only managed run directories and preserves unknown entries', async () => {
  await withTempDir('dvr-artifact-runs-retention-', async (root) => {
    const runsRoot = path.join(root, ARTIFACT_RUNS_DIR)
    const oldRun = path.join(runsRoot, '.vision-run-old')
    const unknownDir = path.join(runsRoot, 'user-folder')
    await mkdir(oldRun, { recursive: true })
    await mkdir(unknownDir)
    await writeFile(path.join(runsRoot, 'user-note.txt'), 'keep')
    const old = new Date(Date.now() - 60_000)
    await utimes(oldRun, old, old)

    const result = await cleanupArtifactRuns(runsRoot, { ttlMs: 1, now: Date.now() })
    assert.equal(result.removed, 1)
    await assert.rejects(() => lstat(oldRun), { code: 'ENOENT' })
    assert.equal((await lstat(unknownDir)).isDirectory(), true)
    assert.equal(await readFile(path.join(runsRoot, 'user-note.txt'), 'utf8'), 'keep')
  })
})

test('legacy direct managed runs still age out without touching the new .runs namespace', async () => {
  await withTempDir('dvr-artifact-legacy-retention-', async (root) => {
    const legacyRun = path.join(root, '.vision-run-legacy')
    const runsRoot = path.join(root, ARTIFACT_RUNS_DIR)
    await mkdir(legacyRun)
    await mkdir(runsRoot)
    await writeFile(path.join(runsRoot, 'marker.txt'), 'keep')
    const old = new Date(Date.now() - 60_000)
    await utimes(legacyRun, old, old)

    const result = await cleanupArtifactRuns(root, { ttlMs: 1, now: Date.now() })
    assert.equal(result.removed, 1)
    await assert.rejects(() => lstat(legacyRun), { code: 'ENOENT' })
    assert.equal(await readFile(path.join(runsRoot, 'marker.txt'), 'utf8'), 'keep')
  })
})

test('facade run ownership protects an active run inside .runs until release', async () => {
  await withTempDir('dvr-artifact-retain-', async (root) => {
    const runId = '.vision-run-p2-active'
    const runsRoot = path.join(root, ARTIFACT_RUNS_DIR)
    const target = path.join(runsRoot, runId)
    await mkdir(target, { recursive: true })
    const old = new Date(Date.now() - 60_000)
    await utimes(target, old, old)

    const store = createVisionArtifactStore({ workspace: root, artifactsDir: 'artifacts' })
    const release = store.retainRun(runId)
    try {
      const protectedCleanup = await cleanupArtifactRuns(runsRoot, {
        ttlMs: 1,
        now: Date.now(),
      })
      assert.equal(protectedCleanup.removed, 0)
      assert.equal((await lstat(target)).isDirectory(), true)
    } finally {
      release()
    }

    const afterRelease = await cleanupArtifactRuns(runsRoot, {
      ttlMs: 1,
      now: Date.now(),
    })
    assert.equal(afterRelease.removed, 1)
    await assert.rejects(() => lstat(target), { code: 'ENOENT' })
  })
})
