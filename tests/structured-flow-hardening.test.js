import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  installStructuredFlowHardening,
  normalizeGuidanceOverrides,
  producedStructuredEvidence,
  structuredDepthLimit,
} from '../lib/structured-flow-hardening.js'

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

function registerFlowTools(harness, bootstrapBody, evidenceBody) {
  let bootstrapCalls = 0
  let evidenceCalls = 0
  harness.wrapped.tools.register({
    name: 'vision_bootstrap',
    async execute(args, exec) {
      bootstrapCalls += 1
      return bootstrapBody(args, exec, bootstrapCalls)
    },
  })
  harness.wrapped.tools.register({
    name: 'vision_describe',
    async execute(args, exec) {
      evidenceCalls += 1
      return evidenceBody(args, exec, evidenceCalls)
    },
  })
  return {
    bootstrap: () => harness.defs.get('vision_bootstrap'),
    describe: () => harness.defs.get('vision_describe'),
    counts: () => ({ bootstrapCalls, evidenceCalls }),
  }
}

async function preStep(harness, session, turn = 1, messages = []) {
  const handler = harness.handlers.get('agent/pre-step')
  assert.ok(handler)
  return handler(
    { turn, agent: { session }, messages },
    async () => ({ kind: 'ok', messages }),
  )
}

const bootstrapSuccess = (evidence) => JSON.stringify({
  ok: true,
  phase: 'structured-bootstrap',
  evidence,
  next: 'continue',
})

test('structured depth limits are hard: fast=1, standard=2, deep=4', () => {
  assert.equal(structuredDepthLimit('fast'), 1)
  assert.equal(structuredDepthLimit('standard'), 2)
  assert.equal(structuredDepthLimit('deep'), 4)
  assert.equal(structuredDepthLimit('bogus'), 2)
})

test('evidence classifier rejects empty and ok:false results', () => {
  assert.equal(producedStructuredEvidence(undefined), false)
  assert.equal(producedStructuredEvidence(null), false)
  assert.equal(producedStructuredEvidence(''), false)
  assert.equal(producedStructuredEvidence('   '), false)
  assert.equal(producedStructuredEvidence({}), false)
  assert.equal(producedStructuredEvidence(JSON.stringify({ ok: false, code: 'X' })), false)
  assert.equal(producedStructuredEvidence('plain visible evidence'), true)
  assert.equal(producedStructuredEvidence([]), true)
  assert.equal(producedStructuredEvidence({ elements: [] }), true)
  assert.equal(producedStructuredEvidence({ ok: true }), true)
})

test('guidance overrides are bounded, valid-only and last-wins', () => {
  const huge = 'x'.repeat(5000)
  const normalized = normalizeGuidanceOverrides([
    { kind: 'ui', text: 'first' },
    { kind: 'bogus', text: 'ignored' },
    { kind: 'document', text: huge },
    { kind: 'ui', text: 'second' },
  ])
  assert.deepEqual(normalized.map((row) => row.kind), ['ui', 'document'])
  assert.equal(normalized.find((row) => row.kind === 'ui').text, 'second')
  assert.equal(normalized.find((row) => row.kind === 'document').text.length, 2000)
})

test('bootstrap is one-shot per turn and repeated calls never hit the backend', async () => {
  const harness = boot({ visionDepth: 'fast' })
  const tools = registerFlowTools(
    harness,
    () => bootstrapSuccess({ visual_kind: 'general', mixed_of: [] }),
    () => 'evidence',
  )
  const session = {}
  const exec = { agent: { session } }
  await preStep(harness, session, 1)

  const first = await tools.bootstrap().execute({}, exec)
  const second = await tools.bootstrap().execute({}, exec)
  assert.equal(second, first)
  assert.deepEqual(tools.counts(), { bootstrapCalls: 1, evidenceCalls: 0 })

  await tools.describe().execute({}, exec)
  const third = JSON.parse(await tools.describe().execute({}, exec))
  assert.equal(third.code, 'VISION_DEPTH_LIMIT')
  assert.deepEqual(tools.counts(), { bootstrapCalls: 1, evidenceCalls: 1 })
})

