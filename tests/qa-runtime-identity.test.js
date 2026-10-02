import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  getVisionToolRuntimeState,
  installVisionToolRuntimeBoundary,
} from '../lib/vision-tool-runtime-boundary.js'

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
  assert.match(entry, /return applyVisionRuntimeComposition\(ctx, config, core, runtime\)/)
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
  const coreSurfaceRuntimeAt = source.indexOf(
    'const coreVisionSurfaceRuntime = createCoreVisionSurfaceRuntime({',
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
  const sessionModeAt = source.indexOf(
    'const sessionVisionModeCompat = installSessionVisionModeBoundary(',
  )
  const diagnosticsAt = source.indexOf(
    'const limitDiagnosticCtx = installVisionLimitDiagnostics(',
  )
  const structuredAt = source.indexOf(
    'const structuredCtx = installStructuredFlowHardening(',
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
  const requestAuthorityAt = source.indexOf(
    'const coreRequestAuthorityCtx = contextWithAgentRequestRouteAuthority(backendRuntimeCtx, {',
  )
  const coreApplyAt = source.indexOf('() => core.apply(')
  const finishOnceAt = source.indexOf('const finishSchemaBootstrapOnce = () => {')
  const successLifecycleAt = source.indexOf('const installPostCoreRuntime = () => {')
  const failureLifecycleAt = source.indexOf('const failCoreApply = (error) => {')

  assert.ok(mutationAt >= 0)
  assert.ok(
    adapterContractAt > mutationAt,
    'prepareCall normalization must sit at the deepest private Host-registration boundary',
  )
  assert.ok(loggingAt > adapterContractAt, 'all later adapter wrappers must register through the final contract boundary')
  assert.ok(settingsAt > loggingAt)
  assert.ok(runtimeAt > settingsAt, 'runtime boundary must see rc7/rc8 host settings compatibility')
  assert.ok(nativeAt > runtimeAt, 'session image ownership must run inside live tool/cancellation policy')
  assert.ok(
    coreSurfaceRuntimeAt > nativeAt,
    'explicit CoreVisionSurfaceRuntime must consume the final session ownership context',
  )
  assert.ok(
    sessionRuntimeAt > coreSurfaceRuntimeAt,
    'explicit SessionVisionRuntime must remain alongside the CoreVisionSurface owner',
  )
  assert.ok(sessionIndexAt > sessionRuntimeAt, 'the session index boundary must receive the explicit runtime owner')
  assert.ok(
    bridgeAt > sessionIndexAt,
    'the retained pre-step compatibility boundary must consume the indexed session-scoped ownership policy',
  )
  assert.ok(
    sessionModeAt > bridgeAt,
    'Session Vision mode authority must remain outside the retired identity-only compatibility bridge',
  )
  assert.ok(
    diagnosticsAt > sessionModeAt,
    'limit diagnostics must observe the Session mode boundary without becoming an execution policy itself',
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
  assert.ok(
    requestAuthorityAt > backendRuntimeAt,
    'agent/request call-config projection must decorate only the final Core-facing request boundary',
  )
  assert.ok(coreApplyAt > requestAuthorityAt, 'core must receive the fully composed request-authority context')
  assert.match(
    source.slice(coreApplyAt),
    /^\(\) => core\.apply\(\s*coreRequestAuthorityCtx,\s*sessionVisionModeCompat\.config,\s*\{[\s\S]*?sessionVision:\s*sessionVisionRuntime,[\s\S]*?coreVisionSurface:\s*coreVisionSurfaceRuntime,[\s\S]*?\},?\s*\)/,
    'core must receive the explicit request-authority decorator plus the Session mode config and same runtime owners',
  )
  assert.ok(finishOnceAt >= 0, 'composition must expose one idempotent schema-bootstrap close helper')
  assert.ok(successLifecycleAt > finishOnceAt, 'post-Core success must use the explicit close helper')
  assert.ok(failureLifecycleAt > successLifecycleAt, 'Core failure cleanup must share the same close helper')
  assert.match(
    source.slice(successLifecycleAt, failureLifecycleAt),
    /installVisionMaintenanceRoutes\([\s\S]*?finishSchemaBootstrapOnce\(\)[\s\S]*?installWrapperDirectoryAlias\(/,
    'successful settlement must install maintenance, close schema bootstrap, then publish the wrapper alias',
  )
  assert.match(
    source.slice(failureLifecycleAt, coreApplyAt),
    /finishSchemaBootstrapOnce\(\)[\s\S]*?logging\.logger\.error\(/,
    'failure settlement must close schema bootstrap before logging and rethrowing the original error',
  )
  assert.equal(
    source.includes('legacyCoreCompat.finishSchemaBootstrap()'),
    false,
    'the pre-step compatibility boundary must not regain schema-bootstrap authority',
  )

  const afterAdapterContract = source.slice(adapterContractAt + 1)
  assert.equal(
    afterAdapterContract.includes('contextWithCoalescedAdapterUpdates(structuredCtx)'),
    false,
    'a second prepareCall/coalescer wrapper would capture a pre-wrapper stream again',
  )
})

test('vision tool runtime cache expires with the owning Cordis generation', () => {
  let cleanup
  const ctx = {
    effect(factory) { cleanup = factory() },
  }
  const first = installVisionToolRuntimeBoundary(ctx, { cache: false })
  assert.equal(installVisionToolRuntimeBoundary(ctx, { cache: true }), first)
  assert.equal(getVisionToolRuntimeState(first).config().cache, false)

  cleanup()
  const second = installVisionToolRuntimeBoundary(ctx, { cache: true })
  assert.notEqual(second, first)
  assert.equal(getVisionToolRuntimeState(second).config().cache, true)
})

test('vision tool runtime cache never pins a wrapper when effect registration fails', () => {
  const ctx = {
    effect() { throw new Error('inactive fiber') },
  }
  const first = installVisionToolRuntimeBoundary(ctx, { cache: false })
  const second = installVisionToolRuntimeBoundary(ctx, { cache: true })
  assert.notEqual(second, first)
})

test('tool runtime Settings projection is generation-tokened and late stale scope reads cannot republish config', () => {
  let childCleanup
  let lateWatch
  let liveConfig = { cache: false, cacheMaxEntries: 10, cacheTtlSeconds: 10, httpProviders: [] }
  const scope = {
    get() { return liveConfig },
    watch(callback) { lateWatch = callback; return () => {} },
  }
  const settingsChild = {
    settings: { register() { return scope } },
    effect(factory) { childCleanup = factory(); return childCleanup },
  }
  const ctx = {
    effect(factory) { this.outerCleanup = factory(); return this.outerCleanup },
    inject(dependencies, callback) {
      if (dependencies.includes('settings')) return callback(settingsChild)
    },
  }
  const wrapped = installVisionToolRuntimeBoundary(ctx, {
    cache: true,
    cacheMaxEntries: 200,
    cacheTtlSeconds: 3600,
    httpProviders: [],
  })
  let projectedScope
  wrapped.inject(['settings'], (child) => {
    projectedScope = child.settings.register('vision-router')
  })
  projectedScope.watch(() => {})

  const state = getVisionToolRuntimeState(wrapped)
  assert.equal(state.config().cache, false)

  childCleanup()
  assert.equal(state.config().cache, true, 'unload must restore the boot config')

  liveConfig = { cache: false, cacheMaxEntries: 1, cacheTtlSeconds: 1, httpProviders: [] }
  assert.equal(projectedScope.get().cache, false, 'stale caller still sees its own retired scope')
  assert.equal(state.config().cache, true, 'retired scope get() must not republish stale runtime config')

  lateWatch()
  assert.equal(state.config().cache, true, 'retired scope watch callback must not republish stale runtime config')
})
