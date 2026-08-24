import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VISION_ROUTING_SETTINGS_PRELUDE,
  injectVisionRoutingSettingsPrelude,
} from '../lib/vision-routing-settings-prelude.js'

test('routing settings prelude injects once and survives the rc.8 loader swap', () => {
  const html = '<!doctype html><html><head><title>DSH</title></head><body></body></html>'
  const once = injectVisionRoutingSettingsPrelude(html)
  assert.match(once, /data-vision-router-routing-settings/)
  assert.equal(injectVisionRoutingSettingsPrelude(once), once)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /spec\.id === MODULE_ID/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /loader\.load/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /loader\.create/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /MODULE_ID = 'dsh-vision-router'/)
})

test('product UI exposes ordered/auto and balanced/quality/speed/local choices', () => {
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /MODE_VALUES = \['ordered', 'auto'\]/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /PREFERENCE_VALUES = \['balanced', 'quality', 'speed', 'local'\]/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /按设置顺序/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /自动选择/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /综合/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /质量/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /速度/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /本地/)
})

test('background profiling is a separate opt-in authority and UI defaults missing state to off', () => {
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /BACKGROUND_VALUES = \['off', 'local-free', 'all'\]/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /background: allowed\(value\.backgroundBenchmarking, BACKGROUND_VALUES, 'off'\)/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /后台补充能力数据/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /自动补测已关闭；未测模型仍按你的设置顺序执行/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /Auto开启时仅在空闲时补测本地或免费后端/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /Auto开启时会在空闲时补测所有已配置模型/)
  assert.doesNotMatch(VISION_ROUTING_SETTINGS_PRELUDE, /默认只在空闲时测本地或免费后端/)
})

test('Auto copy makes measurement non-blocking and evidence-driven', () => {
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /Auto只使用已有实测数据；未测能力保持你的设置顺序/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /你可以手动测评，也可以选择在空闲时自动补充能力数据/)
  assert.doesNotMatch(VISION_ROUTING_SETTINGS_PRELUDE, /自动选择会在后台渐进建立能力数据/)
})

test('routing choices reuse the stabilized SettingsScope and readback-safe save helper', () => {
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /ctx\.settingsScope\.bind\(\{ namespace: 'vision-router' \}\)/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /helpers\.shouldUseRemoteSettings/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /helpers\.createRemoteSettingsScope/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /helpers\.commitSettingsPlan/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /'routingMode'/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /'routingPreference'/)
  assert.doesNotMatch(VISION_ROUTING_SETTINGS_PRELUDE, /settings\.mutate/)
})

test('remote routing controls refresh on connection resets and settings document changes', () => {
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /ctx\.on\('connection\/reset', reloadRemote\)/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /ctx\.remote\.\$on\('settings\/document-updated'/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /namespace === 'vision-router'/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /state\.remoteDisposers/)
})

test('Auto settings surface shows product controls without a diagnostics or preview endpoint', () => {
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /Auto · 执行已启用/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /Auto · execution active/)
  assert.doesNotMatch(VISION_ROUTING_SETTINGS_PRELUDE, /routing-preview|PREVIEW_ENDPOINT|refreshPreview|buildPreview/)
  assert.doesNotMatch(VISION_ROUTING_SETTINGS_PRELUDE, /suite|fingerprint|barrier|runtime sample|transport|acceptance/i)
})

test('routing product panel stays scoped to the existing Vision Router chain UI without observer self-refresh', () => {
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /CHAIN_ROOT = '#vr-vision-backend-chain'/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /data-vr-routing-settings-panel/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /chain\.insertBefore\(panel, chain\.firstChild\)/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /MutationObserver/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /state\.panel\.isConnected === false/)
  assert.doesNotMatch(VISION_ROUTING_SETTINGS_PRELUDE, /new MutationObserver\(schedule\)/)
})
