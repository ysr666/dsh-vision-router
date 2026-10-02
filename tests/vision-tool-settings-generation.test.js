import assert from 'node:assert/strict'
import test from 'node:test'

import { installVisionToolRuntimeBoundary } from '../lib/vision-tool-runtime-boundary.js'

/**
 * R11 regression: the settings-generation token must not make a
 * lifecycle-less context deaf to live Settings changes.
 *
 * The first token design only wrote runtime config when the scope had been
 * activated *with* a Cordis `effect()`. Contexts without `effect()` (harness
 * contexts, non-Cordis embeddings, the QA cancellation matrix) then kept the
 * boot config forever: a settings watch silently did nothing and a tool call
 * stayed on a stale `visionTaskTimeoutMs`. That is a correctness regression,
 * and it also made the owning test file hang because the aborted turn never
 * fired.
 *
 * A second contract is pinned here too: one Host scope must map to exactly one
 * wrapped proxy, so re-activation cannot stack lifecycle owners.
 */
function settingsFixture({ bootTimeoutMs = 1400 } = {}) {
  let registered
  let finishUnderlying
  const state = { config: { visionTaskTimeoutMs: bootTimeoutMs }, watchCallback: undefined }
  const scope = {
    get() { return state.config },
    watch(callback) { state.watchCallback = callback; return () => {} },
  }
  const ctx = {
    // Deliberately no `effect`: this context cannot own a Cordis generation.
    get(name) {
      if (name !== 'attachments') return undefined
      return { saveImage() { return new Promise((resolve) => { finishUnderlying = resolve }) } }
    },
    inject(dependencies, callback) {
      if (!dependencies.includes('settings')) return undefined
      return callback({ settings: { register() { return scope } } })
    },
    tools: {
      register(definition) { registered = definition; return () => {} },
    },
  }
  const wrapped = installVisionToolRuntimeBoundary(ctx, { visionTaskTimeoutMs: bootTimeoutMs })
  let childContext
  let wrappedScope
  wrapped.inject(['settings'], (child) => {
    childContext = child
    wrappedScope = child.settings.register('vision-router')
    wrappedScope.watch(() => {})
  })
  wrapped.tools.register({
    name: 'vision_present',
    async execute() {
      await wrapped.get('attachments').saveImage({ data: Buffer.from('png'), mediaType: 'image/png' })
      return 'late'
    },
  })
  return {
    childContext,
    scope,
    wrappedScope,
    update(value) { state.config = value; state.watchCallback?.() },
    execute: () => registered.execute({}, { agent: { session: { header: { cwd: '/workspace' } } } }),
    settleLate: () => finishUnderlying?.({ attachmentId: 'late' }),
  }
}

test('a lifecycle-less settings generation still publishes live config to the runtime', async () => {
  const fixture = settingsFixture()
  assert.deepEqual(fixture.wrappedScope.get(), { visionTaskTimeoutMs: 1400 })

  fixture.update({ visionTaskTimeoutMs: 30 })
  assert.deepEqual(
    fixture.wrappedScope.get(),
    { visionTaskTimeoutMs: 30 },
    'the wrapped settings scope must project the live value',
  )

  // AbortSignal.timeout() intentionally does not keep the event loop alive; a
  // real Host always has live handles, so hold one open for the deadline.
  const keepAlive = setInterval(() => {}, 1_000)
  const started = Date.now()
  try {
    await assert.rejects(fixture.execute(), (error) => error?.code === 'ABORT_ERR')
    assert.ok(
      Date.now() - started < 700,
      'the next tool invocation must honour the live deadline instead of the stale boot value',
    )
  } finally {
    fixture.settleLate()
    clearInterval(keepAlive)
  }
})

test('an unread settings document leaves the composition deadline in force', async () => {
  const fixture = settingsFixture({ bootTimeoutMs: 400 })
  const keepAlive = setInterval(() => {}, 1_000)
  const started = Date.now()
  try {
    await assert.rejects(fixture.execute(), (error) => error?.code === 'ABORT_ERR')
    const elapsed = Date.now() - started
    assert.ok(
      elapsed >= 350 && elapsed < 2_000,
      `an unread settings document must not change the composition deadline, saw ${elapsed}ms`,
    )
  } finally {
    fixture.settleLate()
    clearInterval(keepAlive)
  }
})

test('one Host scope maps to exactly one wrapped proxy', () => {
  const fixture = settingsFixture()
  assert.notEqual(fixture.wrappedScope, fixture.scope, 'the scope must be wrapped')
  assert.equal(
    fixture.childContext.settings.register('vision-router'),
    fixture.wrappedScope,
    're-registering the same scope must not create a second wrapper or lifecycle owner',
  )
})
