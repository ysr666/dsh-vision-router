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
  // 探针：apply 后 2s 写一行——若探针缺失，说明 file-logger sink 在 apply
  // 之后立即失效（写入失败被静默禁用），日志空白是 sink 问题而非业务未执行。
  try {
    setTimeout(() => {
      logging.logger.info('vision-router: post-apply probe')
    }, 2000).unref?.()
  } catch {
    /* probe must never break apply */
  }
  // 启动诊断摘要：配置从哪来、本地后端/即时翻译是否启用，一眼可查。
  // settings 层可能过滤掉部分 key（如 instantDescribe），摘要让这类问题
  // 不再"静默"——重启后看日志即可确认运行时真实状态。
  try {
    const c = config && typeof config === 'object' ? config : {}
    const local = c.localOllama && typeof c.localOllama === 'object' ? c.localOllama : {}
    const lms = c.localLmStudio && typeof c.localLmStudio === 'object' ? c.localLmStudio : {}
    logging.logger.info(
      'vision-router: apply config summary — instantDescribe=%s localDescribeStyle=%s localOllama=%s localLmStudio=%s',
      c.instantDescribe === true ? 'on' : 'off',
      c.localDescribeStyle === 'structured' ? 'structured' : 'plain',
      local.enabled === true ? 'on' : 'off',
      lms.enabled === true ? 'on' : 'off',
    )
  } catch {
    /* diagnostics must never break apply */
  }
  try {
    const result = core.apply(runtimeCtx, {
      ...config,
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
