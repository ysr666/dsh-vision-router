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

export const SETTINGS_CONTRACT_REVISION = 4

core.Config.set('progressiveTools', z.boolean().default(false))
core.Config.set('visionTurnBudgetMs', z.number().step(1000).min(10000).max(600000).default(90000))
core.Config.set('visionDepth', z.union(['fast', 'standard', 'deep', 'custom']).default('standard'))
core.Config.set('visionDepthMaxCalls', z.number().step(1).min(0).max(100).default(0))
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
  // Put adapter reconciliation + DSH 0.1.1 prepareCall normalization at the
  // deepest private LLM boundary. Every higher Vision Router wrapper therefore
  // finishes shaping adapter.stream before this boundary captures the final
  // Host-visible adapter contract. The same private context still scopes
  // llm/adapters-updated coalescing to Vision Router listeners only.
  const localMutationCtx = installLocalMutationRouteBoundary(ctx)
  const adapterContractCtx = contextWithCoalescedAdapterUpdates(localMutationCtx)
  const logging = installVisionRouterFileLogging(adapterContractCtx)
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
  const runtimeConfig = {
    ...bootConfig,
    progressiveTools: hardenedConfig.progressiveTools === true,
    guidanceOverrides: normalizeGuidanceOverrides(bootConfig.guidanceOverrides ?? hardenedConfig.guidanceOverrides),
    visionTurnBudgetMs:
      Number.isFinite(Number(bootConfig.visionTurnBudgetMs))
        ? Number(bootConfig.visionTurnBudgetMs)
        : 90000,
  }

  const batchAttachmentHost = hasBatchAttachmentContract(stabilizedCtx)
  if (batchAttachmentHost) {
    installVisionAttachmentAdmissionPolicy(stabilizedCtx, logging.logger)
  }
  installVisionRouterRemoteSettingsBridge(stabilizedCtx, logging.logger)
  installSettingsRc8ClientLifecycle(stabilizedCtx)

  const ownershipCtx = batchAttachmentHost
    ? protectHostProviderOwnership(stabilizedCtx)
    : stabilizedCtx
  const settingsCtx = batchAttachmentHost
    ? installHostSettingsCompatibility(ownershipCtx, { ...runtimeConfig, stealth: false }, {
        namespace: 'vision-router',
        Config: core.Config,
      })
    : ownershipCtx
  const attachmentCompatCtx = attachmentContextForContract(settingsCtx, logging.logger, {
    installAndroidAttachmentCompat,
  })

  // The runtime boundary is the single live permission gate for every
  // vision_* execute path. Supplying the boot config also makes a composition
  // tool=false fail closed before the Settings service finishes mounting.
  const toolRuntimeCtx = installVisionToolRuntimeBoundary(attachmentCompatCtx, runtimeConfig)
  const nativeImageCompat = contextWithNativeImageCoexistence(toolRuntimeCtx, runtimeConfig)
  const structuredCtx = installStructuredFlowHardening(nativeImageCompat.ctx, nativeImageCompat.config)

  // Adapter coalescing already lives at the final Host registration boundary;
  // do not wrap again here or prepareCall would capture a pre-wrapper stream.
  const reconciledCtx = structuredCtx

  const liveDiscovery = installLiveModelDiscovery(reconciledCtx, {
    config: runtimeConfig,
    logger: logging.logger,
  })
  installVisionModelRegistry(reconciledCtx, liveDiscovery, { config: runtimeConfig })
  installClientPresentationBoundary(reconciledCtx)
  installLiveModelClientPrelude(reconciledCtx)
  installExactVisionTestClient(reconciledCtx)
  installPiAiBridgeWireCompat(reconciledCtx, logging.logger)

  const executionCtx = contextWithVisionExecutionPolicy(reconciledCtx, {
    isBridgeEvidence: (provider, model) => liveDiscovery.hasModel(provider, model),
    evidenceSource: (provider, model) => liveDiscovery.evidenceSource?.(provider, model),
    logger: logging.logger,
  })
  installVisionBackendSmokeTest(executionCtx, runtimeConfig, core, {
    logger: logging.logger,
    isBridgeEvidence: (provider, model) => liveDiscovery.hasModel(provider, model),
  })
  installTesseractExecFileCompat(executionCtx)

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
    const result = core.apply(executionCtx, nativeImageCompat.config)
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
