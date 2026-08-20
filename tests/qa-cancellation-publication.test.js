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
