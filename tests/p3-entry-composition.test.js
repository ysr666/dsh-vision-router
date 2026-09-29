import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

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
    'contextWithAgentRequestRouteAuthority(backendRuntimeCtx)',
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
  assert.match(source, /function createRuntimeOwners\(host, core\)/)
  assert.match(source, /function installRoutingAndHostProducts\(host, owners, core\)/)
  assert.match(source, /function installExecutionBoundaries\(host, owners, routing, core\)/)
  assert.match(source, /function applyMatureCoreBridge\(host, owners, routing, execution, core, runtime\)/)
  assert.match(
    source,
    /export function applyVisionRuntimeComposition\(ctx, config = \{\}, core, runtime = \{\}\) \{\s*const host = installHostAndSecurityBoundaries\(ctx, config, core\)\s*const owners = createRuntimeOwners\(host, core\)\s*const routing = installRoutingAndHostProducts\(host, owners, core\)\s*const execution = installExecutionBoundaries\(host, owners, routing, core\)\s*return applyMatureCoreBridge\(host, owners, routing, execution, core, runtime\)\s*\}/s,
    'the public composition entry must expose the five lifecycle phases directly',
  )
  assert.doesNotMatch(source, /Config\.set\(|rankVisionCandidates\(|callOpenAICompatible\(|imageMemorySet\(/)
})
