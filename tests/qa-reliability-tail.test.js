import assert from 'node:assert/strict'
import test from 'node:test'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  HttpEndpointRevisionTracker,
  LiveDescribeCache,
  ProxyDispatcherTracker,
} from '../lib/runtime-reliability.js'
import {
  cleanupArtifactRuns,
  isManagedArtifactRunName,
} from '../lib/artifact-retention.js'
import { writeArtifactFile } from '../lib/artifact-boundary.js'
import { runWithVisionTurnBudget } from '../lib/turn-budget-context.js'
import {
  DEFAULT_REPETITION_ANALYSIS_CHARS,
  detectRepetitionLoop,
  sampleForRepetition,
} from '../lib/repetition-guard.js'
import { installVisionToolRuntimeBoundary } from '../lib/vision-tool-runtime-boundary.js'

async function exists(target) {
  try { await access(target); return true } catch { return false }
}

test('live describe cache applies hot entry and TTL limits immediately', () => {
  const cache = new LiveDescribeCache({ maxEntries: 3, ttlMs: 1000 })
  cache.set('a', 'A', 0)
  cache.set('b', 'B', 10)
  cache.set('c', 'C', 20)
  assert.equal(cache.stats().entries, 3)

  cache.reconfigure({ maxEntries: 1, ttlMs: 1000 }, 30)
  assert.equal(cache.stats().entries, 1)
  assert.equal(cache.get('c', 30), 'C')
  assert.equal(cache.get('a', 30), undefined)

  cache.reconfigure({ maxEntries: 1, ttlMs: 5 }, 40)
  assert.equal(cache.stats().entries, 0, 'shorter live TTL must prune an existing entry')
})

test('runtime describe cache serves a hit and respects a live cache disable', async () => {
  let registered
  let watchCallback
  let calls = 0
  let config = {
    cache: true,
    cacheMaxEntries: 2,
    cacheTtlSeconds: 3600,
    httpProviders: [],
    proxy: '',
    proxyHosts: [],
  }
  const scope = {
    get() { return config },
    watch(callback) { watchCallback = callback; return () => {} },
  }
  const settingsChild = {
    settings: { register() { return scope } },
  }
  const ctx = {
    tools: { register(def) { registered = def; return () => {} } },
    get() { return undefined },
    inject(deps, callback) {
      if (deps.includes('settings')) return callback(settingsChild)
      return undefined
    },
    effect(factory) { return factory() },
  }
  const savedFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('ok')
    const wrapped = installVisionToolRuntimeBoundary(ctx)
    wrapped.inject(['settings'], (child) => {
      const live = child.settings.register('vision-router')
      live.watch(() => {})
    })
    wrapped.tools.register({
      name: 'vision_describe',
      async execute() { calls += 1; return `answer-${calls}` },
    })

    const args = { attachmentIds: ['sha256:a', 'sha256:b'], question: 'compare' }
    const first = await registered.execute(args, {})
    const second = await registered.execute(args, {})
    assert.equal(first, 'answer-1')
    assert.equal(second, 'answer-1')
    assert.equal(calls, 1)

    config = { ...config, cache: false }
    watchCallback?.()
    assert.equal(await registered.execute(args, {}), 'answer-2')
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = savedFetch
  }
})

test('HTTP endpoint edits rotate only the runtime provider identity', () => {
  const tracker = new HttpEndpointRevisionTracker()
  const original = { name: 'custom', model: 'vision', apiKeyEnv: 'KEY', baseURL: 'https://a.example/v1' }
  assert.equal(tracker.project([original])[0], original)

  const b = tracker.project([{ ...original, baseURL: 'https://b.example/v1' }])[0]
  assert.equal(b.name, 'custom~vr1')
  assert.equal(b.baseURL, 'https://b.example/v1')

  const bAgain = tracker.project([{ ...original, baseURL: 'https://b.example/v1' }])[0]
  assert.equal(bAgain.name, 'custom~vr1')

  const c = tracker.project([{ ...original, baseURL: 'https://c.example/v1' }])[0]
  assert.equal(c.name, 'custom~vr2')
})

