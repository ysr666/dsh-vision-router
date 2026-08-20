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

test('routing choices reuse the stabilized SettingsScope and readback-safe save helper', () => {
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /ctx\.settingsScope\.bind\(\{ namespace: 'vision-router' \}\)/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /helpers\.shouldUseRemoteSettings/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /helpers\.createRemoteSettingsScope/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /helpers\.commitSettingsPlan/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /'routingMode'/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /'routingPreference'/)
  assert.doesNotMatch(VISION_ROUTING_SETTINGS_PRELUDE, /settings\.mutate/)
})

test('Auto preview is GET-only, read-only and explicitly does not claim live execution', () => {
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /PREVIEW_ENDPOINT = '\/_dsh\/vision-router\/routing-preview'/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /method: 'GET'/)
  assert.doesNotMatch(VISION_ROUTING_SETTINGS_PRELUDE, /method:\s*'POST'/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /Auto选择预览/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /不会改变实际识图执行顺序/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /does not change actual vision execution/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /只使用7天内的直接Benchmark结果/)
})

test('routing product panel stays scoped to the existing Vision Router chain UI without observer self-refresh', () => {
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /CHAIN_ROOT = '#vr-vision-backend-chain'/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /data-vr-routing-settings-panel/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /chain\.insertBefore\(panel, chain\.firstChild\)/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /MutationObserver/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /state\.panel\.isConnected === false/)
  assert.doesNotMatch(VISION_ROUTING_SETTINGS_PRELUDE, /new MutationObserver\(schedule\)/)
})
