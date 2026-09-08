import assert from 'node:assert/strict'
import test from 'node:test'

import { writeArtifactFile } from '../lib/artifact-boundary.js'
import { runWithVisionTurnBudget } from '../lib/turn-budget-context.js'
import { installVisionToolRuntimeBoundary } from '../lib/vision-tool-runtime-boundary.js'

test('vision tool promise rejects promptly when the agent execution is cancelled', async () => {
  let registered
  let finishUnderlying
  const ctx = {
    tools: {
      register(def) {
        registered = def
        return () => {}
      },
    },
  }
  const wrapped = installVisionToolRuntimeBoundary(ctx)
  wrapped.tools.register({
    name: 'vision_colors',
    async execute() {
      return new Promise((resolve) => { finishUnderlying = resolve })
    },
  })

  const controller = new AbortController()
  const pending = registered.execute({}, {
    signal: controller.signal,
    agent: { session: { header: { cwd: '/workspace' } } },
  })
  await Promise.resolve()
  controller.abort()
  await assert.rejects(pending, (error) => error?.code === 'ABORT_ERR')
  // Clean up the intentionally detached fake native continuation.
  finishUnderlying?.('late')
})

test('vision task deadline releases a turn when an uncooperative Host attachment save never settles', { timeout: 2_000 }, async () => {
  let registered
  let finishUnderlying
  let observeLateSignal
  const lateSignal = new Promise((resolve) => { observeLateSignal = resolve })
  const attachments = {
    saveImage() {
      return new Promise((resolve) => { finishUnderlying = resolve })
    },
  }
  const ctx = {
    get(name) {
      return name === 'attachments' ? attachments : undefined
    },
    fs: {
      async readBytes(_target, signal) {
        observeLateSignal?.(signal)
        signal?.throwIfAborted?.()
        return Buffer.from('late')
      },
    },
    tools: {
      register(def) {
        registered = def
        return () => {}
      },
    },
  }
  const wrapped = installVisionToolRuntimeBoundary(ctx, { visionTaskTimeoutMs: 25 })
  wrapped.tools.register({
    name: 'vision_present',
    async execute() {
      await wrapped.get('attachments').saveImage({ data: Buffer.from('png'), mediaType: 'image/png' })
      await wrapped.fs.readBytes('late.png')
      return 'late-success'
    },
  })

  // AbortSignal.timeout() intentionally does not keep Node's event loop alive.
  // A real DSH Host has server/runtime handles; this isolated test otherwise has
  // only the deliberately never-settling Promise on Node 22, which would make
  // node:test exit before the deadline can fire. Keep one test-only handle live.
  const keepAlive = setInterval(() => {}, 1_000)
  try {
    await assert.rejects(
      registered.execute({}, { agent: { session: { header: { cwd: '/workspace' } } } }),
      (error) => error?.code === 'ABORT_ERR',
    )
    // The current Host contract cannot cancel saveImage itself. Drain the fake
    // continuation explicitly: the runtime promise has already released the turn
    // and no late completion may become an unhandled rejection.
    finishUnderlying?.({ attachmentId: 'late' })
    const signal = await lateSignal
    assert.equal(signal?.aborted, true, 'detached late continuation must inherit the spent task signal')
  } finally {
    clearInterval(keepAlive)
  }
})

test('live visionTaskTimeoutMs changes govern the next Host attachment save', { timeout: 2_500 }, async () => {
  let registered
  let watchCallback
  let finishUnderlying
  let config = { visionTaskTimeoutMs: 1_400 }
  const scope = {
    get() { return config },
    watch(callback) { watchCallback = callback; return () => {} },
  }
  const ctx = {
    get(name) {
      if (name !== 'attachments') return undefined
      return {
        saveImage() {
          return new Promise((resolve) => { finishUnderlying = resolve })
        },
      }
    },
    inject(deps, callback) {
      if (!deps.includes('settings')) return undefined
      return callback({ settings: { register() { return scope } } })
    },
    tools: {
      register(def) { registered = def; return () => {} },
    },
  }
  const wrapped = installVisionToolRuntimeBoundary(ctx)
  wrapped.inject(['settings'], (child) => {
    child.settings.register('vision-router').watch(() => {})
  })
  wrapped.tools.register({
    name: 'vision_present',
    async execute() {
      await wrapped.get('attachments').saveImage({ data: Buffer.from('png'), mediaType: 'image/png' })
      return 'late-success'
    },
  })

  config = { visionTaskTimeoutMs: 30 }
  watchCallback?.()

  const keepAlive = setInterval(() => {}, 1_000)
  const started = Date.now()
  try {
    await assert.rejects(
      registered.execute({}, { agent: { session: { header: { cwd: '/workspace' } } } }),
      (error) => error?.code === 'ABORT_ERR',
    )
    assert.ok(
      Date.now() - started < 700,
      'the next invocation must use the hot 30 ms deadline rather than the stale 1400 ms boot value',
    )
  } finally {
    finishUnderlying?.({ attachmentId: 'late' })
    clearInterval(keepAlive)
  }
})

test('cancelled vision work cannot publish a temp artifact to its final target', async () => {
  const controller = new AbortController()
  const events = []
  const deps = {
    async realpath(value) { return value },
    async mkdir() { events.push('mkdir') },
    async lstat() { return undefined },
    async writeFile() {
      events.push('write-temp')
      controller.abort()
    },
    async rename() { events.push('rename-final') },
    async unlink() { events.push('unlink-temp') },
  }

  await assert.rejects(
    runWithVisionTurnBudget({ signal: controller.signal }, () =>
      writeArtifactFile('/workspace', '.artifacts', 'result.png', Buffer.from('png'), deps),
    ),
    (error) => error?.code === 'ABORT_ERR',
  )
  assert.ok(events.includes('write-temp'))
  assert.equal(events.includes('rename-final'), false, 'aborted output must never reach the final artifact path')
  assert.ok(events.includes('unlink-temp'), 'temporary bytes should be cleaned up after cancellation')
})
