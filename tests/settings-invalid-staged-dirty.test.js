import assert from 'node:assert/strict'
import test from 'node:test'

import { SETTINGS_NATIVE_CARD_IA_PRELUDE } from '../lib/settings-native-card-layout.js'

test('invalid special-row drafts still participate in the root and per-card dirty contract', () => {
  assert.match(SETTINGS_NATIVE_CARD_IA_PRELUDE, /invalidChainDraft=chainDraft!==undefined&&!validChain\(chainRows\(\)\)/)
  assert.match(SETTINGS_NATIVE_CARD_IA_PRELUDE, /invalidGuidanceDraft=guidanceDraft!==undefined&&!validGuidance\(guidanceRows\(\)\)/)
  assert.match(SETTINGS_NATIVE_CARD_IA_PRELUDE, /invalidWrapperDraft=wrapperDraft!==undefined&&!validWrapperRows\(wrapperRows\(\)\)/)
  assert.match(SETTINGS_NATIVE_CARD_IA_PRELUDE, /cardDirty=dirty\|\|invalidChainDraft\|\|invalidGuidanceDraft\|\|invalidWrapperDraft/)
  assert.match(SETTINGS_NATIVE_CARD_IA_PRELUDE, /if\(id===['"]strategy['"]&&invalidGuidanceDraft\)return true/)
  assert.match(SETTINGS_NATIVE_CARD_IA_PRELUDE, /if\(id===['"]advanced['"]&&invalidWrapperDraft\)return true/)
  assert.match(SETTINGS_NATIVE_CARD_IA_PRELUDE, /['"]data-vr-dirty['"]:cardDirty\?['"]1['"]:['"]0['"]/)
})
