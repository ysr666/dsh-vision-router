import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runWithDepthConfig } from '../lib/depth-guidance.js'
import {
  MAX_MIXED_BRANCHES,
  buildMixedBranches,
  mixedGuidance,
  normalizeMixedOf,
  planMixedBranches,
  renderMixedGuidance,
} from '../lib/mixed-router.js'

// mixed 分路识别：精度优化（避免漏判/错判另一半内容），最多保留 2 个分支。
// 深度档位只影响查证策略，不再改变 mixed 分支覆盖或调用次数。

test('normalizeMixedOf: validates, dedupes, caps at MAX_MIXED_BRANCHES, orders by priority', () => {
  assert.deepEqual(normalizeMixedOf(['document', 'ui']), ['ui', 'document'])
  assert.deepEqual(normalizeMixedOf(['ui', 'ui', 'document', 'code']), ['ui', 'document'])
  assert.deepEqual(normalizeMixedOf(['bogus']), [])
  assert.deepEqual(normalizeMixedOf(undefined), [])
  assert.deepEqual(normalizeMixedOf('not-an-array'), [])
})

test('buildMixedBranches: dedupe + MAX_MIXED_BRANCHES cap', () => {
  const branches = buildMixedBranches('ui', ['document', 'document', 'code', 'table'])
  assert.equal(branches.length, 2)
  assert.deepEqual(branches.map((b) => b.kind), ['ui', 'document'])
})

test('buildMixedBranches: single branch when no secondary', () => {
  const branches = buildMixedBranches('document', [])
  assert.equal(branches.length, 1)
  assert.equal(branches[0].kind, 'document')
})

test('buildMixedBranches: general is a legal secondary branch', () => {
  const uiGeneral = buildMixedBranches('ui', ['general'])
  assert.deepEqual(uiGeneral.map((b) => b.kind), ['ui', 'general'])
  assert.match(uiGeneral[1].guidance, /放行/)
  const documentGeneral = buildMixedBranches('document', ['general'])
  assert.deepEqual(documentGeneral.map((b) => b.kind), ['document', 'general'])
  const capped = buildMixedBranches('ui', ['document', 'general'])
  assert.equal(capped.length, 2)
  const unknownOnly = buildMixedBranches('ui', ['unknown', 'general'])
  assert.deepEqual(unknownOnly.map((b) => b.kind), ['ui', 'general'])
})

test('planMixedBranches: ui+general mixed_of keeps both branches', () => {
  const plan = planMixedBranches({ visual_kind: 'mixed', mixed_of: ['ui', 'general'] })
  assert.equal(plan.fallback, false)
  assert.deepEqual(plan.branches.map((b) => b.kind), ['ui', 'general'])
})

test('mixedGuidance: exact sub wins, kind falls back, default releases', () => {
  assert.match(mixedGuidance('document', 'code'), /逐字/)
  assert.match(mixedGuidance('document', 'table'), /逐字/)
  assert.match(mixedGuidance('ui'), /detect/)
  assert.match(mixedGuidance('document'), /语义优先/)
  assert.match(mixedGuidance('chat'), /放行/)
})

test('planMixedBranches: mixed_of drives branches and carries the precision note', () => {
  const plan = planMixedBranches({ visual_kind: 'mixed', mixed_of: ['document', 'ui'] })
  assert.equal(plan.fallback, false)
  assert.equal(plan.visual_kind, 'mixed')
  assert.deepEqual(plan.branches.map((b) => b.kind), ['ui', 'document'])
  assert.match(plan.note, /精度优化/)
  assert.match(plan.note, /最多 2 个分支/)
})

test('planMixedBranches: missing/empty mixed_of falls back (release, never hard-block)', () => {
  assert.equal(planMixedBranches({ visual_kind: 'mixed', mixed_of: [] }).fallback, true)
  assert.equal(planMixedBranches({ visual_kind: 'mixed' }).fallback, true)
  assert.equal(planMixedBranches(undefined).fallback, true)
})

test('renderMixedGuidance: mixed plan renders per-branch guidance; fallback renders nothing', () => {
  const plan = planMixedBranches({ visual_kind: 'mixed', mixed_of: ['document', 'ui'] })
  const text = renderMixedGuidance(plan)
  assert.match(text, /检测到混合内容（ui \+ document）/)
  assert.match(text, /精度优化/)
  assert.match(text, /detect \/ ground 优先/)
  assert.match(text, /语义优先/)
  assert.equal(renderMixedGuidance(planMixedBranches(undefined)), undefined)
})

test('renderMixedGuidance: fast/standard/deep keep the same two-branch correctness coverage', () => {
  const plan = planMixedBranches({ visual_kind: 'mixed', mixed_of: ['document', 'ui'] })
  const fast = renderMixedGuidance(plan, 'fast')
  const standard = renderMixedGuidance(plan, 'standard')
  const deep = renderMixedGuidance(plan, 'deep')
  for (const text of [fast, standard, deep]) {
    assert.match(text, /ui：detect \/ ground 优先/)
    assert.match(text, /document：语义优先/)
    assert.doesNotMatch(text, /升级档位|深度档位为 fast|最多.*次/)
  }
  assert.equal(fast, standard)
  assert.equal(deep, standard)
  assert.equal(renderMixedGuidance(plan), standard)
})

test('mixed guidance follows runtime host locale when called without an explicit locale', async () => {
  const text = await runWithDepthConfig(
    { __visionRouterLocale: 'en-US' },
    async () => {
      const plan = planMixedBranches({ visual_kind: 'mixed', mixed_of: ['document', 'ui'] })
      return renderMixedGuidance(plan, 'standard')
    },
  )
  assert.match(text, /Mixed content detected/)
  assert.match(text, /ui: prefer detect \/ ground/)
  assert.match(text, /document: prefer semantic understanding/)
  assert.doesNotMatch(text, /检测到混合内容|语义优先/)
})

test('index.js integration: mixed plan stored on bootstrap completion and injected in followup', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(index.includes("bootstrapState.mixedPlan = planMixedBranches(evidence)"), true)
  assert.equal(index.includes("renderMixedGuidance(bootstrapState && bootstrapState.mixedPlan, visionDepth())"), true)
  assert.equal(index.includes("evidence.visual_kind === 'mixed'"), true)
})

test('mixed-router no longer uses the entities heuristic', () => {
  const source = readFileSync(new URL('../lib/mixed-router.js', import.meta.url), 'utf8')
  assert.equal(source.includes('inferMixedKinds'), false)
  assert.equal(source.includes('evidence.mixed_of'), true)
})

test('MAX_MIXED_BRANCHES is two (branch-shape cap, not a call-count cap)', () => {
  assert.equal(MAX_MIXED_BRANCHES, 2)
})
