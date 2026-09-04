// Runtime composition boundary.
//
// This module owns orchestration only. It deliberately does not own product
// settings, route scoring, provider transports, session persistence, or browser
// implementation details. Keep the mature installers below in their historical
// order so entry.js can remain the thin public schema/export boundary.

import { installVisionRouterFileLogging } from './file-logger.js'
import { contextWithDelegatedReplay } from './replay-delegation.js'
import { contextWithReplayEnvelopeV2Compat } from './replay-envelope-v2-compat.js'
import { contextWithVisionExecutionPolicy } from './vision-execution-policy.js'
import { contextWithVisionBackendRuntimePolicy } from './vision-backend-runtime-policy.js'
import { contextWithNativeImageCoexistence } from './native-image-coexistence.js'
import { createCoreVisionSurfaceRuntime } from './core-vision-surface.js'
import { installSessionVisionIndexBoundary } from './session-vision-index.js'
import { createSessionVisionRuntime } from './session-vision-runtime.js'
import { installLegacyCoreVisionPolicyBridge } from './legacy-core-vision-policy-bridge.js'
import { installSessionVisionModeBoundary } from './session-vision-mode-boundary.js'
import { installPiAiBridgeWireCompat } from './pi-ai-bridge-wire-compat.js'
import { installLiveModelDiscovery } from './live-model-discovery.js'
import { installVisionModelRegistry } from './vision-model-registry.js'
import { installAdversarialHardening } from './adversarial-hardening.js'
import { installOllamaColdStartGuard } from './ollama-cold-start.js'
import { installLocalVisionStabilizer } from './local-vision-stabilizer.js'
import { installWrapperDirectoryAlias } from './wrapper-directory.js'
import { installAndroidAttachmentCompat } from './android-attachment-compat.js'
import { contextWithCoalescedAdapterUpdates } from './adapter-update-coalescer.js'
import { installTesseractExecFileCompat } from './tesseract-exec-compat.js'
import { installLocalMutationRouteBoundary } from './web-capability-boundary.js'
import { installScreenshotSourceBoundary } from './screenshot-source-boundary.js'
import { installVisionToolRuntimeBoundary } from './vision-tool-runtime-boundary.js'
import {
  configureAgentRequestRouteAuthority,
  contextWithAgentRequestRouteAuthority,
} from './agent-request-route-authority.js'
import { contextWithGroundingCoordinateFrame } from './grounding-coordinate-runtime.js'
import { installVisionRoutingRuntime } from './vision-routing-runtime.js'
import { createCapabilityProfileStore } from './vision-capability-probe.js'
import { installCapabilityBenchmarkService } from './vision-capability-benchmark-service.js'
import { attachCapabilityBenchmarkPresentation } from './vision-capability-benchmark-presentation.js'
import { resolveVisionRoutingProduct } from './vision-routing-product.js'
import {
  normalizeBackgroundMeasurementAuthority,
  resolveVisionRoutingAuthority,
} from './vision-routing-authority.js'
import { withVisionCircuitBreakerObserver } from './vision-breaker-observer.js'
import { createVisionBreakerShadowHealth } from './vision-breaker-shadow-health.js'
import { installBackgroundCapabilityProfiling } from './vision-background-benchmark.js'
import {
  contextWithVisionRuntimePerformance,
  createVisionRuntimePerformanceStore,
} from './vision-runtime-performance.js'
import {
  installStructuredFlowHardening,
  normalizeGuidanceOverrides,
} from './structured-flow-hardening.js'
import { installVisionLimitDiagnostics } from './vision-limit-diagnostics.js'
import {
  attachmentContextForContract,
  hasBatchAttachmentContract,
  installHostSettingsCompatibility,
  installVisionAttachmentAdmissionPolicy,
  protectHostProviderOwnership,
} from './dsh-contract-compat.js'
import {
  installVisionSettingsWebBoundary,
  installVisionWebIntegration,
} from './web/index.js'
import { createRuntimeI18nCoreFacade } from './runtime-i18n-core.js'
import { createRuntimeI18nCoreScope } from './runtime-i18n-core-scope.js'

