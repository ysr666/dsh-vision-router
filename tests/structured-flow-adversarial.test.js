import test from 'node:test'
import assert from 'node:assert/strict'
import {
  installStructuredFlowHardening,
  producedUsableStructuredEvidence,
} from '../lib/structured-flow-hardening.js'

function harness(config = {}) {
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
  return { handlers, defs, wrapped }
}

async function preStep(h, session, turn = 1, messages = []) {
  const handler = h.handlers.get('agent/pre-step')
  assert.equal(typeof handler, 'function')
  return handler(
    { turn, agent: { session }, messages },
    async () => ({ kind: 'ok', messages }),
  )
}

function bootstrapSuccess(evidence) {
  return JSON.stringify({
    ok: true,
    phase: 'structured-bootstrap',
    evidence,
    next: 'continue',
  })
}

function stopGuard(decision) {
  return decision.messages.find((message) => String(message?.id).includes('structured-guard-stop'))
}

function mixedGuard(decision) {
  return decision.messages.find((message) => String(message?.id).includes('structured-mixed-guard'))
}

function evidenceGuard(decision) {
  return decision.messages.find((message) => String(message?.id).includes('structured-evidence-guard'))
}

test('quota evidence classifier rejects empty containers and metadata-only success', () => {
  for (const empty of [
    undefined,
    null,
    '',
    [],
    {},
    { ok: true },
    { elements: [] },
    { ok: true, elements: [] },
    JSON.stringify({ ok: true, elements: [] }),
  ]) {
    assert.equal(producedUsableStructuredEvidence(empty), false)
  }

  assert.equal(producedUsableStructuredEvidence('visible text'), true)
  assert.equal(producedUsableStructuredEvidence({ elements: [{ label: 'button' }] }), true)
  assert.equal(producedUsableStructuredEvidence({ match: false }), true)
  assert.equal(producedUsableStructuredEvidence({ count: 0 }), true)
})

test('explicit deep-dive cap applies globally even when bootstrap is not used', async () => {
  const h = harness({ visionDepth: 'standard', visionDepthMaxCalls: 1 })
  let calls = 0
  h.wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      calls += 1
      return 'usable evidence'
    },
  })

  const session = {}
  const exec = { agent: { session } }
  await preStep(h, session)
  assert.equal(await h.defs.get('vision_describe').execute({ question: 'first' }, exec), 'usable evidence')

  const blocked = JSON.parse(await h.defs.get('vision_describe').execute({ question: 'second' }, exec))
  assert.equal(blocked.code, 'VISION_DEPTH_LIMIT')
  assert.equal(calls, 1)

  const decision = await preStep(h, session)
  assert.match(stopGuard(decision)?.content?.[0]?.text ?? '', /深挖次数上限/)
})

test('empty successful-looking results do not consume the explicit call cap', async () => {
  const h = harness({ visionDepth: 'standard', visionDepthMaxCalls: 1 })
  let calls = 0
  h.wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      calls += 1
      return calls === 1
        ? JSON.stringify({ ok: true, elements: [] })
        : 'real evidence'
    },
  })

  const session = {}
  const exec = { agent: { session } }
  await preStep(h, session)
  assert.match(await h.defs.get('vision_describe').execute({ question: 'empty' }, exec), /"elements":\[\]/)
  assert.equal(await h.defs.get('vision_describe').execute({ question: 'real' }, exec), 'real evidence')
  const blocked = JSON.parse(await h.defs.get('vision_describe').execute({ question: 'third' }, exec))
  assert.equal(blocked.code, 'VISION_DEPTH_LIMIT')
  assert.equal(calls, 2)
})

test('three consecutive no-progress follow-ups trip a bounded fuse with unlimited cap and budget', async () => {
  const h = harness({ visionDepthMaxCalls: 0, visionTurnBudgetMs: 0 })
  let evidenceCalls = 0
  h.wrapped.tools.register({
    name: 'vision_bootstrap',
    async execute() {
      return bootstrapSuccess({ visual_kind: 'general', mixed_of: [] })
    },
  })
  h.wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      evidenceCalls += 1
      return JSON.stringify({ ok: true, elements: [] })
    },
  })

  const session = {}
  const exec = { agent: { session } }
  await preStep(h, session)
  await h.defs.get('vision_bootstrap').execute({}, exec)

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await h.defs.get('vision_describe').execute({ question: `attempt-${attempt}` }, exec)
    const decision = await preStep(h, session)
    if (attempt < 3) {
      assert.equal(Boolean(stopGuard(decision)), false)
    } else {
      assert.match(stopGuard(decision)?.content?.[0]?.text ?? '', /连续多次/)
    }
  }

  const blocked = JSON.parse(await h.defs.get('vision_describe').execute({ question: 'attempt-4' }, exec))
  assert.equal(blocked.code, 'VISION_NO_PROGRESS_LIMIT')
  assert.equal(evidenceCalls, 3)
})

test('a successful evidence advance resets the non-progress fuse', async () => {
  const h = harness({ visionDepthMaxCalls: 0, visionTurnBudgetMs: 0 })
  let evidenceCalls = 0
  h.wrapped.tools.register({
    name: 'vision_bootstrap',
    async execute() {
      return bootstrapSuccess({ visual_kind: 'general', mixed_of: [] })
    },
  })
  h.wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      evidenceCalls += 1
      if (evidenceCalls <= 2) return JSON.stringify({ ok: true, elements: [] })
      return 'usable evidence'
    },
  })

  const session = {}
  const exec = { agent: { session } }
  await preStep(h, session)
  await h.defs.get('vision_bootstrap').execute({}, exec)
  await h.defs.get('vision_describe').execute({ question: 'empty-1' }, exec)
  await preStep(h, session)
  await h.defs.get('vision_describe').execute({ question: 'empty-2' }, exec)
  await preStep(h, session)
  assert.equal(await h.defs.get('vision_describe').execute({ question: 'progress' }, exec), 'usable evidence')

  const decision = await preStep(h, session)
  assert.equal(Boolean(stopGuard(decision)), false)
})

test('mixed classification is advisory and one usable task-directed observation completes x>=1', async () => {
  const h = harness({ visionDepthMaxCalls: 0, visionTurnBudgetMs: 0 })
  h.wrapped.tools.register({
    name: 'vision_bootstrap',
    async execute() {
      return bootstrapSuccess({ visual_kind: 'mixed', mixed_of: ['document', 'ui'] })
    },
  })
  h.wrapped.tools.register({
    name: 'vision_describe',
    async execute() {
      return 'generic whole-image evidence relevant to the user task'
    },
  })

  const session = {}
  const exec = { agent: { session } }
  await preStep(h, session)
  await h.defs.get('vision_bootstrap').execute({}, exec)

  const before = await preStep(h, session)
  assert.equal(Boolean(mixedGuard(before)), false)
  assert.ok(evidenceGuard(before))

  assert.equal(
    await h.defs.get('vision_describe').execute({ question: 'verify what matters to the user' }, exec),
    'generic whole-image evidence relevant to the user task',
  )

  const complete = await preStep(h, session)
  assert.equal(Boolean(evidenceGuard(complete)), false)
  assert.equal(Boolean(mixedGuard(complete)), false)
})
