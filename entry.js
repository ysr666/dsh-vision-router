// Public plugin entrypoint.
//
// Keep the large implementation in index.js, but normalize the progressive
// tools switch here before Cordis reads the exported Config. Issue #81 showed
// that changing the tool schema mid-session can invalidate provider prefix/KV
// caches for very long conversations, so progressive exposure is now an
// explicit opt-in rather than the implicit fallback.

import z from '@deepseek-ai/schemastery'
import * as core from './index.js'
import { installVisionRouterFileLogging } from './lib/file-logger.js'
import { contextWithDelegatedReplay } from './lib/replay-delegation.js'
import { contextWithReplayEnvelopeV2Compat } from './lib/replay-envelope-v2-compat.js'
import { contextWithVisionExecutionPolicy } from './lib/vision-execution-policy.js'
import { contextWithVisionBackendRuntimePolicy } from './lib/vision-backend-runtime-policy.js'
import { contextWithNativeImageCoexistence } from './lib/native-image-coexistence.js'
import { installLegacyCoreVisionPolicyBridge } from './lib/legacy-core-vision-policy-bridge.js'
import { installPiAiBridgeWireCompat } from './lib/pi-ai-bridge-wire-compat.js'
import { installLiveModelDiscovery } from './lib/live-model-discovery.js'
import { installVisionModelRegistry } from './lib/vision-model-registry.js'
import { installStrictLiveModelClientPrelude } from './lib/strict-live-model-client-prelude.js'
import { installWrapperScopeClientPrelude } from './lib/wrapper-scope-client-prelude.js'
import { installClientPresentationBoundary } from './lib/client-presentation-boundary.js'
import { installGuideVisionToggleHighlight } from './lib/guide-vision-toggle-highlight.js'
import { installVisionModelVisibilityBoundary } from './lib/vision-model-visibility-boundary.js'
import { installAdversarialHardening } from './lib/adversarial-hardening.js'
import { installOllamaColdStartGuard } from './lib/ollama-cold-start.js'
import { installLocalVisionStabilizer } from './lib/local-vision-stabilizer.js'
import { installWrapperDirectoryAlias } from './lib/wrapper-directory.js'
import { installAndroidAttachmentCompat } from './lib/android-attachment-compat.js'
import { contextWithCoalescedAdapterUpdates } from './lib/adapter-update-coalescer.js'
import { installTesseractExecFileCompat } from './lib/tesseract-exec-compat.js'
import { installLocalMutationRouteBoundary } from './lib/web-capability-boundary.js'
import { installScreenshotSourceBoundary } from './lib/screenshot-source-boundary.js'
import { installVisionToolRuntimeBoundary } from './lib/vision-tool-runtime-boundary.js'
import { installVisionRouterRemoteSettingsBridge } from './lib/remote-settings-bridge.js'
import { installSettingsRc8ClientLifecycle } from './lib/settings-client-rc8-lifecycle.js'
import { installCapabilityShadowRuntime } from './lib/vision-capability-shadow.js'
import { createCapabilityProfileStore } from './lib/vision-capability-probe.js'
import { installCapabilityBenchmarkService } from './lib/vision-capability-benchmark-service.js'
import { installCapabilityBenchmarkClient } from './lib/vision-capability-benchmark-client.js'
import { installVisionRoutingSettingsPrelude } from './lib/vision-routing-settings-prelude.js'
import { resolveVisionRoutingProduct } from './lib/vision-routing-product.js'
import {
  normalizeBackgroundMeasurementAuthority,
  resolveVisionRoutingAuthority,
} from './lib/vision-routing-authority.js'
import { withVisionCircuitBreakerObserver } from './lib/vision-breaker-observer.js'
import { createVisionBreakerShadowHealth } from './lib/vision-breaker-shadow-health.js'
import { installBackgroundCapabilityProfiling } from './lib/vision-background-benchmark.js'
import {
  contextWithVisionRuntimePerformance,
  createVisionRuntimePerformanceStore,
} from './lib/vision-runtime-performance.js'
import {
  installStructuredFlowHardening,
  normalizeGuidanceOverrides,
} from './lib/structured-flow-hardening.js'
import { installVisionLimitDiagnostics } from './lib/vision-limit-diagnostics.js'
import {
  attachmentContextForContract,
  hasBatchAttachmentContract,
  installHostSettingsCompatibility,
  installVisionAttachmentAdmissionPolicy,
  protectHostProviderOwnership,
} from './lib/dsh-contract-compat.js'

export const SETTINGS_CONTRACT_REVISION = 7

