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

test('entry keeps prepareCall, tool runtime, session policy bridge, structured hardening, runtime observation and backend runtime policy in final order', async () => {
  const source = await readFile(new URL('../entry.js', import.meta.url), 'utf8')
  const mutationAt = source.indexOf('const localMutationCtx = installLocalMutationRouteBoundary(ctx)')
  const adapterContractAt = source.indexOf(
    'const adapterContractCtx = contextWithCoalescedAdapterUpdates(localMutationCtx)',
  )
  const loggingAt = source.indexOf('const logging = installVisionRouterFileLogging(adapterContractCtx)')
  const settingsAt = source.indexOf('const settingsCtx = batchAttachmentHost')
  const runtimeAt = source.indexOf(
    'const toolRuntimeCtx = installVisionToolRuntimeBoundary(attachmentCompatCtx, runtimeConfig)',
  )
  const nativeAt = source.indexOf(
    'const nativeImageCompat = contextWithNativeImageCoexistence(toolRuntimeCtx, runtimeConfig)',
  )
  const bridgeAt = source.indexOf(
    'const legacyCoreCompat = installLegacyCoreVisionPolicyBridge(',
  )
  const structuredAt = source.indexOf(
    'const structuredCtx = installStructuredFlowHardening(legacyCoreCompat.ctx, legacyCoreCompat.config)',
  )
  const executionAt = source.indexOf(
    'const executionCtx = contextWithVisionExecutionPolicy(reconciledCtx, {',
  )
  const performanceAt = source.indexOf(
    'const performanceCtx = contextWithVisionRuntimePerformance(',
  )
  const backendRuntimeAt = source.indexOf(
    'const backendRuntimeCtx = contextWithVisionBackendRuntimePolicy(performanceCtx, {',
  )
  const coreApplyAt = source.indexOf('() => core.apply(backendRuntimeCtx, legacyCoreCompat.config)')
  const finishAt = source.indexOf('legacyCoreCompat.finishSchemaBootstrap()', coreApplyAt)

  assert.ok(mutationAt >= 0)
  assert.ok(
    adapterContractAt > mutationAt,
    'prepareCall normalization must sit at the deepest private Host-registration boundary',
  )
  assert.ok(loggingAt > adapterContractAt, 'all later adapter wrappers must register through the final contract boundary')
  assert.ok(settingsAt > loggingAt)
  assert.ok(runtimeAt > settingsAt, 'runtime boundary must see rc7/rc8 host settings compatibility')
  assert.ok(nativeAt > runtimeAt, 'session image ownership must run inside live tool/cancellation policy')
  assert.ok(bridgeAt > nativeAt, 'legacy core projection must consume the session-scoped ownership policy')
  assert.ok(structuredAt > bridgeAt, 'structured deadlines must wrap the final core-policy view')
  assert.ok(executionAt > structuredAt, 'adapter-observed bridge policy must wrap the fully hardened execution view')
  assert.ok(performanceAt > executionAt, 'runtime performance observation must wrap the actual adapter execution seam')
  assert.ok(
    backendRuntimeAt > performanceAt,
    'preflight image-delivery policy must remain outermost so direct bridges bypass runtime speed sampling',
  )
  assert.ok(coreApplyAt > backendRuntimeAt, 'core must receive the fully composed backend runtime context')
  assert.ok(finishAt > coreApplyAt, 'the temporary schema bootstrap projection ends immediately after core wiring')

  const afterAdapterContract = source.slice(adapterContractAt + 1)
  assert.equal(
    afterAdapterContract.includes('contextWithCoalescedAdapterUpdates(structuredCtx)'),
    false,
    'a second prepareCall/coalescer wrapper would capture a pre-wrapper stream again',
  )
})
