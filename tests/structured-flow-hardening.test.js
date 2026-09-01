import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  installStructuredFlowHardening,
  normalizeGuidanceOverrides,
  producedStructuredEvidence,
  structuredDepthLimit,
} from '../lib/structured-flow-hardening.js'

function boot(config = {}, localePreference) {
  const handlers = new Map()
  const defs = new Map()
  const settingsService = localePreference
    ? { get(namespace) { return namespace === 'locale' ? { preference: localePreference } : undefined } }
    : undefined
  const ctx = {
    get(name) { return name === 'settings' ? settingsService : undefined },
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

test('structured depth limit is explicit-only and independent of strategy', () => {
  for (const depth of ['fast', 'standard', 'deep', 'custom', 'bogus']) {
    assert.equal(structuredDepthLimit(depth), undefined)
    assert.equal(structuredDepthLimit(depth, 0), undefined)
    assert.equal(structuredDepthLimit(depth, 1), 1)
    assert.equal(structuredDepthLimit(depth, 6), 6)
    assert.equal(structuredDepthLimit(depth, 101), 100)
  }
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

test('bootstrap is one-shot per turn while fast strategy does not cap evidence calls', async () => {
  const harness = boot({ visionDepth: 'fast', visionDepthMaxCalls: 0 })
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

  for (let i = 0; i < 4; i++) assert.equal(await tools.describe().execute({}, exec), 'evidence')
  assert.deepEqual(tools.counts(), { bootstrapCalls: 1, evidenceCalls: 4 })
})

test('standard strategy does not block the third or later successful deep-dive', async () => {
  const harness = boot({ visionDepth: 'standard', visionDepthMaxCalls: 0 })
  const tools = registerFlowTools(
    harness,
    () => bootstrapSuccess({ visual_kind: 'general', mixed_of: [] }),
    () => 'evidence',
  )
  const session = {}
  const exec = { agent: { session } }
  await preStep(harness, session, 1)
  await tools.bootstrap().execute({}, exec)
  for (let i = 0; i < 7; i++) assert.equal(await tools.describe().execute({}, exec), 'evidence')
  assert.equal(tools.counts().evidenceCalls, 7)
})

test('explicit positive cap blocks the next call regardless of strategy', async () => {
  const harness = boot({ visionDepth: 'standard', visionDepthMaxCalls: 3 })
  const tools = registerFlowTools(
    harness,
    () => bootstrapSuccess({ visual_kind: 'general', mixed_of: [] }),
    () => 'evidence',
  )
  const session = {}
  const exec = { agent: { session } }
  await preStep(harness, session, 1)
  await tools.bootstrap().execute({}, exec)
  for (let i = 0; i < 3; i++) assert.equal(await tools.describe().execute({}, exec), 'evidence')
  const blocked = JSON.parse(await tools.describe().execute({}, exec))
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'VISION_DEPTH_LIMIT')
  assert.match(blocked.reason, /configured deep-dive call cap/)
  assert.equal(tools.counts().evidenceCalls, 3)
})

test('zero disables the cap while a retained positive cap applies to every built-in strategy', async () => {
  const unlimitedHarness = boot({ visionDepth: 'deep', visionDepthMaxCalls: 0 })
  const unlimitedTools = registerFlowTools(
    unlimitedHarness,
    () => bootstrapSuccess({ visual_kind: 'general', mixed_of: [] }),
    () => 'evidence',
  )
  const unlimitedSession = {}
  const unlimitedExec = { agent: { session: unlimitedSession } }
  await preStep(unlimitedHarness, unlimitedSession, 1)
  await unlimitedTools.bootstrap().execute({}, unlimitedExec)
  for (let i = 0; i < 7; i++) assert.equal(await unlimitedTools.describe().execute({}, unlimitedExec), 'evidence')
  assert.equal(unlimitedTools.counts().evidenceCalls, 7)

  const cappedHarness = boot({ visionDepth: 'deep', visionDepthMaxCalls: 2 })
  const cappedTools = registerFlowTools(
    cappedHarness,
    () => bootstrapSuccess({ visual_kind: 'general', mixed_of: [] }),
    () => 'evidence',
  )
  const cappedSession = {}
  const cappedExec = { agent: { session: cappedSession } }
  await preStep(cappedHarness, cappedSession, 1)
  await cappedTools.bootstrap().execute({}, cappedExec)
  for (let i = 0; i < 2; i++) assert.equal(await cappedTools.describe().execute({}, cappedExec), 'evidence')
  const blocked = JSON.parse(await cappedTools.describe().execute({}, cappedExec))
  assert.equal(blocked.code, 'VISION_DEPTH_LIMIT')
  assert.equal(cappedTools.counts().evidenceCalls, 2)
})

test('fast mixed flow still keeps both correctness branches', async () => {
  const harness = boot({ visionDepth: 'fast', visionDepthMaxCalls: 0 })
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
  assert.match(firstGuard.content[0].text, /document/)

  await tools.describe().execute({}, exec)
  const halfDone = await preStep(harness, session, 1)
  const halfGuard = halfDone.messages.find((message) => String(message.id).includes('structured-mixed-guard'))
  assert.ok(halfGuard, 'one successful evidence call must not complete a two-branch mixed flow')

  await tools.describe().execute({}, exec)
  const complete = await preStep(harness, session, 1)
  assert.equal(
    complete.messages.some((message) => String(message.id).includes('structured-mixed-guard')),
    false,
  )
})

test('standard mixed flow remains incomplete after one branch and clears after two', async () => {
  const harness = boot({
    visionDepth: 'standard',
    visionDepthMaxCalls: 0,
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
  assert.ok(halfGuard)

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