test('proxy dispatcher tracker gracefully retires each replaced pool once', async () => {
  const closed = []
  const dispatcher = (name) => ({ async close() { closed.push(name) } })
  const a = dispatcher('a')
  const b = dispatcher('b')
  const c = dispatcher('c')
  const tracker = new ProxyDispatcherTracker()

  tracker.observe(a)
  tracker.observe(a)
  tracker.observe(b)
  tracker.observe(c)
  tracker.dispose()
  await tracker.drain()

  assert.deepEqual(closed.sort(), ['a', 'b', 'c'])
})

test('same artifact name in concurrent runs cannot overwrite or mix', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'vision-artifact-runs-'))
  try {
    const [a, b] = await Promise.all([
      runWithVisionTurnBudget({ artifactRunId: '.vision-run-a' }, () =>
        writeArtifactFile(workspace, '.dsh-vision-router/artifacts', 'ocr/chunk-01.png', Buffer.from('A'))),
      runWithVisionTurnBudget({ artifactRunId: '.vision-run-b' }, () =>
        writeArtifactFile(workspace, '.dsh-vision-router/artifacts', 'ocr/chunk-01.png', Buffer.from('B'))),
    ])
    assert.notEqual(a, b)
    assert.match(a, /\.vision-run-a/)
    assert.match(b, /\.vision-run-b/)
    assert.equal((await readFile(a)).toString(), 'A')
    assert.equal((await readFile(b)).toString(), 'B')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('artifact retention deletes only managed old runs and preserves unknown files/current run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vision-artifact-retention-'))
  try {
    const oldRun = path.join(root, '.vision-run-old')
    const currentRun = path.join(root, '.vision-run-current')
    const unknownDir = path.join(root, 'user-folder')
    await mkdir(oldRun)
    await mkdir(currentRun)
    await mkdir(unknownDir)
    await writeFile(path.join(oldRun, 'x.bin'), Buffer.alloc(32))
    await writeFile(path.join(currentRun, 'x.bin'), Buffer.alloc(32))
    await writeFile(path.join(unknownDir, 'keep.txt'), 'keep')
    await writeFile(path.join(root, 'legacy-output.png'), 'keep')
    const oldSeconds = 1000
    await utimes(oldRun, oldSeconds, oldSeconds)
    await utimes(currentRun, oldSeconds, oldSeconds)

    const result = await cleanupArtifactRuns(root, {
      now: (oldSeconds * 1000) + 10_000,
      ttlMs: 1000,
      maxRuns: 512,
      maxBytes: 1024 * 1024,
      protectRunId: '.vision-run-current',
    })
    assert.equal(result.removed, 1)
    assert.equal(await exists(oldRun), false)
    assert.equal(await exists(currentRun), true)
    assert.equal(await exists(unknownDir), true)
    assert.equal(await exists(path.join(root, 'legacy-output.png')), true)
    assert.equal(isManagedArtifactRunName('.vision-run-current'), true)
    assert.equal(isManagedArtifactRunName('../escape'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('repetition analysis is bounded and ignores legitimate numeric OCR repetition', () => {
  const numeric = '000123456789,987654321000\n'.repeat(20_000)
  assert.equal(detectRepetitionLoop(numeric), undefined)

  const huge = 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(50_000)
  const sampled = sampleForRepetition(huge)
  assert.ok(sampled.length <= DEFAULT_REPETITION_ANALYSIS_CHARS + 2)
})

test('bounded repetition guard still catches real language loops', () => {
  const loop = '網絡路由器互聯網路由器'.repeat(2000)
  const detected = detectRepetitionLoop(loop)
  assert.ok(detected)
  assert.equal(detected.looped, true)
  assert.match(detected.mode, /exact-period|consecutive-run|token-density/)
})
