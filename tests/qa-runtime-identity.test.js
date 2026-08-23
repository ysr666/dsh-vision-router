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

test('vision_present registration accepts host originalDimensions without loosening strict output schema', () => {
  let registered
  const ctx = {
    tools: {
      register(def) {
        registered = def
        return () => {}
      },
    },
  }
  const wrapped = installVisionToolRuntimeBoundary(ctx)
  const original = {
    name: 'vision_present',
    output: {
      schema: {
        type: 'object',
        properties: {
          attachment: {
            type: 'object',
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string' },
              bytes: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              name: { type: 'string' },
            },
            required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
            additionalProperties: false,
          },
        },
        required: ['attachment'],
        additionalProperties: false,
      },
    },
    async execute() { return {} },
  }

  wrapped.tools.register(original)

  assert.ok(registered)
  const attachment = registered.output.schema.properties.attachment
  assert.equal(attachment.additionalProperties, false)
  assert.deepEqual(attachment.required, ['attachmentId', 'mediaType', 'bytes', 'width', 'height'])
  assert.equal(original.output.schema.properties.attachment.properties.originalDimensions, undefined)
  assert.deepEqual(attachment.properties.originalDimensions, {
    type: 'object',
    properties: {
      width: { type: 'integer' },
      height: { type: 'integer' },
    },
    required: ['width', 'height'],
    additionalProperties: false,
  })
  assert.equal(
    attachment.required.includes('originalDimensions'),
    false,
    'originalDimensions is optional and appears only when the host downsizes the image',
  )
})

test('entry keeps prepareCall, tool runtime, session policy bridge, structured hardening and backend runtime policy in final order', async () => {
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
  const backendRuntimeAt = source.indexOf(
    'const backendRuntimeCtx = contextWithVisionBackendRuntimePolicy(executionCtx, {',
  )
  const coreApplyAt = source.indexOf('const result = core.apply(backendRuntimeCtx, legacyCoreCompat.config)')
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
  assert.ok(backendRuntimeAt > executionAt, 'preflight image-delivery policy must sit outside adapter-observed bridge policy')
  assert.ok(coreApplyAt > backendRuntimeAt, 'core must receive the fully composed backend runtime context')
  assert.ok(finishAt > coreApplyAt, 'the temporary schema bootstrap projection ends immediately after core wiring')

  const afterAdapterContract = source.slice(adapterContractAt + 1)
  assert.equal(
    afterAdapterContract.includes('contextWithCoalescedAdapterUpdates(structuredCtx)'),
    false,
    'a second prepareCall/coalescer wrapper would capture a pre-wrapper stream again',
  )
})
