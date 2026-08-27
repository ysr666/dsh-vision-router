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
import { installSettingsLimitClientPrelude } from './lib/settings-limit-client-prelude.js'
import { installSettingsRc8ClientLifecycle } from './lib/settings-client-rc8-lifecycle.js'
import { installVisionRoutingRuntime } from './lib/vision-routing-runtime.js'
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

// Increment whenever the browser-visible settings contract gains a field whose
// absence changes write semantics. This revision is also exposed as a resolved
// schema default so a newer browser client can distinguish a genuinely updated
// Host from a stale in-process plugin module instead of reporting a generic
// readback mismatch after the old Host rejects a newly visible field.
export const SETTINGS_CONTRACT_REVISION = 7

// Schemastery object schemas expose set() as the supported way to replace a
// field schema. This mutates the Config object that index.js itself later uses
// for the settings namespace, so composition config and settings validation
// agree on the same default.
core.Config.set('progressiveTools', z.boolean().default(false))
// Keep the timeout layers coherent: one provider call may use up to 120s and
// one visual task (including fallbacks) shares 120s. The whole-turn visual
// budget is an optional user safety cap rather than an Agent lifetime policy:
// 0 means unlimited, which is the default for long-running autonomous turns.
// The runtime policy below still reserves the final quarter of a multi-backend
// task for fallback, so disabling the aggregate cap does not revive the
// historical "120s per backend" stall that #117 removed.
core.Config.set('visionTaskTimeoutMs', z.number().step(1000).min(1000).max(180000).default(120000))
core.Config.set('visionTurnBudgetMs', z.number().step(1000).min(0).max(600000).default(0))

// Both visible entry points — Settings > Vision Router and the legacy
// Settings > Plugins compatibility card — edit the same Host-owned namespace.
// Keep the depth enum and custom cap on this final public contract so either
// entry serializes exactly the same shape on every supported Host generation.
core.Config.set('visionDepth', z.union(['fast', 'standard', 'deep', 'custom']).default('standard'))
core.Config.set('visionDepthMaxCalls', z.number().step(1).min(0).max(100).default(0))

// Product semantics: users choose whether Vision Router may select a backend
// automatically or must obey the configured order, plus a plain-language
// routing preference. Ordered remains the safe default; Auto changes execution
// only under explicit live routingMode:auto authority.
core.Config.set('routingMode', z.union(['ordered', 'auto']).default('ordered'))
core.Config.set(
  'routingPreference',
  z.union(['balanced', 'quality', 'speed', 'local']).default('balanced'),
)
// Background measurement is a separate user authority. Even local/free work
// consumes resources, so absence never grants it: users explicitly choose
// local-free or all when they want standing background measurement.
core.Config.set(
  'backgroundBenchmarking',
  z.union(['local-free', 'all', 'off']).default('off'),
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
  // Normalize DSH 0.1.1's prepareCall contract at the deepest private LLM
  // boundary. Higher Vision Router layers can finish wrapping adapter.stream
  // before this boundary captures the final Host-visible adapter, so prepareCall
  // cannot bypass local/runtime/replay stream behavior.
  const adapterContractCtx = contextWithCoalescedAdapterUpdates(localMutationCtx)
  const logging = installVisionRouterFileLogging(adapterContractCtx)
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
  // Install this before the consolidated Settings IA transform registered by
  // the remote-settings bridge so the numeric fence remains the outer wrapper.
  installSettingsLimitClientPrelude(stabilizedCtx)
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
  // Feed the session-level image-ownership decision into the legacy core's
  // wrapper/tool gates without reintroducing a global policy guess.
  const legacyCoreCompat = installLegacyCoreVisionPolicyBridge(
    nativeImageCompat.ctx,
    nativeImageCompat.config,
    { rewriteHistoryImages: core.rewriteHistoryImages },
  )
  // Final structured-flow guard sits closest to core.apply so it sees the
  // actual tool registrations and pre-step listener. It makes bootstrap
  // one-shot, enforces fast/standard/deep/custom quotas, tracks mixed branches,
  // rejects empty/non-evidence results, and applies the optional turn deadline
  // only when the user explicitly configures one. The diagnostic observer sits
  // immediately inside it so it can inspect the final budget result/guard while
  // leaving #220/#295 wall-clock semantics untouched.
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
  const routingRuntimeCtx = installVisionRoutingRuntime(
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
  // prepareCall normalization/reconciliation is already installed at the
  // deepest private Host registration boundary above. Do not wrap it again
  // here or a prepared adapter may capture a pre-wrapper stream.
  const reconciledCtx = routingRuntimeCtx
  const liveDiscovery = installLiveModelDiscovery(reconciledCtx, {
    config: runtimeConfig,
    logger: logging.logger,
  })
  installVisionModelRegistry(reconciledCtx, liveDiscovery, { config: runtimeConfig })
  installClientPresentationBoundary(reconciledCtx)
  // The same first walkthrough step now teaches the explicit "识图" control
  // introduced by #284. Widen the existing spotlight to cover that button and
  // the adjacent model selector as one target instead of leaving the control
  // under the dimming veil.
  installGuideVisionToggleHighlight(reconciledCtx)
  // The Host keeps wrapper routes registered because image admission and the
  // Vision toggle need their real identity. Hide only confidently owned
  // wrapper groups from DSH's stock model-selection presentation and project an
  // active wrapper back to its ordinary source label; uncertain routes stay
  // visible rather than being guessed away.
  installVisionModelVisibilityBoundary(reconciledCtx)
  // Keep endpoint-discovered ids private to Vision Router's settings client,
  // but make Settings -> Models authoritative when DSH already enumerates a
  // provider. Live /models data now fills only a still-active provider whose
  // DSH catalog is empty, so disabled models and removed providers cannot leak
  // back into the Vision Router picker through stale endpoint discovery.
  installStrictLiveModelClientPrelude(reconciledCtx)
  // Surface the existing autoWrapProviders/wrappedProviders contract in the
  // primary Vision Router settings section. This is presentation-only: the Host
  // keeps one settings namespace and one wrapper-registration implementation.
  installWrapperScopeClientPrelude(reconciledCtx)
  // Capability Benchmark is the single visible and callable per-model
  // capability-test surface in the release runtime.
  installVisionRoutingSettingsPrelude(reconciledCtx)
  installCapabilityBenchmarkClient(reconciledCtx)
  installPiAiBridgeWireCompat(reconciledCtx, logging.logger)
  const executionCtx = contextWithVisionExecutionPolicy(reconciledCtx, {
    isBridgeEvidence: (provider, model) => liveDiscovery.hasModel(provider, model),
    evidenceSource: (provider, model) => liveDiscovery.evidenceSource?.(provider, model),
    logger: logging.logger,
  })
  // Only real visual-tool adapter streams are timed, and only while live Auto
  // authority permits future-routing observation. Benchmark/background calls
  // have no visual-tool scope and cannot contaminate this store.
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
  // v1.7.7's outer policy covers cases where DSH would otherwise project image
  // bytes to SHA text before an adapter gets the chance to reject them. Keeping
  // it outside the runtime-performance observer means native adapter execution
  // is still timed, while a preflight direct bridge bypasses runtime sampling
  // and therefore stays incomparable for Balanced/Speed as designed.
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
