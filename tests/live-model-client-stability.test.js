import assert from 'node:assert/strict'
import test from 'node:test'

import { LIVE_MODEL_CLIENT_PRELUDE } from '../lib/live-model-client-prelude.js'

test('live discovery progress does not masquerade as repeated adapter invalidations', () => {
  assert.equal(
    LIVE_MODEL_CLIENT_PRELUDE.includes('left.refreshing !== right.refreshing'),
    false,
    'refreshing is transport progress and must not invalidate the settings catalog',
  )
  assert.equal(LIVE_MODEL_CLIENT_PRELUDE.includes('var pendingEmit = false;'), true)
  assert.equal(LIVE_MODEL_CLIENT_PRELUDE.includes('if (changed) pendingEmit = true;'), true)
  assert.equal(LIVE_MODEL_CLIENT_PRELUDE.includes('if (next.refreshing) {\n            schedulePoll();'), true)
  assert.equal(
    LIVE_MODEL_CLIENT_PRELUDE.includes('if (pendingEmit) {\n              pendingEmit = false;\n              emit();'),
    true,
    'live model changes must publish once after the discovery batch settles',
  )
})
