import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runCoreApplyLifecycle } from '../lib/core-apply-lifecycle.js'

test('P3-F keeps entry as a thin schema/export boundary', async () => {
  const entry = await readFile(new URL('../entry.js', import.meta.url), 'utf8')
  const imports = entry.match(/^import\s.+$/gm) ?? []

  assert.equal(imports.length, 3)
  assert.match(entry, /composePublicVisionConfig/)
  assert.match(entry, /from '.\/lib\/public-config\.js'/)
  assert.match(entry, /import \* as core from '.\/index\.js'/)
  assert.match(entry, /import \{ applyVisionRuntimeComposition \} from '.\/lib\/runtime-composition\.js'/)
  assert.match(entry, /export const Config = composePublicVisionConfig\(core\.Config\)/)
  assert.doesNotMatch(entry, /Config\.set\(/)
  assert.match(entry, /export function apply\(ctx, config = \{\}, runtime = \{\}\) \{\s*return applyVisionRuntimeComposition\(ctx, config, core, runtime\)\s*\}/s)
  assert.doesNotMatch(
    entry,
    /installVisionRouterFileLogging|installVisionRoutingRuntime|installVisionWebIntegration|contextWithVisionRuntimePerformance|core\.apply\(/,
  )
  assert.ok(entry.split('\n').length < 120, 'public entry must not grow back into runtime composition')
})

test('P3-F composition remains bounded and preserves the mature runtime sequence', async () => {
  const source = await readFile(new URL('../lib/runtime-composition.js', import.meta.url), 'utf8')
  const ordered = [
    'installLocalMutationRouteBoundary(ctx)',
    'contextWithCoalescedAdapterUpdates(localMutationCtx)',
    'installVisionRouterFileLogging(adapterContractCtx)',
    'installAdversarialHardening(',
    'installLocalVisionStabilizer(',
    'installVisionSettingsWebBoundary(stabilizedCtx, logging.logger)',
    'installHostSettingsCompatibility(',
    'installDshHostCapabilityDiagnostics(settingsCtx)',
    'installVisionToolRuntimeBoundary(attachmentCompatCtx, runtimeConfig)',
    'contextWithNativeImageCoexistence(toolRuntimeCtx, runtimeConfig)',
    'createCoreVisionSurfaceRuntime({',
    'createSessionVisionRuntime({',
    'installSessionVisionIndexBoundary(',
    'installLegacyCoreVisionPolicyBridge(',
    'installSessionVisionModeBoundary(',
    'installVisionLimitDiagnostics(',
    'installStructuredFlowHardening(',
    'installBackgroundCapabilityProfiling(',
    'installVisionRoutingRuntime(',
    'installLiveModelDiscovery(',
    'installVisionModelRegistry(',
    'installVisionWebIntegration(',
    'contextWithVisionExecutionPolicy(',
    'contextWithVisionRuntimePerformance(',
    'contextWithVisionBackendRuntimePolicy(',
    'installCapabilityBenchmarkService(',
    'installTesseractExecFileCompat(backendRuntimeCtx)',
    'contextWithAgentRequestRouteAuthority(backendRuntimeCtx, {',
    '() => core.apply(',
  ]

  let previous = -1
  for (const marker of ordered) {
    const at = source.indexOf(marker)
    assert.ok(at > previous, `${marker} must remain after the previous runtime boundary`)
    previous = at
  }

  assert.match(
    source,
    /\(\) => core\.apply\(\s*coreRequestAuthorityCtx,\s*sessionVisionModeCompat\.config,\s*\{[\s\S]*?sessionVision:\s*sessionVisionRuntime,[\s\S]*?coreVisionSurface:\s*coreVisionSurfaceRuntime,[\s\S]*?providerTransport:\s*runtime\?\.providerTransport,[\s\S]*?\},?\s*\)/,
    'core must receive the fully composed backend context plus request-handoff authority, Session Vision mode authority, and explicit SessionVisionRuntime/CoreVisionSurface/ProviderTransport owners',
  )
  assert.ok(
    source.split('\n').length < 500,
    'runtime composition must remain orchestration-sized rather than becoming a new monolith',
  )
  assert.match(source, /function installHostAndSecurityBoundaries\(ctx, config, core\)/)
  assert.doesNotMatch(
    source,
    /configureAgentRequestRouteAuthority/,
    'production composition must pass request-authority options explicitly instead of staging generation state in a module WeakMap',
  )
  assert.match(source, /function createRuntimeOwners\(host, core\)/)
  assert.match(source, /function installRoutingAndHostProducts\(host, owners, core\)/)
  assert.match(source, /function installExecutionBoundaries\(host, owners, routing, core, providerTransport\)/)
  assert.match(source, /function applyMatureCoreBridge\(host, owners, routing, execution, core, runtime\)/)
  assert.match(
    source,
    /contextWithVisionBackendRuntimePolicy\([\s\S]*?providerTransport,[\s\S]*?installCapabilityBenchmarkService\([\s\S]*?providerTransport,/,
    'execution boundaries must receive the explicit ProviderTransport capability without widening to the whole runtime bag',
  )
  assert.match(
    source,
    /export function applyVisionRuntimeComposition\(ctx, config = \{\}, core, runtime = \{\}\) \{\s*const host = installHostAndSecurityBoundaries\(ctx, config, core\)\s*const owners = createRuntimeOwners\(host, core\)\s*const routing = installRoutingAndHostProducts\(host, owners, core\)\s*const execution = installExecutionBoundaries\(host, owners, routing, core, runtime\?\.providerTransport\)\s*return applyMatureCoreBridge\(host, owners, routing, execution, core, runtime\)\s*\}/s,
    'the public composition entry must expose the five lifecycle phases directly',
  )
  assert.doesNotMatch(source, /Config\.set\(|rankVisionCandidates\(|callOpenAICompatible\(|imageMemorySet\(/)
})

test('Core apply lifecycle keeps synchronous success synchronous and completes once', () => {
  const events = []
  const result = runCoreApplyLifecycle(
    () => { events.push('apply'); return 'sync-result' },
    {
      onSuccess() { events.push('success') },
      onFailure() { events.push('failure') },
    },
  )

  assert.equal(result, 'sync-result')
  assert.deepEqual(events, ['apply', 'success'])
})

test('Core apply lifecycle closes a synchronous failure without changing the thrown error', () => {
  const error = new Error('sync apply failed')
  const events = []
  assert.throws(
    () => runCoreApplyLifecycle(
      () => { events.push('apply'); throw error },
      {
        onSuccess() { events.push('success') },
        onFailure(seen) { events.push('failure'); assert.equal(seen, error) },
      },
    ),
    (seen) => seen === error,
  )
  assert.deepEqual(events, ['apply', 'failure'])
})

test('Core apply lifecycle keeps schema bootstrap open until an async apply resolves', async () => {
  let resolveApply
  let schemaBootstrapping = true
  let finishCount = 0
  const events = []
  const pending = new Promise((resolve) => { resolveApply = resolve })

  const result = runCoreApplyLifecycle(
    () => {
      events.push(`apply:${schemaBootstrapping}`)
      return pending
    },
    {
      onSuccess() {
        events.push(`success:${schemaBootstrapping}`)
        if (schemaBootstrapping) {
          finishCount += 1
          schemaBootstrapping = false
        }
        events.push(`finished:${schemaBootstrapping}`)
      },
      onFailure() { events.push('failure') },
    },
  )

  assert.equal(schemaBootstrapping, true, 'async Core registration still owns the bootstrap window while pending')
  assert.equal(finishCount, 0)
  resolveApply('async-result')
  assert.equal(await result, 'async-result')
  assert.equal(schemaBootstrapping, false)
  assert.equal(finishCount, 1)
  assert.deepEqual(events, ['apply:true', 'success:true', 'finished:false'])
})

test('Core apply lifecycle rejects with the original async error and runs failure cleanup once', async () => {
  const error = new Error('async apply failed')
  let failureCount = 0
  let successCount = 0
  const result = runCoreApplyLifecycle(
    () => Promise.reject(error),
    {
      onSuccess() { successCount += 1 },
      onFailure(seen) { failureCount += 1; assert.equal(seen, error) },
    },
  )

  await assert.rejects(result, (seen) => seen === error)
  assert.equal(successCount, 0)
  assert.equal(failureCount, 1)
})

test('Core apply lifecycle routes post-Core installer failure through the same failure path', async () => {
  const error = new Error('post-Core install failed')
  let failureCount = 0
  const result = runCoreApplyLifecycle(
    () => Promise.resolve('registered'),
    {
      onSuccess() { throw error },
      onFailure(seen) { failureCount += 1; assert.equal(seen, error) },
    },
  )

  await assert.rejects(result, (seen) => seen === error)
  assert.equal(failureCount, 1)
})
test('Core apply lifecycle can close schema bootstrap exactly once when a later post-Core installer fails', async () => {
  const error = new Error('wrapper alias install failed')
  let closed = false
  let finishCount = 0
  const finishOnce = () => {
    if (closed) return
    closed = true
    finishCount += 1
  }
  const result = runCoreApplyLifecycle(
    () => Promise.resolve('registered'),
    {
      onSuccess() {
        finishOnce()
        throw error
      },
      onFailure(seen) {
        assert.equal(seen, error)
        finishOnce()
      },
    },
  )

  await assert.rejects(result, (seen) => seen === error)
  assert.equal(finishCount, 1)
})