test('standard tier blocks the third successful deep-dive before tool execution', async () => {
  const harness = boot({ visionDepth: 'standard' })
  const tools = registerFlowTools(
    harness,
    () => bootstrapSuccess({ visual_kind: 'general', mixed_of: [] }),
    () => 'evidence',
  )
  const session = {}
  const exec = { agent: { session } }
  await preStep(harness, session, 1)
  await tools.bootstrap().execute({}, exec)
  assert.equal(await tools.describe().execute({}, exec), 'evidence')
  assert.equal(await tools.describe().execute({}, exec), 'evidence')
  const blocked = JSON.parse(await tools.describe().execute({}, exec))
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'VISION_DEPTH_LIMIT')
  assert.equal(tools.counts().evidenceCalls, 2)
})

test('mixed flow remains incomplete after only one branch and clears after two', async () => {
  const harness = boot({
    visionDepth: 'standard',
    guidanceOverrides: [{ kind: 'document', text: 'CUSTOM DOCUMENT CHECK' }],
  })
  const tools = registerFlowTools(
    harness,
    () => bootstrapSuccess({ visual_kind: 'mixed', mixed_of: ['document', 'ui'] }),
    () => 'evidence',
  )
  const session = {}
  const exec = { agent: { session } }
  await preStep(harness, session, 1)
  await tools.bootstrap().execute({}, exec)

  const before = await preStep(harness, session, 1)
  const firstGuard = before.messages.find((message) => String(message.id).includes('structured-mixed-guard'))
  assert.ok(firstGuard)
  assert.match(firstGuard.content[0].text, /ui/)
  assert.match(firstGuard.content[0].text, /CUSTOM DOCUMENT CHECK/)

  await tools.describe().execute({}, exec)
  const halfDone = await preStep(harness, session, 1)
  const halfGuard = halfDone.messages.find((message) => String(message.id).includes('structured-mixed-guard'))
  assert.ok(halfGuard, 'one successful evidence call must not complete a two-branch mixed flow')
  assert.match(halfGuard.content[0].text, /document/)

  await tools.describe().execute({}, exec)
  const complete = await preStep(harness, session, 1)
  assert.equal(
    complete.messages.some((message) => String(message.id).includes('structured-mixed-guard')),
    false,
  )
})

test('empty evidence cannot silently complete the required x>=1 step', async () => {
  const harness = boot({ visionDepth: 'standard' })
  const tools = registerFlowTools(
    harness,
    () => bootstrapSuccess({ visual_kind: 'general', mixed_of: [] }),
    () => '',
  )
  const session = {}
  const exec = { agent: { session } }
  await preStep(harness, session, 1)
  await tools.bootstrap().execute({}, exec)
  await tools.describe().execute({}, exec)
  const decision = await preStep(harness, session, 1)
  assert.equal(
    decision.messages.some((message) => String(message.id).includes('structured-evidence-guard')),
    true,
  )
})

test('turn budget stops new visual calls and removes impossible followup reminders', async () => {
  const originalNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    const harness = boot({ visionDepth: 'deep', visionTurnBudgetMs: 10_000 })
    const tools = registerFlowTools(
      harness,
      () => bootstrapSuccess({ visual_kind: 'mixed', mixed_of: ['ui', 'document'] }),
      () => 'evidence',
    )
    const session = {}
    const exec = { agent: { session } }
    await preStep(harness, session, 1)
    await tools.bootstrap().execute({}, exec)
    now += 10_001
    const blocked = JSON.parse(await tools.describe().execute({}, exec))
    assert.equal(blocked.code, 'VISION_TURN_BUDGET_EXCEEDED')
    assert.equal(tools.counts().evidenceCalls, 0)

    const decision = await preStep(harness, session, 1)
    assert.equal(
      decision.messages.some((message) => String(message.id).includes('structured-mixed-guard')),
      false,
    )
    const stop = decision.messages.find((message) => String(message.id).includes('structured-guard-stop'))
    assert.ok(stop)
    assert.match(stop.content[0].text, /总时间预算已耗尽/)
  } finally {
    Date.now = originalNow
  }
})
