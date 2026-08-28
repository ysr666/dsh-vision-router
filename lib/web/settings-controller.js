import { installSettingsLimitClientPrelude } from '../settings-limit-client-prelude.js'

export function installVisionSettingsController(ctx) {
  installSettingsLimitClientPrelude(ctx)
  return ctx
}
