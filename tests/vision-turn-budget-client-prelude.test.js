import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VISION_TURN_BUDGET_CLIENT_PRELUDE,
  injectVisionTurnBudgetClientPrelude,
  installVisionTurnBudgetClientPrelude,
} from '../lib/vision-turn-budget-client-prelude.js'

test('settings limits prelude keeps turn budget unlimited by default', () => {
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /TURN_BUDGET_FIELD = 'visionTurnBudgetMs'/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /DEFAULT_TURN_BUDGET_MS = 0/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /MIN_TURN_BUDGET_MS = 10000/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /MAX_TURN_BUDGET_MS = 600000/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /parsed === 0/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /scope\.set\(TURN_BUDGET_FIELD, parsed\)/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /默认不限制；填 0 表示不限制/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /Unlimited by default; enter 0 for unlimited/)
})

test('turn-budget prelude does not own depth strategy or call-cap UI', () => {
  assert.doesNotMatch(VISION_TURN_BUDGET_CLIENT_PRELUDE, /DEPTH_CAP_FIELD|DEPTH_FIELD|makeDepthCapCard/)
  assert.doesNotMatch(VISION_TURN_BUDGET_CLIENT_PRELUDE, /stripLegacyCustomOption|projectStrategySnapshot|visionDepthFast/)
  assert.doesNotMatch(VISION_TURN_BUDGET_CLIENT_PRELUDE, /限制深挖次数|Limit deep-dive calls/)
})


test('settings limits prelude injection is idempotent and stays inside head when available', () => {
  const html = '<html><head><title>DSH</title></head><body></body></html>'
  const once = injectVisionTurnBudgetClientPrelude(html)
  const twice = injectVisionTurnBudgetClientPrelude(once)
  assert.equal(once, twice)
  assert.equal((once.match(/data-vision-router-turn-budget/g) ?? []).length, 1)
  assert.ok(once.indexOf('data-vision-router-turn-budget') < once.indexOf('</head>'))
})

test('installer registers one Web index transform through the Host lifecycle', () => {
  let deps
  let effectLabel
  let transform
  const ctx = {
    inject(dependencies, callback) {
      deps = dependencies
      callback({
        effect(factory, label) {
          effectLabel = label
          factory()
        },
        webServer: {
          tapIndex(fn) {
            transform = fn
            return () => {}
          },
        },
      })
    },
  }

  installVisionTurnBudgetClientPrelude(ctx)
  assert.deepEqual(deps, ['webServer'])
  assert.equal(effectLabel, 'vision-router: turn budget client prelude')
  assert.equal(typeof transform, 'function')
})