core.Config.set('progressiveTools', z.boolean().default(false))
core.Config.set('visionTaskTimeoutMs', z.number().step(1000).min(1000).max(180000).default(120000))
core.Config.set('visionTurnBudgetMs', z.number().step(1000).min(0).max(600000).default(0))
core.Config.set('visionDepth', z.union(['fast', 'standard', 'deep', 'custom']).default('standard'))
core.Config.set('visionDepthMaxCalls', z.number().step(1).min(0).max(100).default(0))
core.Config.set('routingMode', z.union(['ordered', 'auto']).default('ordered'))
core.Config.set(
  'routingPreference',
  z.union(['balanced', 'quality', 'speed', 'local']).default('balanced'),
)
core.Config.set(
  'backgroundBenchmarking',
  z.union(['local-free', 'all', 'off']).default('off'),
)
core.Config.set('allowRemoteSettings', z.boolean().default(false))
core.Config.set(
  'settingsContractRevision',
  z.number().step(1).min(1).max(SETTINGS_CONTRACT_REVISION).default(SETTINGS_CONTRACT_REVISION),
)

export * from './index.js'
export {
  attachmentContextForContract,
  ensureVisionAttachmentAdmissionPolicy,
  hasBatchAttachmentContract,
  installHostSettingsCompatibility,
  installVisionAttachmentAdmissionPolicy,
  protectHostProviderOwnership,
  installRc7SettingsCompatibility,
  isRc7ContractRuntime,
  protectRc7ProviderOwnership,
} from './lib/dsh-contract-compat.js'
export const Config = core.Config

