import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VISION_TURN_BUDGET_CLIENT_PRELUDE,
  injectVisionTurnBudgetClientPrelude,
  installVisionTurnBudgetClientPrelude,
} from '../lib/vision-turn-budget-client-prelude.js'

test('turn-budget prelude exposes the existing Host field with the schema bounds', () => {
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /visionTurnBudgetMs/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /MIN_MS = 10000/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /MAX_MS = 600000/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /scope\.set\(FIELD, parsed\)/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /普通模型思考、原生多模态直接看图不会启动此计时/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /native multimodal image processing do not start this timer/)
})

test('turn-budget prelude injection is idempotent and stays inside head when available', () => {
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
