import assert from 'node:assert/strict'
import test from 'node:test'

import { SETTINGS_NATIVE_CARD_IA_PRELUDE } from '../lib/settings-native-card-layout.js'

test('guide replay cannot discard staged edits and leaves Settings before starting chat guidance', () => {
  assert.match(
    SETTINGS_NATIVE_CARD_IA_PRELUDE,
    /if\(dirty\|\|typeof helpers\.startVisionSettingsGuide!==['"]function['"]\)return/,
  )
  assert.match(
    SETTINGS_NATIVE_CARD_IA_PRELUDE,
    /disabled:dirty\|\|typeof helpers\.startVisionSettingsGuide!==['"]function['"]/,
  )
  assert.match(
    SETTINGS_NATIVE_CARD_IA_PRELUDE,
    /new KeyboardEvent\(['"]keydown['"],\{key:['"]Escape['"],bubbles:true,cancelable:true\}\)/,
  )
  const closeAt = SETTINGS_NATIVE_CARD_IA_PRELUDE.indexOf("key:'Escape'")
  const frameAt = SETTINGS_NATIVE_CARD_IA_PRELUDE.indexOf('window.requestAnimationFrame(start)')
  const startAt = SETTINGS_NATIVE_CARD_IA_PRELUDE.indexOf('helpers.startVisionSettingsGuide();')
  assert.ok(closeAt >= 0)
  assert.ok(startAt > closeAt)
  assert.ok(frameAt > closeAt)
  assert.doesNotMatch(SETTINGS_NATIVE_CARD_IA_PRELUDE, /data-vr-guide-bridge/)
})
