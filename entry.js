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
import { contextWithNativeImageCoexistence } from './lib/native-image-coexistence.js'
import { installPiAiBridgeWireCompat } from './lib/pi-ai-bridge-wire-compat.js'
import { installLiveModelDiscovery } from './lib/live-model-discovery.js'
import { installVisionModelRegistry } from './lib/vision-model-registry.js'
import { installLiveModelClientPrelude } from './lib/live-model-client-prelude.js'
import { installExactVisionTestClient } from './lib/vision-backend-smoke-test-client.js'
import { installVisionBackendSmokeTest } from './lib/vision-backend-smoke-test.js'
import { installClientPresentationBoundary } from './lib/client-presentation-boundary.js'
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
import { installVisionRoutingPreviewService } from './lib/vision-routing-preview-service.js'
import { installVisionRoutingSettingsPrelude } from './lib/vision-routing-settings-prelude.js'
import { resolveVisionRoutingProduct } from './lib/vision-routing-product.js'
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
import {
  attachmentContextForContract,
  hasBatchAttachmentContract,
  installHostSettingsCompatibility,
  installVisionAttachmentAdmissionPolicy,
  protectHostProviderOwnership,
} from './lib/dsh-contract-compat.js'

// Increment whenever the browser-visible settings contract gains a field whose
// absence changes write semantics. This revision is also exposed as a resolved
// schema default so a newer browser client can distinguish a genuinely updated
// Host from a stale in-process plugin module instead of reporting a generic
// readback mismatch after the old Host rejects a newly visible field.
export const SETTINGS_CONTRACT_REVISION = 6

// Schemastery object schemas expose set() as the supported way to replace a
// field schema. This mutates the Config object that index.js itself later uses
// for the settings namespace, so composition config and settings validation
// agree on the same default.
core.Config.set('progressiveTools', z.boolean().default(false))
// Structured 1+x also has a turn-level wall-clock budget. Individual
// visionTaskTimeoutMs budgets remain unchanged; this one prevents a deep turn
// from multiplying them into several minutes of serial waiting.
core.Config.set('visionTurnBudgetMs', z.number().step(1000).min(10000).max(600000).default(90000))

// Both visible entry points — Settings > Vision Router and the legacy
// Settings > Plugins compatibility card — edit the same Host-owned namespace.
// Keep the depth enum and custom cap on this final public contract so either
// entry serializes exactly the same shape on every supported Host generation.
core.Config.set('visionDepth', z.union(['fast', 'standard', 'deep', 'custom']).default('standard'))
core.Config.set('visionDepthMaxCalls', z.number().step(1).min(0).max(100).default(0))

// Product semantics: users choose whether Vision Router may select a backend
// automatically or must obey the configured order, plus a plain-language
// routing preference. This draft keeps `ordered` as the safe default because
// execution-changing auto routing is not wired yet. A future stable 2.0 can
// change the new-install default only after the executor passes its gates.
core.Config.set('routingMode', z.union(['ordered', 'auto']).default('ordered'))
core.Config.set(
  'routingPreference',
  z.union(['balanced', 'quality', 'speed', 'local']).default('balanced'),
)
// Background profiling never gates normal use. By default it only spends idle
// time on local/free routes; `all` is the explicit user authorization boundary
// for potentially chargeable cloud endpoints, and `off` disables it entirely.
core.Config.set(
  'backgroundBenchmarking',
  z.union(['local-free', 'all', 'off']).default('local-free'),
)

// Internal development controls. Shadow remains observational and is not the
// user-facing product switch. capabilityRoutingStrategy is retained only for
// prototype/backward compatibility; routingPreference is the product contract.
core.Config.set('capabilityRoutingShadow', z.boolean().default(false))
core.Config.set(
  'capabilityRoutingStrategy',
  z.union(['quality', 'balanced', 'speed', 'privacy']).default('balanced'),
)

// Settings surfaces and Host persistence must agree on this field. Keep the
// permission on the public entry contract as well as index.js so a packaged
// build cannot expose the new client toggle while registering an older Host
// schema that silently recovers from the rejected settings.mutate call. This
// deliberately repeats the default: entry.js is the final schema authority
// loaded by Cordis and therefore the right place to close client/Host drift.
core.Config.set('allowRemoteSettings', z.boolean().default(false))

// Internal read-only-by-convention handshake. It is not rendered by Vision
// Router's settings UI and is not in the remote mutable allow-list; its resolved
// default lets diagnostics prove which schema the running Host actually loaded.
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
  // Transitional public aliases retained for callers/tests written during the
  // rc.7 compatibility pass. Runtime code below no longer branches on names.
  installRc7SettingsCompatibility,
  isRc7ContractRuntime,
  protectRc7ProviderOwnership,
} from './lib/dsh-contract-compat.js'
export const Config = core.Config

