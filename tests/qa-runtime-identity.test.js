import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { installVisionToolRuntimeBoundary } from '../lib/vision-tool-runtime-boundary.js'

test('vision tool runtime boundary never proxies unrelated injected child contexts', () => {
  const webChild = { webServer: {}, effect() {} }
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer'])
      return callback(webChild)
    },
  }
  const wrapped = installVisionToolRuntimeBoundary(ctx)
  let seen
  wrapped.inject(['webServer'], (child) => { seen = child })
  assert.equal(seen, webChild, 'rc6 route/effect ownership depends on exact child identity')
})

test('entry installs tool runtime after host settings compatibility and before structured hardening', async () => {
  const source = await readFile(new URL('../entry.js', import.meta.url), 'utf8')
  const settingsAt = source.indexOf('const settingsCtx = batchAttachmentHost')
  const runtimeAt = source.indexOf('const toolRuntimeCtx = installVisionToolRuntimeBoundary(attachmentCompatCtx)')
  const structuredAt = source.indexOf('const structuredCtx = installStructuredFlowHardening(toolRuntimeCtx, runtimeConfig)')
  assert.ok(settingsAt >= 0)
  assert.ok(runtimeAt > settingsAt, 'runtime boundary must see rc7/rc8 host settings compatibility')
  assert.ok(structuredAt > runtimeAt, 'structured deadlines must run inside the runtime cancellation boundary')
})
