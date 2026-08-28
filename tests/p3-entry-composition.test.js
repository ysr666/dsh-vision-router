import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('P3-F keeps entry as a thin schema/export boundary', async () => {
  const entry = await readFile(new URL('../entry.js', import.meta.url), 'utf8')
  const imports = entry.match(/^import\s.+$/gm) ?? []

  assert.equal(imports.length, 3)
  assert.match(entry, /import z from '@deepseek-ai\/schemastery'/)
  assert.match(entry, /import \* as core from '.\/index\.js'/)
  assert.match(entry, /import \{ applyVisionRuntimeComposition \} from '.\/lib\/runtime-composition\.js'/)
  assert.match(entry, /export function apply\(ctx, config = \{\}\) \{\s*return applyVisionRuntimeComposition\(ctx, config, core\)\s*\}/s)
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
    'installSessionVisionIndexBoundary(',
    'installLegacyCoreVisionPolicyBridge(',
    'installVisionLimitDiagnostics(',
    'installStructuredFlowHardening(limitDiagnosticCtx, legacyCoreCompat.config)',
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
    'core.apply(backendRuntimeCtx, legacyCoreCompat.config)',
  ]

  let previous = -1
  for (const marker of ordered) {
    const at = source.indexOf(marker)
    assert.ok(at > previous, `${marker} must remain after the previous runtime boundary`)
    previous = at
  }

  assert.ok(
    source.split('\n').length < 400,
    'runtime composition must remain orchestration-sized rather than becoming a new monolith',
  )
  assert.doesNotMatch(source, /Config\.set\(|rankVisionCandidates\(|callOpenAICompatible\(|imageMemorySet\(/)
})