// Defense in depth for direct/programmatic callers that invoke apply() without
// first running the Cordis Config resolver: only an explicit true enables the
// schema-changing progressive mode. The wrapped context changes logger plus a
// private llm/tools view used only by Vision Router: wrapper -> delegate calls
// preserve replay identity, while vision-tool network calls are constrained to
// the exact backends the user selected in Vision Router.
export function apply(ctx, config = {}) {
  // DSH's browser WebServer can intentionally bind 0.0.0.0 and carries no
  // authentication layer of its own. Same-origin headers are only a CSRF
  // signal, so install a transport-level loopback fence before ANY plugin-owned
  // route is registered. The wrapper patches only webServer.register and hands
  // every injection callback the original child context identity unchanged.
  const localMutationCtx = installLocalMutationRouteBoundary(ctx)
  const logging = installVisionRouterFileLogging(localMutationCtx)
  const capabilityStore = createCapabilityProfileStore({ logger: logging.logger })
  // Runtime speed is deliberately process-local and short-lived. It is not
  // persisted beside capability evidence because network/provider performance
  // is a dynamic runtime fact, not a model capability fact.
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
    backgroundBenchmarking:
      ['local-free', 'all', 'off'].includes(bootConfig.backgroundBenchmarking)
        ? bootConfig.backgroundBenchmarking
        : 'local-free',
    progressiveTools: hardenedConfig.progressiveTools === true,
    guidanceOverrides: normalizeGuidanceOverrides(bootConfig.guidanceOverrides ?? hardenedConfig.guidanceOverrides),
    visionTurnBudgetMs:
      Number.isFinite(Number(bootConfig.visionTurnBudgetMs))
        ? Number(bootConfig.visionTurnBudgetMs)
        : 90000,
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
  const toolRuntimeCtx = installVisionToolRuntimeBoundary(attachmentCompatCtx)
  const nativeImageCompat = contextWithNativeImageCoexistence(toolRuntimeCtx, runtimeConfig)
  const structuredCtx = installStructuredFlowHardening(nativeImageCompat.ctx, nativeImageCompat.config)
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
  const reconciledCtx = contextWithCoalescedAdapterUpdates(capabilityShadowCtx)
  const liveDiscovery = installLiveModelDiscovery(reconciledCtx, {
    config: runtimeConfig,
    logger: logging.logger,
  })
  installVisionModelRegistry(reconciledCtx, liveDiscovery, { config: runtimeConfig })
  installClientPresentationBoundary(reconciledCtx)
  installLiveModelClientPrelude(reconciledCtx)
  installExactVisionTestClient(reconciledCtx)
  installVisionRoutingSettingsPrelude(reconciledCtx)
  installCapabilityBenchmarkClient(reconciledCtx)
  installPiAiBridgeWireCompat(reconciledCtx, logging.logger)
  const executionCtx = contextWithVisionExecutionPolicy(reconciledCtx, {
    isBridgeEvidence: (provider, model) => liveDiscovery.hasModel(provider, model),
    evidenceSource: (provider, model) => liveDiscovery.evidenceSource?.(provider, model),
    logger: logging.logger,
  })
  // Only real visual-tool adapter streams are timed. The tool wrapper above
  // supplies the direct capability axis through AsyncLocalStorage; benchmark,
  // smoke-test and background calls have no such scope and cannot contaminate
  // this runtime-performance store.
  const performanceCtx = contextWithVisionRuntimePerformance(
    executionCtx,
    runtimePerformanceStore,
    { logger: logging.logger },
  )
  installVisionBackendSmokeTest(performanceCtx, runtimeConfig, core, {
    logger: logging.logger,
    isBridgeEvidence: (provider, model) => liveDiscovery.hasModel(provider, model),
  })
  installCapabilityBenchmarkService(performanceCtx, runtimeConfig, core, {
    logger: logging.logger,
    store: capabilityStore,
  })
  installVisionRoutingPreviewService(performanceCtx, runtimeConfig, core, {
    logger: logging.logger,
    store: capabilityStore,
    runtimePerformanceStore,
  })
  installTesseractExecFileCompat(performanceCtx)

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
      () => core.apply(performanceCtx, nativeImageCompat.config),
    )
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
    logging.logger.error(
      'vision-router: plugin apply failed: %s',
      error && error.stack ? error.stack : error && error.message ? error.message : String(error),
    )
    throw error
  }
}