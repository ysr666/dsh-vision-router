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
import { installAdversarialHardening } from './lib/adversarial-hardening.js'
import { installLocalVisionStabilizer } from './lib/local-vision-stabilizer.js'
import { installWrapperDirectoryAlias } from './lib/wrapper-directory.js'
import { installAndroidAttachmentCompat } from './lib/android-attachment-compat.js'
import { contextWithCoalescedAdapterUpdates } from './lib/adapter-update-coalescer.js'
import { installTesseractExecFileCompat } from './lib/tesseract-exec-compat.js'
import { installLocalMutationRouteBoundary } from './lib/web-capability-boundary.js'
import { installScreenshotSourceBoundary } from './lib/screenshot-source-boundary.js'
import {
  installStructuredFlowHardening,
  normalizeGuidanceOverrides,
} from './lib/structured-flow-hardening.js'
import {
  attachmentContextForContract,
  installRc7SettingsCompatibility,
  isRc7ContractRuntime,
  protectRc7ProviderOwnership,
} from './lib/dsh-contract-compat.js'

// Schemastery object schemas expose set() as the supported way to replace a
// field schema. This mutates the Config object that index.js itself later uses
// for the settings namespace, so composition config and settings validation
// agree on the same default.
core.Config.set('progressiveTools', z.boolean().default(false))
// Structured 1+x now also has a turn-level wall-clock budget. Individual
// visionTaskTimeoutMs budgets remain unchanged; this one prevents a deep turn
// from multiplying them into several minutes of serial waiting.
core.Config.set('visionTurnBudgetMs', z.number().step(1000).min(10000).max(600000).default(90000))

export * from './index.js'
export {
  attachmentContextForContract,
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
  const runtimeCtx = contextWithDelegatedReplay(logging.ctx, {
    wrapperRoute:
      typeof config.wrapperRoute === 'string' && config.wrapperRoute !== ''
        ? config.wrapperRoute
        : 'deepseek-vision',
    visionConfig: config,
  })
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
  // #141 stabilization boundary: keep the recently merged local-vision
  // behavior isolated from main's existing provider/router semantics. It
  // normalizes only the local settings/runtime seams before core.apply sees
  // the context (desktop screenshot exposure, instant-local budget/one-pass,
  // local vision-http transport and connection-probe fallback).
  const { ctx: stabilizedCtx, bootConfig } = installLocalVisionStabilizer(
    hardenedCtx,
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
  const rc7 = isRc7ContractRuntime(stabilizedCtx)
  const ownershipCtx = rc7 ? protectRc7ProviderOwnership(stabilizedCtx) : stabilizedCtx
  const settingsCtx = rc7
    ? installRc7SettingsCompatibility(ownershipCtx, { ...runtimeConfig, stealth: false }, {
        namespace: 'vision-router',
        Config: core.Config,
      })
    : ownershipCtx
  // rc.6/Termux keeps the narrow process-local fallback that was required by
  // the old attachment-local durability walk. rc.7 formalizes AttachmentId as
  // store-owned, so never synthesize one there: host persistence errors remain
  // authoritative and diagnosable instead of creating a false durable ref.
  const attachmentCompatCtx = attachmentContextForContract(settingsCtx, logging.logger, {
    installAndroidAttachmentCompat,
  })
  // Final structured-flow guard sits closest to core.apply so it sees the
  // actual tool registrations and pre-step listener. It makes bootstrap
  // one-shot, enforces fast/standard/deep quotas, tracks mixed branches,
  // rejects empty/non-evidence results, and applies one shared turn deadline.
  const structuredCtx = installStructuredFlowHardening(attachmentCompatCtx, runtimeConfig)
  // DSH rc.7 publishes llm/adapters-updated synchronously from inside
  // registerAdapter(). Coalesce only Vision Router's listener: nested events
  // mark the topology dirty and the outer pass reruns to a fixed point, so we
  // neither double-register a twin nor lose a provider added mid-pass.
  const reconciledCtx = contextWithCoalescedAdapterUpdates(structuredCtx)
  // index.js historically passes image bytes as `options.input` to the async
  // execFile API. That option is not fed into child stdin, so Tesseract waits
  // for data until the OCR slice expires. Materialize only this exact
  // Tesseract-stdin call to a temporary image file; all other execFile calls
  // keep their native behavior.
  installTesseractExecFileCompat(reconciledCtx)

  // 启动诊断摘要只描述 composition/apply 的基础配置。设置服务可能稍后
  // 覆盖这些值；每个图片轮还会记录 current() 的实时决策，避免把这个
  // 启动快照误当成最终设置状态。
  try {
    const c = hardenedConfig && typeof hardenedConfig === 'object' ? hardenedConfig : {}
    const local = c.localOllama && typeof c.localOllama === 'object' ? c.localOllama : {}
    const lms = c.localLmStudio && typeof c.localLmStudio === 'object' ? c.localLmStudio : {}
    logging.logger.info(
      'vision-router: base config summary — contract=%s instantDescribe=%s localDescribeStyle=%s localOllama=%s localLmStudio=%s',
      rc7 ? 'rc7' : 'rc6',
      c.instantDescribe === true ? 'on' : 'off',
      c.localDescribeStyle === 'structured' ? 'structured' : 'plain',
      local.enabled === true ? 'on' : 'off',
      lms.enabled === true ? 'on' : 'off',
    )
  } catch {
    /* diagnostics must never break apply */
  }
  try {
    const result = core.apply(reconciledCtx, runtimeConfig)
    // DSH rc.7's Settings -> Models surface is backed by the configurable
    // provider directory, not by the live adapter registry alone. Publish the
    // main DeepSeek + 自动识图 route as a derived alias of official DeepSeek so
    // a reinstall restores the expected model-group row without making an
    // arbitrary textProvider look like DeepSeek. On rc.6 the helper is inert.
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
