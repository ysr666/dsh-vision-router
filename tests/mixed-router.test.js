import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MAX_MIXED_BRANCHES,
  buildMixedBranches,
  mixedGuidance,
  normalizeMixedOf,
  planMixedBranches,
  renderMixedGuidance,
} from '../lib/mixed-router.js'

// mixed 分路识别：精度优化（避免漏判/错判另一半内容），≤2 分支成本封顶。
// 细分来源 = bootstrap 的 mixed_of（schema 枚举，视觉模型直接输出，与
// content_kind 同一"免费收敛"哲学）——不再用 entities 启发式推断。

test('normalizeMixedOf: validates, dedupes, caps at MAX_MIXED_BRANCHES, orders by priority', () => {
  assert.deepEqual(normalizeMixedOf(['document', 'ui']), ['ui', 'document']) // ui 优先作主分支
  assert.deepEqual(normalizeMixedOf(['ui', 'ui', 'document', 'code']), ['ui', 'document']) // 去重 + ≤2
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

test('buildMixedBranches: general is a legal secondary branch (maintainer review)', () => {
  // mixed_of schema allows document|ui|code|chat|general; a mixed image of
  // "ui + general" must keep BOTH branches so the unclassifiable half is not
  // silently dropped from the guidance. general's guidance is the release
  // copy (model chooses the recognition method freely).
  const uiGeneral = buildMixedBranches('ui', ['general'])
  assert.deepEqual(uiGeneral.map((b) => b.kind), ['ui', 'general'])
  assert.match(uiGeneral[1].guidance, /放行/)
  const documentGeneral = buildMixedBranches('document', ['general'])
  assert.deepEqual(documentGeneral.map((b) => b.kind), ['document', 'general'])
  // Cap still applies: general counts toward MAX_MIXED_BRANCHES.
  const capped = buildMixedBranches('ui', ['document', 'general'])
  assert.equal(capped.length, 2)
  // unknown stays skipped (invalid value; normalizer already filters it).
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

test('planMixedBranches: mixed_of drives the branches and carries the precision note', () => {
  const plan = planMixedBranches({ visual_kind: 'mixed', mixed_of: ['document', 'ui'] })
  assert.equal(plan.fallback, false)
  assert.equal(plan.visual_kind, 'mixed')
  assert.deepEqual(plan.branches.map((b) => b.kind), ['ui', 'document'])
  assert.match(plan.note, /精度优化/)
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

test('renderMixedGuidance: fast degrades two-branch mixed to the primary branch (mixed x depth fix 1)', () => {
  const plan = planMixedBranches({ visual_kind: 'mixed', mixed_of: ['document', 'ui'] })
  const fast = renderMixedGuidance(plan, 'fast')
  // fast 档位与 depthLimitFor('fast')=1 的硬上限一致：只引导主分支一次，
  // 不再要求"各分支至少一次识别调用"（否则文案 ≥2 次与硬上限 1 次矛盾，
  // 第二次调用必被 VISION_DEPTH_LIMIT 拒绝）。
  assert.match(fast, /本轮深度档位为 fast：先验证主分支（ui）一次/)
  assert.doesNotMatch(fast, /各分支至少一次识别调用/)
  assert.doesNotMatch(fast, /document：语义优先/) // 次分支引导不注入
  // standard/deep 保持完整双分支精度引导（与 fast 文案不再冲突）。
  const standard = renderMixedGuidance(plan, 'standard')
  assert.match(standard, /各分支至少一次识别调用/)
  assert.match(standard, /document：语义优先/)
  const deep = renderMixedGuidance(plan, 'deep')
  assert.equal(deep, standard)
  // 默认（无 depth 参数）保持完整双分支——向后兼容。
  assert.equal(renderMixedGuidance(plan), standard)
})

test('index.js integration: mixed plan stored on bootstrap completion and injected in followup', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(index.includes("bootstrapState.mixedPlan = planMixedBranches(evidence)"), true)
  assert.equal(index.includes("renderMixedGuidance(bootstrapState && bootstrapState.mixedPlan, visionDepth())"), true)
  assert.equal(index.includes("evidence.visual_kind === 'mixed'"), true)
})

test('mixed-router no longer uses the entities heuristic (schema convergence)', () => {
  const source = readFileSync(new URL('../lib/mixed-router.js', import.meta.url), 'utf8')
  assert.equal(source.includes('inferMixedKinds'), false) // 启发式已移除
  assert.equal(source.includes('evidence.mixed_of'), true) // 消费 schema 输出
})

test('MAX_MIXED_BRANCHES is two (cost cap)', () => {
  assert.equal(MAX_MIXED_BRANCHES, 2)
})
