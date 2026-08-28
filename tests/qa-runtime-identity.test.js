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

test('P3 final composition keeps runtime order outside the thin public entry', async () => {
  const entry = await readFile(new URL('../entry.js', import.meta.url), 'utf8')
  const source = await readFile(new URL('../lib/runtime-composition.js', import.meta.url), 'utf8')

  assert.match(entry, /import \{ applyVisionRuntimeComposition \} from '.\/lib\/runtime-composition\.js'/)
  assert.match(entry, /return applyVisionRuntimeComposition\(ctx, config, core\)/)
  assert.doesNotMatch(entry, /installVisionRouterFileLogging|installVisionRoutingRuntime|installVisionWebIntegration/)

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
  const sessionRuntimeAt = source.indexOf(
    'const sessionVisionRuntime = createSessionVisionRuntime({',
  )
  const sessionIndexAt = source.indexOf(
    'const sessionIndexCtx = installSessionVisionIndexBoundary(',
  )
  const bridgeAt = source.indexOf(
    'const legacyCoreCompat = installLegacyCoreVisionPolicyBridge(',
  )
  const diagnosticsAt = source.indexOf(
    'const limitDiagnosticCtx = installVisionLimitDiagnostics(',
  )
  const structuredAt = source.indexOf(
    'const structuredCtx = installStructuredFlowHardening(limitDiagnosticCtx, legacyCoreCompat.config)',
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
  const coreApplyAt = source.indexOf('() => core.apply(')
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
  assert.ok(sessionRuntimeAt > nativeAt, 'explicit SessionVisionRuntime must consume the final session ownership context')
  assert.ok(sessionIndexAt > sessionRuntimeAt, 'the session index boundary must receive the explicit runtime owner')
  assert.ok(bridgeAt > sessionIndexAt, 'legacy core projection must consume the indexed session-scoped ownership policy')
  assert.ok(
    diagnosticsAt > bridgeAt,
    'limit diagnostics must observe only the final legacy-core policy view and may not become an execution policy itself',
  )
  assert.ok(
    structuredAt > diagnosticsAt,
    'structured deadlines must remain the semantic hardening layer outside the read-only limit diagnostics observer',
  )
  assert.ok(executionAt > structuredAt, 'adapter-observed bridge policy must wrap the fully hardened execution view')
  assert.ok(performanceAt > executionAt, 'runtime performance observation must wrap the actual adapter execution seam')
  assert.ok(
    backendRuntimeAt > performanceAt,
    'preflight image-delivery policy must remain outermost so direct bridges bypass runtime speed sampling',
  )
  assert.ok(coreApplyAt > backendRuntimeAt, 'core must receive the fully composed backend runtime context')
  assert.match(
    source.slice(coreApplyAt),
    /^\(\) => core\.apply\(\s*backendRuntimeCtx,\s*legacyCoreCompat\.config,\s*\{ sessionVision: sessionVisionRuntime \},?\s*\)/s,
    'core must receive the same explicit SessionVisionRuntime owner as the session index boundary',
  )
  assert.ok(finishAt > coreApplyAt, 'the temporary schema bootstrap projection ends immediately after core wiring')

  const afterAdapterContract = source.slice(adapterContractAt + 1)
  assert.equal(
    afterAdapterContract.includes('contextWithCoalescedAdapterUpdates(structuredCtx)'),
    false,
    'a second prepareCall/coalescer wrapper would capture a pre-wrapper stream again',
  )
})