export function apply(ctx, config = {}) {
  const localMutationCtx = installLocalMutationRouteBoundary(ctx)
  const adapterContractCtx = contextWithCoalescedAdapterUpdates(localMutationCtx)
  const logging = installVisionRouterFileLogging(adapterContractCtx)
  const capabilityStore = createCapabilityProfileStore({ logger: logging.logger })
  const runtimePerformanceStore = createVisionRuntimePerformanceStore()
  const delegatedReplayCtx = contextWithDelegatedReplay(logging.ctx, {
    wrapperRoute:
      typeof config.wrapperRoute === 'string' && config.wrapperRoute !== ''
        ? config.wrapperRoute
        : 'deepseek-vision',
    visionConfig: config,
  })
  const runtimeCtx = contextWithReplayEnvelopeV2Compat(delegatedReplayCtx)
  const screenshotSourceCtx = installScreenshotSourceBoundary(runtimeCtx, core)
  const { ctx: hardenedCtx, config: hardenedConfig } = installAdversarialHardening(
    screenshotSourceCtx,
    config,
    core,
  )
  const ollamaColdStartCtx = installOllamaColdStartGuard(hardenedCtx, hardenedConfig, core)
  const { ctx: stabilizedCtx, bootConfig } = installLocalVisionStabilizer(
    ollamaColdStartCtx,
    hardenedConfig,
    core,
  )
  const routingProduct = resolveVisionRoutingProduct(bootConfig)
  const runtimeConfig = {
    ...bootConfig,
    routingMode: routingProduct.mode,
    routingPreference: routingProduct.preference,
    backgroundBenchmarking: normalizeBackgroundMeasurementAuthority(bootConfig.backgroundBenchmarking),
    progressiveTools: hardenedConfig.progressiveTools === true,
    guidanceOverrides: normalizeGuidanceOverrides(bootConfig.guidanceOverrides ?? hardenedConfig.guidanceOverrides),
    visionTaskTimeoutMs:
      Number.isFinite(Number(bootConfig.visionTaskTimeoutMs))
        ? Number(bootConfig.visionTaskTimeoutMs)
        : 120000,
    visionTurnBudgetMs:
      Number.isFinite(Number(bootConfig.visionTurnBudgetMs))
        ? Number(bootConfig.visionTurnBudgetMs)
        : 0,
  }
  const batchAttachmentHost = hasBatchAttachmentContract(stabilizedCtx)
  if (batchAttachmentHost) installVisionAttachmentAdmissionPolicy(stabilizedCtx, logging.logger)
  installVisionRouterRemoteSettingsBridge(stabilizedCtx, logging.logger)
  installSettingsRc8ClientLifecycle(stabilizedCtx)
  const ownershipCtx = batchAttachmentHost ? protectHostProviderOwnership(stabilizedCtx) : stabilizedCtx
  const settingsCtx = batchAttachmentHost
    ? installHostSettingsCompatibility(ownershipCtx, { ...runtimeConfig, stealth: false }, {
        namespace: 'vision-router',
        Config: core.Config,
      })
    : ownershipCtx
  const attachmentCompatCtx = attachmentContextForContract(settingsCtx, logging.logger, {
    installAndroidAttachmentCompat,
  })
  const toolRuntimeCtx = installVisionToolRuntimeBoundary(attachmentCompatCtx, runtimeConfig)
  const nativeImageCompat = contextWithNativeImageCoexistence(toolRuntimeCtx, runtimeConfig)
  const legacyCoreCompat = installLegacyCoreVisionPolicyBridge(
    nativeImageCompat.ctx,
    nativeImageCompat.config,
    { rewriteHistoryImages: core.rewriteHistoryImages },
  )
  // Keep #220/#295 wall-clock semantics untouched. This outer observer only
  // adds the effective limit/source to diagnostics and rewrites the synthetic
  // guard copy after the structured-flow boundary has made its decision.
  const limitDiagnosticCtx = installVisionLimitDiagnostics(
    legacyCoreCompat.ctx,
    legacyCoreCompat.config,
    logging.logger,
  )
  const structuredCtx = installStructuredFlowHardening(limitDiagnosticCtx, legacyCoreCompat.config)
  const backgroundProfiling = installBackgroundCapabilityProfiling(
    structuredCtx,
    runtimeConfig,
    core,
    capabilityStore,
    { logger: logging.logger },
  )
  const breakerShadowHealth = createVisionBreakerShadowHealth(backgroundProfiling.ctx)
  const capabilityShadowCtx = installCapabilityShadowRuntime(
    backgroundProfiling.ctx,
    runtimeConfig,
    core,
    {
      logger: logging.logger,
      store: capabilityStore,
      runtimePerformanceStore,
      healthForCandidate: breakerShadowHealth.healthForCandidate,
    },
  )
  const reconciledCtx = capabilityShadowCtx
  const liveDiscovery = installLiveModelDiscovery(reconciledCtx, {
    config: runtimeConfig,
    logger: logging.logger,
  })
  installVisionModelRegistry(reconciledCtx, liveDiscovery, { config: runtimeConfig })
  installClientPresentationBoundary(reconciledCtx)
  installGuideVisionToggleHighlight(reconciledCtx)
  installVisionModelVisibilityBoundary(reconciledCtx)
  installStrictLiveModelClientPrelude(reconciledCtx)
  installWrapperScopeClientPrelude(reconciledCtx)
  installVisionRoutingSettingsPrelude(reconciledCtx)
  installCapabilityBenchmarkClient(reconciledCtx)
  installPiAiBridgeWireCompat(reconciledCtx, logging.logger)
  const executionCtx = contextWithVisionExecutionPolicy(reconciledCtx, {
    isBridgeEvidence: (provider, model) => liveDiscovery.hasModel(provider, model),
    evidenceSource: (provider, model) => liveDiscovery.evidenceSource?.(provider, model),
    logger: logging.logger,
  })
  const performanceCtx = contextWithVisionRuntimePerformance(
    executionCtx,
    runtimePerformanceStore,
    {
      logger: logging.logger,
      observationAllowed() {
        try {
          const settings = executionCtx?.get?.('settings')
          const current = settings?.get?.('vision-router')
          if (!current || typeof current !== 'object' || Array.isArray(current)) return false
          return resolveVisionRoutingAuthority(current).ephemeralRuntimeObservation
        } catch {
          return false
        }
      },
    },
  )
  const backendRuntimeCtx = contextWithVisionBackendRuntimePolicy(performanceCtx, {
    config: runtimeConfig,
    core,
    evidenceSource: (provider, model) => liveDiscovery.evidenceSource?.(provider, model),
    logger: logging.logger,
  })
  installCapabilityBenchmarkService(backendRuntimeCtx, runtimeConfig, core, {
    logger: logging.logger,
    store: capabilityStore,
  })
  installTesseractExecFileCompat(backendRuntimeCtx)

  try {
    const c = hardenedConfig && typeof hardenedConfig === 'object' ? hardenedConfig : {}
    const local = c.localOllama && typeof c.localOllama === 'object' ? c.localOllama : {}
    const lms = c.localLmStudio && typeof c.localLmStudio === 'object' ? c.localLmStudio : {}
    logging.logger.info(
      'vision-router: base config summary — contract=%s instantDescribe=%s localDescribeStyle=%s localOllama=%s localLmStudio=%s',
      batchAttachmentHost ? 'batch-attachments' : 'single-attachment',
      c.instantDescribe === true ? 'on' : 'off',
      c.localDescribeStyle === 'structured' ? 'structured' : 'plain',
      local.enabled === true ? 'on' : 'off',
      lms.enabled === true ? 'on' : 'off',
    )
  } catch {
    /* diagnostics must never break apply */
  }
  try {
    const result = withVisionCircuitBreakerObserver(
      breakerShadowHealth.capture,
      () => core.apply(backendRuntimeCtx, legacyCoreCompat.config),
    )
    legacyCoreCompat.finishSchemaBootstrap()
    installWrapperDirectoryAlias(attachmentCompatCtx, runtimeConfig, logging.logger)
    if (result && typeof result.then === 'function') {
      return result.catch((error) => {
        logging.logger.error(
          'vision-router: plugin apply failed: %s',
          error && error.stack ? error.stack : error && error.message ? error.message : String(error),
        )
        throw error
      })
    }
    return result
  } catch (error) {
    legacyCoreCompat.finishSchemaBootstrap()
    logging.logger.error(
      'vision-router: plugin apply failed: %s',
      error && error.stack ? error.stack : error && error.message ? error.message : String(error),
    )
    throw error
  }
}