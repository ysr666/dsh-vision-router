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

// Increment whenever the browser-visible settings contract gains a field whose
// absence changes write semantics. This revision is also exposed as a resolved
// schema default so a newer browser client can distinguish a genuinely updated
// Host from a stale in-process plugin module instead of reporting a generic
// readback mismatch after the old Host rejects a newly visible field.
export const SETTINGS_CONTRACT_REVISION = 4

// Schemastery object schemas expose set() as the supported way to replace a
// field schema. This mutates the Config object that index.js itself later uses
// for the settings namespace, so composition config and settings validation
// agree on the same default.
core.Config.set('progressiveTools', z.boolean().default(false))
// Keep the three timeout layers coherent: one provider call may use up to 120s,
// one visual task (including fallbacks) shares 120s, and one visual turn shares
// 120s. The runtime policy below reserves the final quarter of a multi-backend
// task for fallback, so raising the task ceiling does not revive the historical
// "120s per backend" stall that #117 removed.
core.Config.set('visionTaskTimeoutMs', z.number().step(1000).min(1000).max(180000).default(120000))
core.Config.set('visionTurnBudgetMs', z.number().step(1000).min(10000).max(600000).default(120000))

// Both visible entry points — Settings > Vision Router and the legacy
// Settings > Plugins compatibility card — edit the same Host-owned namespace.
// Keep the depth enum and custom cap on this final public contract so either
// entry serializes exactly the same shape on every supported Host generation.
core.Config.set('visionDepth', z.union(['fast', 'standard', 'deep', 'custom']).default('standard'))
core.Config.set('visionDepthMaxCalls', z.number().step(1).min(0).max(100).default(0))

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
  const delegatedReplayCtx = contextWithDelegatedReplay(logging.ctx, {
    wrapperRoute:
      typeof config.wrapperRoute === 'string' && config.wrapperRoute !== ''
        ? config.wrapperRoute
        : 'deepseek-vision',
    visionConfig: config,
  })
  // Newer pi-ai replay envelopes store the real producer under
  // replayState.response.{provider,model}; the older delegated-replay shim
  // recognizes the pre-v2 top-level shape. Layer a narrow private compatibility
  // view so resumed wrapper history keeps provider-native replay metadata rather
  // than degrading to foreign history at the delegate boundary.
  const runtimeCtx = contextWithReplayEnvelopeV2Compat(delegatedReplayCtx)
  // Filesystem authority is separate from browser rendering safety. Put this
  // boundary INSIDE adversarial hardening so the secure HTML renderer that the
  // outer layer installs is itself wrapped by canonical workspace containment.
  const screenshotSourceCtx = installScreenshotSourceBoundary(runtimeCtx, core)
  // Security/runtime boundary shared by the core and the local-vision shim:
  // keep artifacts inside the session workspace, make HTML screenshots truly
  // offline + sandboxed, protect the screenshot-permission side effect, and
  // make the process-wide fetch cleanup coexist with later plugin patches.
  const { ctx: hardenedCtx, config: hardenedConfig } = installAdversarialHardening(
    screenshotSourceCtx,
    config,
    core,
  )
  // Ollama's native API can preload a model independently of an actual vision
  // inference. Install this boundary before the local-vision stabilizer so the
  // final local vision-http adapter is observed after stabilization. Primary
  // local-Ollama image turns finish a cold model load in pre-step, before the
  // visual task budget begins; fallback Ollama warms in the background.
  const ollamaColdStartCtx = installOllamaColdStartGuard(hardenedCtx, hardenedConfig, core)
  // #141 stabilization boundary: keep the recently merged local-vision
  // behavior isolated from main's existing provider/router semantics. It
  // normalizes only the local settings/runtime seams before core.apply sees
  // the context (desktop screenshot exposure, instant-local budget/one-pass,
  // local vision-http transport and connection-probe fallback).
  const { ctx: stabilizedCtx, bootConfig } = installLocalVisionStabilizer(
    ollamaColdStartCtx,
    hardenedConfig,
    core,
  )
  const runtimeConfig = {
    ...bootConfig,
    progressiveTools: hardenedConfig.progressiveTools === true,
    guidanceOverrides: normalizeGuidanceOverrides(bootConfig.guidanceOverrides ?? hardenedConfig.guidanceOverrides),
    visionTaskTimeoutMs:
      Number.isFinite(Number(bootConfig.visionTaskTimeoutMs))
        ? Number(bootConfig.visionTaskTimeoutMs)
        : 120000,
    visionTurnBudgetMs:
      Number.isFinite(Number(bootConfig.visionTurnBudgetMs))
        ? Number(bootConfig.visionTurnBudgetMs)
        : 120000,
  }
  // The batch-attachment API is the released, non-incidental discriminator
  // between the minimum Host contract and the newer Host-owned integration
  // generation. Keep the branch named after that observable capability rather
  // than a release number so rc.8+ naturally follows the same public contract.
  const batchAttachmentHost = hasBatchAttachmentContract(stabilizedCtx)
  // DSH may reconstruct attachment-local after a profile/home patch reload.
  // Keep the historical rc.8 overlay migration attached to that service
  // lifecycle instead of healing only the instance present during apply().
  if (batchAttachmentHost) {
    installVisionAttachmentAdmissionPolicy(stabilizedCtx, logging.logger)
  }
  // The remote settings bridge uses DSH Connection's trusted-host carrier
  // fence and its own safe-field capability allow-list. Main's local Web
  // mutation boundary continues to protect the independent /_dsh write routes.
  installVisionRouterRemoteSettingsBridge(stabilizedCtx, logging.logger)
  // rc.8 swaps ModuleLoader.load() while entering live mode. The older local
  // permission/risk shims still own rc.6/rc.7; this narrow lifecycle shim
  // re-installs both contexts after rc.8's queue -> live transition.
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
  // The minimum Host keeps the narrow process-local fallback required by the
  // old attachment-local durability walk. Batch-capable hosts keep AttachmentId
  // store-owned, so never fabricate one there: host persistence errors remain
  // authoritative and diagnosable instead of creating a false durable ref.
  const attachmentCompatCtx = attachmentContextForContract(settingsCtx, logging.logger, {
    installAndroidAttachmentCompat,
  })
  // Put per-tool cwd/cancellation/cache policy AFTER Host settings compatibility
  // so rc.7/rc.8's synthetic settings injection is visible to the boundary.
  // The secure screenshot renderer owns its exact FsTarget and active browser
  // cancellation directly, so it does not depend on this placement.
  const toolRuntimeCtx = installVisionToolRuntimeBoundary(attachmentCompatCtx, runtimeConfig)
  // DSH 0.1.1 publishes an exact native image-capable DeepSeek model. Do not
  // put it ahead of Vision Router's own configured chain: only when the user
  // has explicitly selected any Host-native image route, preserve raw pixels
  // and skip the hidden instant-local caption pass for that turn. Ownership is
  // AsyncLocalStorage-scoped and never mutates settings or provider order.
  const nativeImageCompat = contextWithNativeImageCoexistence(toolRuntimeCtx, runtimeConfig)
  // index.js still carries legacy global wrapper/tool gates. Feed the new
  // session policy into that core through one narrow compatibility bridge:
  // native/owned/unknown routes preserve raw pixels, text-only routes are
  // normalized by the core's own rewriteHistoryImages implementation, and the
  // boot-only tool projection ends immediately after core.apply wires schema.
  const legacyCoreCompat = installLegacyCoreVisionPolicyBridge(
    nativeImageCompat.ctx,
    nativeImageCompat.config,
    { rewriteHistoryImages: core.rewriteHistoryImages },
  )
  // Final structured-flow guard sits closest to core.apply so it sees the
  // actual tool registrations and pre-step listener. It makes bootstrap
  // one-shot, enforces fast/standard/deep/custom quotas, tracks mixed branches,
  // rejects empty/non-evidence results, and applies one shared visual deadline.
  const structuredCtx = installStructuredFlowHardening(legacyCoreCompat.ctx, legacyCoreCompat.config)
  // Adapter reconciliation + prepareCall normalization are already installed at
  // the final Host registration boundary above. Wrapping again here would make
  // prepareCall capture a pre-wrapper stream.
  const reconciledCtx = structuredCtx
  // Discover the provider's actual /models list independently of DSH's static
  // catalog. The Host owns credentials/networking/cache; the browser receives
  // model ids only. A live hit is also the evidence required before an
  // UNKNOWN_MODEL catalog miss may enter the compatibility bridge.
  const liveDiscovery = installLiveModelDiscovery(reconciledCtx, {
    config: runtimeConfig,
    logger: logging.logger,
  })
  // Consolidate the private picker registry without weakening execution
  // admission. Fresh/stale endpoint models get explicit source labels, while a
  // model already saved under an active provider stays visible as [saved] even
  // when that provider does not enumerate every accepted id. Saved-only rows do
  // NOT alter liveDiscovery.hasModel(), so they cannot authorize a direct
  // UNKNOWN_MODEL bridge by themselves. The registry also exposes the evidence
  // source strictly for diagnostics (`known` vs `live`) without changing the
  // admission decision.
  installVisionModelRegistry(reconciledCtx, liveDiscovery, { config: runtimeConfig })
  // rc.8 turns ui-attachment into a dynamic presentation plugin and no longer
  // exports its React implementation as package values. Install a narrowly
  // scoped browser boundary that supplies Vision Router's own lightweight
  // gallery to the legacy 1.7.x client factory, so the official package is
  // never value-required at runtime and remains free to evolve independently.
  installClientPresentationBoundary(reconciledCtx)
  // Keep endpoint-discovered ids private to Vision Router's settings client:
  // the prelude wraps this package's browser context rather than changing the
  // global llm.models response (which would expose UNKNOWN_MODEL entries in the
  // ordinary chat model picker). The existing classic client bundle stays the
  // DSH module-system artifact, including HMR/source-map behavior.
  installLiveModelClientPrelude(reconciledCtx)
  // #266: 1.7.x gets one exact, no-fallback image smoke test per visible row.
  // Keep it out of the controlled React form so the v2 capability-benchmark
  // client can take ownership later without forking the stable settings UI.
  installExactVisionTestClient(reconciledCtx)
  // DSH 0.1.1 adds per-route/model pi-ai wire compatibility. The legacy
  // direct image bridge is non-streaming and predates that surface, so preserve
  // maxTokensField + route headers at its final fetch boundary. Ordinary DSH
  // streams and unrelated Vision Router HTTP providers remain byte-identical.
  installPiAiBridgeWireCompat(reconciledCtx, logging.logger)
  // Existing execution policy stays authoritative for adapter-observed failures:
  // only exact local pre-wire admission failures may unlock the post-failure
  // bridge. The outer runtime policy added below handles the complementary case
  // where DSH would silently project pixels to SHA text before the adapter ever
  // gets a chance to reject them.
  const executionCtx = contextWithVisionExecutionPolicy(reconciledCtx, {
    isBridgeEvidence: (provider, model) => liveDiscovery.hasModel(provider, model),
    evidenceSource: (provider, model) => liveDiscovery.evidenceSource?.(provider, model),
    logger: logging.logger,
  })
  const backendRuntimeCtx = contextWithVisionBackendRuntimePolicy(executionCtx, {
    config: runtimeConfig,
    core,
    evidenceSource: (provider, model) => liveDiscovery.evidenceSource?.(provider, model),
    logger: logging.logger,
  })
  // The smoke-test route sends only a built-in probe image to the exact selected
  // backend. It never walks the configured fallback chain, so a healthy OVH
  // fallback can no longer make a broken custom model look healthy. Its narrow
  // compatibility bridge uses the same live-discovery evidence gate as runtime.
  installVisionBackendSmokeTest(backendRuntimeCtx, runtimeConfig, core, {
    logger: logging.logger,
    isBridgeEvidence: (provider, model) => liveDiscovery.hasModel(provider, model),
  })
  // index.js historically passes image bytes as `options.input` to the async
  // execFile API. That option is not fed into child stdin, so Tesseract waits
  // for data until the OCR slice expires. Materialize only this exact
  // Tesseract-stdin call to a temporary image file; all other execFile calls
  // keep their native behavior.
  installTesseractExecFileCompat(backendRuntimeCtx)

  // 启动诊断摘要只描述 composition/apply 的基础配置。设置服务可能稍后
  // 覆盖这些值；每个图片轮还会记录 current() 的实时决策，避免把这个
  // 启动快照误当成最终设置状态。
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
    const result = core.apply(backendRuntimeCtx, legacyCoreCompat.config)
    legacyCoreCompat.finishSchemaBootstrap()
    // On newer Hosts the Settings -> Models surface is backed by the
    // configurable-provider directory, not by the live adapter registry alone.
    // Publish the main DeepSeek + 自动识图 route as a derived alias of official
    // DeepSeek. On older Hosts the helper feature-detects and stays inert.
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