function liveVisionSettings(ctx, fallback) {
  try {
    const settings = ctx?.get?.('settings')
    const current = settings?.get?.('vision-router')
    if (current && typeof current === 'object' && !Array.isArray(current)) return current
  } catch {
    // Before Settings mounts, the normalized composition config is authoritative.
  }
  return fallback
}

function legacyCoreVisionSettings(ctx, fallback) {
  const current = liveVisionSettings(ctx, fallback)
  if (!current || typeof current !== 'object' || Array.isArray(current)) return current
  if (current.autoActivateOnImage === false) return current
  // Runtime i18n owns image-turn auto-mount by stable machine state. Suppress
  // only Core's retired prose-parsing switch through its explicit policy
  // surface; never impersonate Settings or replace the real plugin config.
  return { ...current, autoActivateOnImage: false }
}

export function applyVisionRuntimeComposition(ctx, config = {}, core) {
  // SessionVisionIndex calls planGuardStopShadows before Core.apply. Keep that
  // one helper behind the live-locale facade; the final Core itself still gets
  // the ordinary composition identity and is localized by the scoped context.
  const runtimeI18nCore = createRuntimeI18nCoreFacade(core, ctx)

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
  const runtimeI18nCoreScope = createRuntimeI18nCoreScope({ config: runtimeConfig })

  const batchAttachmentHost = hasBatchAttachmentContract(stabilizedCtx)
  if (batchAttachmentHost) installVisionAttachmentAdmissionPolicy(stabilizedCtx, logging.logger)

  // Browser/settings ownership stays behind explicit Web boundaries while
  // preserving the historical pre-settings/client install order.
  installVisionSettingsWebBoundary(stabilizedCtx, logging.logger)
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
  const coreVisionSurfaceRuntime = createCoreVisionSurfaceRuntime({
    config: () => legacyCoreVisionSettings(nativeImageCompat.ctx, nativeImageCompat.config),
  })

  // Session vision ownership is one explicit bounded store plus one explicit
  // index. The facade is used only because guard-stop surface repair calls
  // planGuardStopShadows before Core.apply; all other Core ownership stays raw.
  const sessionVisionRuntime = createSessionVisionRuntime({
    core: runtimeI18nCore,
    config: () => liveVisionSettings(nativeImageCompat.ctx, nativeImageCompat.config),
    logger: logging.logger,
  })
  const sessionIndexCtx = installSessionVisionIndexBoundary(
    nativeImageCompat.ctx,
    nativeImageCompat.config,
    runtimeI18nCore,
    { logger: logging.logger, index: sessionVisionRuntime.index },
  )
  // The retired bridge stays identity-only. Session mode is a new explicit
  // boundary because it owns a different concern: per-Agent visibility and
  // execution authority derived from DSH's modelSelection projection.
  const legacyCoreCompat = installLegacyCoreVisionPolicyBridge(
    sessionIndexCtx,
    nativeImageCompat.config,
    { rewriteHistoryImages: core.rewriteHistoryImages },
  )
  const sessionVisionModeCompat = installSessionVisionModeBoundary(
    legacyCoreCompat.ctx,
    legacyCoreCompat.config,
  )

  // Final structured-flow guard sits closest to core.apply so it sees the
  // actual tool registrations and pre-step listener. The diagnostic observer
  // remains immediately inside it so existing timeout/budget semantics stay
  // unchanged.
  const limitDiagnosticCtx = installVisionLimitDiagnostics(
    sessionVisionModeCompat.ctx,
    sessionVisionModeCompat.config,
    logging.logger,
  )
  const structuredCtx = installStructuredFlowHardening(
    limitDiagnosticCtx,
    sessionVisionModeCompat.config,
  )
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
  // deepest private Host registration boundary above. Do not wrap it again or a
  // prepared adapter may capture a pre-wrapper stream.
  const reconciledCtx = routingRuntimeCtx
  const liveDiscovery = installLiveModelDiscovery(reconciledCtx, {
    config: runtimeConfig,
    logger: logging.logger,
  })
  installVisionModelRegistry(reconciledCtx, liveDiscovery, { config: runtimeConfig })
  installVisionWebIntegration(reconciledCtx, {
    config: runtimeConfig,
    core,
    store: capabilityStore,
    runtimePerformanceStore,
    healthForCandidate: breakerShadowHealth.healthForCandidate,
  })
  installPiAiBridgeWireCompat(reconciledCtx, logging.logger)

  const executionCtx = contextWithVisionExecutionPolicy(reconciledCtx, {
    isBridgeEvidence: (provider, model) => liveDiscovery.hasModel(provider, model),
    evidenceSource: (provider, model) => liveDiscovery.evidenceSource?.(provider, model),
    logger: logging.logger,
  })

  // Ground/detect own one explicit raster-coordinate boundary. It wraps only
  // the tool-registration view, before runtime-performance observation. That
  // leaves adapter sampling on the same execution seam while backend preflight
  // remains the final outer Core-visible policy boundary.
  const groundingCoordinateCtx = contextWithGroundingCoordinateFrame(executionCtx, {
    core,
    config: runtimeConfig,
    sessionVisionIndex: sessionVisionRuntime.index,
  })

  // Only real visual-tool adapter streams are timed, and only while live Auto
  // authority permits future-routing observation. Benchmark/background calls
  // have no visual-tool scope and cannot contaminate this store.
  const performanceCtx = contextWithVisionRuntimePerformance(
    groundingCoordinateCtx,
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

  // The outer backend policy still covers Hosts that would otherwise project
  // image bytes to SHA text before an adapter can reject them. Native adapter
  // execution remains observable while direct bridge preflight stays outside
  // runtime sampling, preserving Balanced/Speed incomparability semantics.
  // The final decorator is dormant for benchmark/presentation consumers and is
  // activated only inside runtimeI18nCoreScope.run() around Core.apply.
  const backendRuntimeCtx = contextWithVisionBackendRuntimePolicy(performanceCtx, {
    config: runtimeConfig,
    core,
    evidenceSource: (provider, model) => liveDiscovery.evidenceSource?.(provider, model),
    logger: logging.logger,
    finalContextDecorator: runtimeI18nCoreScope.decorate,
  })
  const capabilityBenchmark = installCapabilityBenchmarkService(backendRuntimeCtx, runtimeConfig, core, {
    logger: logging.logger,
    store: capabilityStore,
  })
  attachCapabilityBenchmarkPresentation(capabilityBenchmark, {
    ctx: backendRuntimeCtx,
    config: runtimeConfig,
    core,
    healthForCandidate: breakerShadowHealth.healthForCandidate,
  })
  installTesseractExecFileCompat(backendRuntimeCtx)

  // Core owns exactly one agent/request routing hook. Protect the completed
  // provider/model handoff at that event boundary so future route-switch logic
  // cannot accidentally carry source-model call defaults into the target.
  configureAgentRequestRouteAuthority(backendRuntimeCtx, {
    wrapperRoute: runtimeConfig.wrapperRoute,
    chainRoute: runtimeConfig.chainRoute,
    logger: logging.logger,
  })
  const coreRequestAuthorityCtx = contextWithAgentRequestRouteAuthority(backendRuntimeCtx)

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
    const result = runtimeI18nCoreScope.run(() =>
      withVisionCircuitBreakerObserver(
        breakerShadowHealth.capture,
        () => core.apply(
          coreRequestAuthorityCtx,
          sessionVisionModeCompat.config,
          {
            sessionVision: sessionVisionRuntime,
            coreVisionSurface: coreVisionSurfaceRuntime,
          },
        ),
      ),
    )
    coreVisionSurfaceRuntime.finishSchemaBootstrap()
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
    coreVisionSurfaceRuntime.finishSchemaBootstrap()
    logging.logger.error(
      'vision-router: plugin apply failed: %s',
      error && error.stack ? error.stack : error && error.message ? error.message : String(error),
    )
    throw error
  }
}