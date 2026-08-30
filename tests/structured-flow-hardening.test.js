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

test('structured depth limits are hard: fast=1, standard=2, deep=4, custom=N', () => {
  assert.equal(structuredDepthLimit('fast'), 1)
  assert.equal(structuredDepthLimit('standard'), 2)
  assert.equal(structuredDepthLimit('deep'), 4)
  assert.equal(structuredDepthLimit('bogus'), 2)
  assert.equal(structuredDepthLimit('custom', 1), 1)
  assert.equal(structuredDepthLimit('custom', 6), 6)
  assert.equal(structuredDepthLimit('custom', 101), 100)
  assert.equal(structuredDepthLimit('custom', 0), undefined)
  assert.equal(structuredDepthLimit('custom', undefined), undefined)
  assert.equal(structuredDepthLimit('fast', 9), 1)
  assert.equal(structuredDepthLimit('standard', 9), 2)
  assert.equal(structuredDepthLimit('deep', 9), 4)
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

test('custom tier uses its own N and can exceed the built-in deep=4 cap', async () => {
  const harness = boot({ visionDepth: 'custom', visionDepthMaxCalls: 6 })
  const tools = registerFlowTools(
    harness,
    () => bootstrapSuccess({ visual_kind: 'general', mixed_of: [] }),
    () => 'evidence',
  )
  const session = {}
  const exec = { agent: { session } }
  await preStep(harness, session, 1)
  await tools.bootstrap().execute({}, exec)
  for (let i = 0; i < 6; i++) assert.equal(await tools.describe().execute({}, exec), 'evidence')
  const blocked = JSON.parse(await tools.describe().execute({}, exec))
  assert.equal(blocked.code, 'VISION_DEPTH_LIMIT')
  assert.equal(tools.counts().evidenceCalls, 6)
})

test('custom zero is unlimited while retained custom values are inactive on built-in tiers', async () => {
  const customHarness = boot({ visionDepth: 'custom', visionDepthMaxCalls: 0 })
  const customTools = registerFlowTools(
    customHarness,
    () => bootstrapSuccess({ visual_kind: 'general', mixed_of: [] }),
    () => 'evidence',
  )
  const customSession = {}
  const customExec = { agent: { session: customSession } }
  await preStep(customHarness, customSession, 1)
  await customTools.bootstrap().execute({}, customExec)
  for (let i = 0; i < 7; i++) assert.equal(await customTools.describe().execute({}, customExec), 'evidence')
  assert.equal(customTools.counts().evidenceCalls, 7)

  const deepHarness = boot({ visionDepth: 'deep', visionDepthMaxCalls: 2 })
  const deepTools = registerFlowTools(
    deepHarness,
    () => bootstrapSuccess({ visual_kind: 'general', mixed_of: [] }),
    () => 'evidence',
  )
  const deepSession = {}
  const deepExec = { agent: { session: deepSession } }
  await preStep(deepHarness, deepSession, 1)
  await deepTools.bootstrap().execute({}, deepExec)
  for (let i = 0; i < 4; i++) assert.equal(await deepTools.describe().execute({}, deepExec), 'evidence')
  const deepBlocked = JSON.parse(await deepTools.describe().execute({}, deepExec))
  assert.equal(deepBlocked.code, 'VISION_DEPTH_LIMIT')
  assert.equal(deepTools.counts().evidenceCalls, 4)
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

test('running structured tool clamps core network/OCR timeouts to remaining turn budget', async () => {
  const originalNow = Date.now
  let now = 2_000_000
  Date.now = () => now
  try {
    const handlers = new Map()
    const defs = new Map()
    const liveConfig = {
      visionDepth: 'standard',
      visionTurnBudgetMs: 10_000,
      timeoutMs: 120_000,
      visionTaskTimeoutMs: 45_000,
      ocrTimeoutMs: 30_000,
    }
    const rawScope = {
      get() { return liveConfig },
      watch() { return () => {} },
    }
    const settingsChild = {
      settings: {
        register(namespace) {
          assert.equal(namespace, 'vision-router')
          return rawScope
        },
      },
      effect(factory) { return factory() },
    }
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
      inject(dependencies, callback) {
        if (dependencies.includes('settings')) callback(settingsChild)
      },
    }
    const wrapped = installStructuredFlowHardening(ctx, liveConfig)
    let coreScope
    wrapped.inject(['settings'], (child) => {
      coreScope = child.settings.register('vision-router', {}, { base: liveConfig })
    })
    wrapped.on('agent/pre-step', async (_payload, next) => next())

    let observed
    wrapped.tools.register({
      name: 'vision_bootstrap',
      async execute() {
        now += 9_750
        observed = coreScope.get()
        return bootstrapSuccess({ visual_kind: 'general', mixed_of: [] })
      },
    })

    const session = {}
    const handler = handlers.get('agent/pre-step')
    await handler(
      { turn: 1, agent: { session }, messages: [] },
      async () => ({ kind: 'ok', messages: [] }),
    )
    const result = await defs.get('vision_bootstrap').execute({}, { agent: { session } })
    assert.equal(JSON.parse(result).ok, true)
    assert.ok(observed)
    assert.equal(observed.timeoutMs, 250)
    assert.equal(observed.visionTaskTimeoutMs, 250)
    assert.equal(observed.ocrTimeoutMs, 250)
    assert.equal(observed.visionTurnBudgetMs, 10_000, 'policy value itself is not rewritten')
  } finally {
    Date.now = originalNow
  }
})
