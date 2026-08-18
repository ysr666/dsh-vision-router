import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  depthLimitFor,
  renderDepthGuidance,
  sceneGuidanceFor,
  contentGuidanceFor,
} from '../lib/depth-guidance.js'

// 看图深度档位（移植自 dsh-vision PRECISION）：档位定深挖上限，不参与提示词
// 组合（模板集合，非矩阵）；fast/standard/deep 分别硬限 1/2/4 次。

test('depthLimitFor: fast=1, standard=2, deep=4', () => {
  assert.equal(depthLimitFor('fast'), 1)
  assert.equal(depthLimitFor('standard'), 2)
  assert.equal(depthLimitFor('deep'), 4)
  assert.equal(depthLimitFor(undefined), 2)
})

test('sceneGuidanceFor: known kinds have guidance, general/unknown/mixed release', () => {
  assert.match(sceneGuidanceFor('code'), /逐字/)
  assert.match(sceneGuidanceFor('document'), /语义优先/)
  assert.match(sceneGuidanceFor('ui'), /detect/)
  assert.match(sceneGuidanceFor('chat'), /气泡/)
  assert.equal(sceneGuidanceFor('general'), '') // general 走 content_kind 内容引导
  assert.equal(sceneGuidanceFor('unknown'), '')
  assert.equal(sceneGuidanceFor('mixed'), '')
  assert.equal(sceneGuidanceFor(undefined), '')
  assert.equal(sceneGuidanceFor('constructor'), '')
  assert.equal(sceneGuidanceFor('__proto__'), '')
})

test('contentGuidanceFor: content kinds have guidance, unknown releases', () => {
  assert.match(contentGuidanceFor('person'), /人物/)
  assert.match(contentGuidanceFor('food'), /食物/)
  assert.match(contentGuidanceFor('vehicle'), /交通工具/)
  assert.equal(contentGuidanceFor('unknown'), '')
})

test('renderDepthGuidance: scene + depth for document', () => {
  const text = renderDepthGuidance({ visualKind: 'document', depth: 'deep' })
  assert.match(text, /语义优先/)
  assert.match(text, /2-4 次充分深挖/)
})

test('renderDepthGuidance: general uses content_kind precise guidance when known', () => {
  const text = renderDepthGuidance({ visualKind: 'general', contentKind: 'food', depth: 'standard' })
  assert.match(text, /食物/)
  assert.match(text, /standard/)
  assert.doesNotMatch(text, /请先判断/) // 已知 content_kind 时不再要求模型自判
})

test('renderDepthGuidance: general falls to self-judge guidance when content_kind unknown', () => {
  const text = renderDepthGuidance({ visualKind: 'general', contentKind: 'unknown', depth: 'standard' })
  assert.match(text, /请先判断图中主体/)
  assert.match(text, /standard/)
})

test('renderDepthGuidance: fast carries tier-insufficient note (dsh-vision answer-section idea)', () => {
  const text = renderDepthGuidance({ visualKind: 'ui', depth: 'fast' })
  assert.match(text, /detect/)
  assert.match(text, /fast/)
  assert.match(text, /升级档位/)
})

test('renderDepthGuidance: unknown releases (depth copy only)', () => {
  const text = renderDepthGuidance({ visualKind: 'unknown', depth: 'standard' })
  assert.match(text, /standard/)
  assert.doesNotMatch(text, /检测到/)
})

test('renderDepthGuidance: invalid depth falls back to standard copy', () => {
  const text = renderDepthGuidance({ visualKind: 'document', depth: 'bogus' })
  assert.match(text, /standard/)
})

test('guidanceOverrides: user copy wins over built-in for scene kinds', () => {
  const overrides = [{ kind: 'document', text: '重点关注合同条款与签名。' }]
  const text = renderDepthGuidance({ visualKind: 'document', depth: 'standard', guidanceOverrides: overrides })
  assert.match(text, /合同条款与签名/)
  assert.doesNotMatch(text, /语义优先/) // 内置文案被覆盖
  assert.match(text, /standard/)
})

test('guidanceOverrides: duplicate kind is deterministic last-wins and bounded', () => {
  const overrides = [
    { kind: 'document', text: 'old' },
    { kind: 'document', text: 'new' + 'x'.repeat(3000) },
  ]
  const text = renderDepthGuidance({ visualKind: 'document', depth: 'standard', guidanceOverrides: overrides })
  assert.match(text, /^new/)
  assert.doesNotMatch(text, /^old/)
  assert.ok(text.length < 2300)
})

test('guidanceOverrides: user copy wins over built-in for content kinds (general)', () => {
  const overrides = [{ kind: 'food', text: '关注菜品摆盘与食材新鲜度。' }]
  const text = renderDepthGuidance({ visualKind: 'general', contentKind: 'food', depth: 'standard', guidanceOverrides: overrides })
  assert.match(text, /摆盘/)
  assert.doesNotMatch(text, /菜品\/食材\/卖相/)
})

test('guidanceOverrides: empty/undefined overrides keep built-in behavior', () => {
  const withEmpty = renderDepthGuidance({ visualKind: 'document', depth: 'standard', guidanceOverrides: [] })
  const without = renderDepthGuidance({ visualKind: 'document', depth: 'standard' })
  assert.equal(withEmpty, without)
  assert.match(withEmpty, /语义优先/)
})

test('index.js integration: guidanceOverrides wired into Config and followup guidance', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(index.includes('guidanceOverrides: z'), true)
  assert.equal(index.includes('guidanceOverrides: current().guidanceOverrides'), true)
})

test('index.js integration: visionDepth wired into Config, bootstrap state and tool wrapper', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(index.includes("visionDepth: z.union(['fast', 'standard', 'deep']).default('standard')"), true)
  assert.equal(index.includes('bootstrapState.visualKind = evidence.visual_kind'), true)
  assert.equal(index.includes('bootstrapState.contentKind = evidence.content_kind'), true)
  assert.equal(index.includes('depthLimitFor(visionDepth())'), true)
  assert.equal(index.includes("code: 'VISION_DEPTH_LIMIT'"), true)
  assert.equal(index.includes('renderDepthGuidance({'), true)
})

test('index.js integration: deep quota consumed only after evidence (mixed x depth fix 2)', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  // 配额不在 execute 前预扣（失败调用不烧档位配额），只在工具真正产出证据后递增。
  assert.equal(index.includes('state.deepCalls = used + 1'), false)
  assert.equal(index.includes('state.deepCalls = (state.deepCalls || 0) + 1'), true)
  assert.equal(index.includes('evidenceFailure'), true)
  assert.equal(index.includes('state.followupCompleted = true'), true)
})

test('client.js integration: visionDepth select and custom guidance live in the main deep-dive group', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(client.includes("const SELECT_KEYS = ['visionDepth']"), true)
  assert.equal(client.includes('selectField(key, t(LABEL_KEY[key]), t(HINT_KEY[key]), ['), true)
  assert.equal(client.includes("selectVisionDepth: '看图深度'"), true)
  assert.equal(client.includes("selectVisionDepth: 'Vision depth'"), true)
  assert.equal(client.includes("guidanceOverridesLabel: '自定义识图引导（可选）'"), true)
  assert.equal(client.includes("guidanceOverridesLabel: 'Custom vision guidance (optional)'"), true)
  // 深度档位与自定义引导跟随结构化预识别开关显示在主设置区（不埋在高级设置）。
  assert.equal(
    client.includes("format('structuredVisionBootstrap') === true\n                ? h('div', { className: 'vr-group' }"),
    true,
  )
  assert.equal(client.includes("t('groupDeepDive')"), true)
})
