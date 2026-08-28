import { installVisionRouterRemoteSettingsBridge } from '../remote-settings-bridge.js'
import { installSettingsRc8ClientLifecycle } from '../settings-client-rc8-lifecycle.js'

export function installVisionRemoteSettingsClient(ctx, logger) {
  installVisionRouterRemoteSettingsBridge(ctx, logger)
  installSettingsRc8ClientLifecycle(ctx)
  return ctx
}
