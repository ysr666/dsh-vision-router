import assert from 'node:assert/strict'
import test from 'node:test'

import { SETTINGS_NATIVE_CARD_IA_PRELUDE } from '../lib/settings-native-card-layout.js'

test('native cards cannot bypass staged edits through immediate reset', () => {
  assert.match(
    SETTINGS_NATIVE_CARD_IA_PRELUDE,
    /async function resetField\(key\)\{if\(cardDirty\|\|!scope\|\|typeof scope\.unset!==['"]function['"]\|\|!writable\|\|saving\)return/,
  )
  assert.match(
    SETTINGS_NATIVE_CARD_IA_PRELUDE,
    /className:['"]vr-reset['"],disabled:cardDirty\|\|!writable\|\|saving/,
  )
})

test('a settled save only collapses the card that started that save', () => {
  assert.match(
    SETTINGS_NATIVE_CARD_IA_PRELUDE,
    /setPage\(function\(current\)\{return current===id\?['"]['"]:current;\}\)/,
  )
  assert.doesNotMatch(
    SETTINGS_NATIVE_CARD_IA_PRELUDE,
    /setSaveState\(\{status:['"]saved['"],page:id\}\);\s*setPage\(['"]['"]\)/,
  )
})
