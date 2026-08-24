import test from 'node:test'
import assert from 'node:assert/strict'
import { installStructuredFlowHardening } from '../lib/structured-flow-hardening.js'

function boot(config = {}) {
  const handlers = new Map()
  const defs = new Map()
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    tools: {
      register(def) {
        defs.set(def.name, def)
        return () => defs.delete(def.name)
      },
    },
  }
  const wrapped = installStructuredFlowHardening(ctx, config)
  wrapped.on('agent/pre-step', async (_payload, next) => next())
  return { wrapped, handlers, defs }
}

async function preStep(harness, session, turn = 1, messages = []) {
  const handler = harness.handlers.get('agent/pre-step')
  assert.ok(handler)
  return handler(
    { turn, agent: { session }, messages },
    async () => ({ kind: 'ok', messages }),
  )
}

test('long text-only turns never consume the structured vision budget', async () => {
  const originalNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    const harness = boot({ visionTurnBudgetMs: 10_000 })
    const session = {}

    await preStep(harness, session, 1)
    now += 60_000
    const decision = await preStep(harness, session, 1)

    assert.equal(
      decision.messages.some((message) => String(message.id).includes('structured-guard-stop')),
      false,
      'ordinary model thinking must not start or exhaust a vision-only budget',
    )
  } finally {
    Date.now = originalNow
  }
})

test('default structured vision turn budget is 180 seconds, not the historical 90 seconds', async () => {
  const originalNow = Date.now
  let now = 1_500_000
  Date.now = () => now
  try {
    const harness = boot()
    const session = {}
    harness.wrapped.tools.register({
      name: 'vision_describe',
      async execute() { return 'visible evidence' },
    })

    await preStep(harness, session, 1)
    const result = await harness.defs.get('vision_describe').execute({}, { agent: { session } })
    assert.equal(result, 'visible evidence')

    now += 90_001
    const afterHistoricalLimit = await preStep(harness, session, 1)
    assert.equal(
      afterHistoricalLimit.messages.some((message) => String(message.id).includes('structured-guard-stop')),
      false,
      'the old 90s fallback must no longer terminate an image turn',
    )

    now += 90_000
    const afterNewLimit = await preStep(harness, session, 1)
    const stop = afterNewLimit.messages.find((message) => String(message.id).includes('structured-guard-stop'))
    assert.ok(stop)
    assert.match(stop.content[0].text, /视觉总时间预算已耗尽/)
  } finally {
    Date.now = originalNow
  }
})

test('the structured vision budget starts on the first actual visual tool call', async () => {
  const originalNow = Date.now
  let now = 2_000_000
  Date.now = () => now
  try {
    const harness = boot({ visionTurnBudgetMs: 10_000 })
    const session = {}
    harness.wrapped.tools.register({
      name: 'vision_describe',
      async execute() { return 'visible evidence' },
    })

    await preStep(harness, session, 1)
    now += 60_000
    const beforeVision = await preStep(harness, session, 1)
    assert.equal(
      beforeVision.messages.some((message) => String(message.id).includes('structured-guard-stop')),
      false,
    )

    const result = await harness.defs.get('vision_describe').execute({}, { agent: { session } })
    assert.equal(result, 'visible evidence')

    now += 10_001
    const afterVision = await preStep(harness, session, 1)
    const stop = afterVision.messages.find((message) => String(message.id).includes('structured-guard-stop'))
    assert.ok(stop)
    assert.match(stop.content[0].text, /视觉总时间预算已耗尽/)
  } finally {
    Date.now = originalNow
  }
})
