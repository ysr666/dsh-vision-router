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

test('a settled save only collapses the disclosure that started that save', () => {
  assert.match(SETTINGS_NATIVE_CARD_IA_PRELUDE, /setCardsOpen\(function\(previous\)/)
  assert.match(SETTINGS_NATIVE_CARD_IA_PRELUDE, /previous\[id\]!==true/)
  assert.match(SETTINGS_NATIVE_CARD_IA_PRELUDE, /delete next\[id\]/)
  assert.doesNotMatch(SETTINGS_NATIVE_CARD_IA_PRELUDE, /setCardsOpen\(\{\}\);\s*setSaveState\(\{status:['"]saved['"]/)
})

test('disclosure toggles are card-local instead of accordion-wide', () => {
  assert.match(
    SETTINGS_NATIVE_CARD_IA_PRELUDE,
    /function toggleCard\(id\)\{setCardsOpen\(function\(previous\)\{var next=Object\.assign\(\{\},previous\);if\(next\[id\]===true\)delete next\[id\];else next\[id\]=true;return next;\}\);\}/,
  )
  assert.doesNotMatch(SETTINGS_NATIVE_CARD_IA_PRELUDE, /setPage\(opened\?['"]['"]:id\)/)
})