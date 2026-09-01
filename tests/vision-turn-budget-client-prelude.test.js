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

test('depth strategy copy is bilingual and contains no built-in count promise', () => {
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /快速（优先整体判断）/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /标准（按需查证，默认）/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /细致（主动交叉验证）/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /Quick \(overall-first\)/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /Standard \(evidence as needed, default\)/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /Thorough \(proactive cross-checking\)/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /看图深度只决定识图策略，不限制调用次数/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /Vision depth chooses the inspection strategy, not a call-count limit/)
  assert.doesNotMatch(VISION_TURN_BUDGET_CLIENT_PRELUDE, /Standard remains capped at 2|标准档仍固定最多 2 次/)
})

test('depth call cap is a separate opt-in checkbox backed by maxCalls=0/positive', () => {
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /DEPTH_CAP_FIELD = 'visionDepthMaxCalls'/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /depthCapTitle: '限制深挖次数'/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /depthCapTitle: 'Limit deep-dive calls'/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /type: 'checkbox'/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /savedEnabled = saved > 0/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /desired = enabled && validCap \? parsed : 0/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /scope\.set\(DEPTH_CAP_FIELD, desired\)/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /MIN_DEPTH_CAP = 1/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /MAX_DEPTH_CAP = 100/)
})

test('legacy custom strategy is projected to standard and hidden by stable option values', () => {
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /snapshot\.value\[DEPTH_FIELD\] !== 'custom'/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /visionDepth: 'standard'/)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /values\.has\('fast'\).*values\.has\('standard'\).*values\.has\('deep'\).*values\.has\('custom'\)/s)
  assert.match(VISION_TURN_BUDGET_CLIENT_PRELUDE, /node\.props\.value === 'custom'/)
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
