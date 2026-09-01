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

function registerTools(harness, bootstrapEvidence) {
  harness.wrapped.tools.register({
    name: 'vision_bootstrap',
    async execute() {
      return JSON.stringify({
        ok: true,
        phase: 'structured-bootstrap',
        evidence: bootstrapEvidence,
        next: 'continue',
      })
    },
  })
  harness.wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      return 'visible evidence'
    },
  })
  return {
    bootstrap: harness.defs.get('vision_bootstrap'),
    describe: harness.defs.get('vision_describe'),
  }
}

function countGuard(decision, needle) {
  return (decision.messages ?? []).filter((message) => String(message?.id ?? '').includes(needle)).length
}

async function countRepeatedGuards(harness, session, needle, repeats = 20) {
  let total = 0
  for (let i = 0; i < repeats; i++) {
    total += countGuard(await preStep(harness, session, 1), needle)
  }
  return total
}

test('budget exhaustion emits at most one stop guard across repeated pre-steps', async () => {
  const originalNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    const harness = boot({ visionDepth: 'deep', visionTurnBudgetMs: 10_000 })
    const tools = registerTools(harness, { visual_kind: 'general', mixed_of: [] })
    const session = {}
    const exec = { agent: { session } }

    await preStep(harness, session, 1)
    await tools.bootstrap.execute({}, exec)
    now += 10_001
    const blocked = JSON.parse(await tools.describe.execute({}, exec))
    assert.equal(blocked.code, 'VISION_TURN_BUDGET_EXCEEDED')

    assert.equal(await countRepeatedGuards(harness, session, 'structured-guard-stop'), 1)
  } finally {
    Date.now = originalNow
  }
})

test('explicit call-cap exhaustion emits at most one stop guard across repeated pre-steps', async () => {
  const harness = boot({ visionDepth: 'fast', visionDepthMaxCalls: 1 })
  const tools = registerTools(harness, { visual_kind: 'general', mixed_of: [] })
  const session = {}
  const exec = { agent: { session } }

  await preStep(harness, session, 1)
  await tools.bootstrap.execute({}, exec)
  assert.equal(await tools.describe.execute({}, exec), 'visible evidence')
  const blocked = JSON.parse(await tools.describe.execute({}, exec))
  assert.equal(blocked.code, 'VISION_DEPTH_LIMIT')

  assert.equal(await countRepeatedGuards(harness, session, 'structured-guard-stop'), 1)
})

test('mixed guard is idempotent while state is unchanged and can advance once evidence changes', async () => {
  const harness = boot({ visionDepth: 'standard' })
  const tools = registerTools(harness, { visual_kind: 'mixed', mixed_of: ['ui', 'document'] })
  const session = {}
  const exec = { agent: { session } }

  await preStep(harness, session, 1)
  await tools.bootstrap.execute({}, exec)
  assert.equal(await countRepeatedGuards(harness, session, 'structured-mixed-guard'), 1)

  assert.equal(await tools.describe.execute({}, exec), 'visible evidence')
  assert.equal(await countRepeatedGuards(harness, session, 'structured-mixed-guard'), 1)
})

test('evidence guard is emitted only once across repeated pre-steps', async () => {
  const harness = boot({ visionDepth: 'standard' })
  const tools = registerTools(harness, { visual_kind: 'general', mixed_of: [] })
  const session = {}
  const exec = { agent: { session } }

  await preStep(harness, session, 1)
  await tools.bootstrap.execute({}, exec)
  assert.equal(await countRepeatedGuards(harness, session, 'structured-evidence-guard'), 1)
})

test('long text-only turns still emit no structured guard messages', async () => {
  const originalNow = Date.now
  let now = 2_000_000
  Date.now = () => now
  try {
    const harness = boot({ visionTurnBudgetMs: 10_000 })
    const session = {}
    await preStep(harness, session, 1)
    now += 60_000

    let total = 0
    for (let i = 0; i < 20; i++) {
      const decision = await preStep(harness, session, 1)
      total += (decision.messages ?? []).filter((message) => String(message?.id ?? '').includes('vision-router-structured-')).length
    }
    assert.equal(total, 0)
  } finally {
    Date.now = originalNow
  }
})
