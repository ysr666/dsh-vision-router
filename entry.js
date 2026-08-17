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
import { installLocalVisionStabilizer } from './lib/local-vision-stabilizer.js'

// Schemastery object schemas expose set() as the supported way to replace a
// field schema. This mutates the Config object that index.js itself later uses
// for the settings namespace, so composition config and settings validation
// agree on the same default.
core.Config.set('progressiveTools', z.boolean().default(false))

export * from './index.js'
export const Config = core.Config

// Defense in depth for direct/programmatic callers that invoke apply() without
// first running the Cordis Config resolver: only an explicit true enables the
// schema-changing progressive mode. The wrapped context changes logger plus a
// private llm view used only by Vision Router: wrapper -> delegate calls can
// restore adapter-owned replay identity without mutating the host LLM service.
export function apply(ctx, config = {}) {
  const logging = installVisionRouterFileLogging(ctx)
  const runtimeCtx = contextWithDelegatedReplay(logging.ctx)
  // #141 stabilization boundary: keep the recently merged local-vision
  // behavior isolated from main's existing provider/router semantics. It
  // normalizes only the local settings/runtime seams before core.apply sees
  // the context (desktop screenshot exposure, instant-local budget/one-pass,
  // local vision-http transport and connection-probe fallback).
  const { ctx: stabilizedCtx, bootConfig } = installLocalVisionStabilizer(runtimeCtx, config, core)
  // 启动诊断摘要只描述 composition/apply 的基础配置。设置服务可能稍后
  // 覆盖这些值；每个图片轮还会记录 current() 的实时决策，避免把这个
  // 启动快照误当成最终设置状态。
  try {
    const c = config && typeof config === 'object' ? config : {}
    const local = c.localOllama && typeof c.localOllama === 'object' ? c.localOllama : {}
    const lms = c.localLmStudio && typeof c.localLmStudio === 'object' ? c.localLmStudio : {}
    logging.logger.info(
      'vision-router: base config summary — instantDescribe=%s localDescribeStyle=%s localOllama=%s localLmStudio=%s',
      c.instantDescribe === true ? 'on' : 'off',
      c.localDescribeStyle === 'structured' ? 'structured' : 'plain',
      local.enabled === true ? 'on' : 'off',
      lms.enabled === true ? 'on' : 'off',
    )
  } catch {
    /* diagnostics must never break apply */
  }
  try {
    const result = core.apply(stabilizedCtx, {
      ...bootConfig,
      progressiveTools: config.progressiveTools === true,
    })
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
