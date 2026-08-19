import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  depthCopyFor,
  depthLimitFor,
  renderDepthGuidance,
  runWithDepthConfig,
  sceneGuidanceFor,
  contentGuidanceFor,
} from '../lib/depth-guidance.js'

// 看图深度档位（移植自 dsh-vision PRECISION）：档位定深挖上限，不参与提示词
// 组合（模板集合，非矩阵）；fast/standard/deep 分别硬限 1/2/4 次，custom=N。

test('depthLimitFor: fast=1, standard=2, deep=4', () => {
  assert.equal(depthLimitFor('fast'), 1)
  assert.equal(depthLimitFor('standard'), 2)
  assert.equal(depthLimitFor('deep'), 4)
  assert.equal(depthLimitFor(undefined), 2)
})

test('depthLimitFor: custom N is its own cap and custom 0 is unlimited', () => {
  assert.equal(depthLimitFor('custom', 1), 1)
  assert.equal(depthLimitFor('custom', 6), 6)
  assert.equal(depthLimitFor('custom', 100), 100)
  assert.equal(depthLimitFor('custom', 101), 100)
  assert.equal(depthLimitFor('custom', 6.9), 6)
  assert.equal(depthLimitFor('custom', 0), undefined)
  assert.equal(depthLimitFor('custom', undefined), undefined)
  assert.equal(depthLimitFor('custom', null), undefined)
  // 切回内置档位后，保存过的自定义数值保留但不生效。
  assert.equal(depthLimitFor('fast', 8), 1)
  assert.equal(depthLimitFor('standard', 8), 2)
  assert.equal(depthLimitFor('deep', 8), 4)
})

test('runtime depth context carries custom through the legacy inner 1+x helper', async () => {
  const capped = await runWithDepthConfig(
    { visionDepth: 'custom', visionDepthMaxCalls: 6 },
    async () => depthLimitFor('standard'),
  )
  assert.equal(capped, 6)

  const unlimited = await runWithDepthConfig(
    { visionDepth: 'custom', visionDepthMaxCalls: 0 },
    async () => depthLimitFor('standard'),
  )
  assert.equal(unlimited, undefined)

  const copy = await runWithDepthConfig(
    { visionDepth: 'custom', visionDepthMaxCalls: 6 },
    async () => renderDepthGuidance({ visualKind: 'document', depth: 'standard' }),
  )
  assert.match(copy, /已自定义深挖上限为 6 次/)
  assert.doesNotMatch(copy, /深度档位为 standard/)
})

test('depthCopyFor: custom cap and unlimited wording match runtime semantics', () => {
  assert.match(depthCopyFor('custom', 6), /已自定义深挖上限为 6 次/)
  assert.match(depthCopyFor('custom', 0), /不设置次数上限/)
  assert.match(depthCopyFor('standard', 8), /第 2 次之后/)
})

test('sceneGuidanceFor: known kinds have guidance, general/unknown/mixed release', () => {
  assert.match(sceneGuidanceFor('code'), /逐字/)
  assert.match(sceneGuidanceFor('document'), /语义优先/)
  assert.match(sceneGuidanceFor('ui'), /detect/)
  assert.match(sceneGuidanceFor('chat'), /气泡/)
  assert.equal(sceneGuidanceFor('general'), '')
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
  assert.doesNotMatch(text, /请先判断/)
})

test('renderDepthGuidance: general falls to self-judge guidance when content_kind unknown', () => {
  const text = renderDepthGuidance({ visualKind: 'general', contentKind: 'unknown', depth: 'standard' })
  assert.match(text, /请先判断图中主体/)
  assert.match(text, /standard/)
})

test('renderDepthGuidance: fast carries tier-insufficient note', () => {
  const text = renderDepthGuidance({ visualKind: 'ui', depth: 'fast' })
  assert.match(text, /detect/)
  assert.match(text, /fast/)
  assert.match(text, /升级档位/)
})

test('renderDepthGuidance: unknown releases depth copy only', () => {
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
  assert.doesNotMatch(text, /语义优先/)
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

test('guidanceOverrides: user copy wins over built-in for content kinds', () => {
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

test('index.js integration: existing inner depth pipeline remains intact', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(index.includes("visionDepth: z.union(['fast', 'standard', 'deep']).default('standard')"), true)
  assert.equal(index.includes('depthLimitFor(visionDepth())'), true)
  assert.equal(index.includes('renderDepthGuidance({'), true)
  assert.equal(index.includes("code: 'VISION_DEPTH_LIMIT'"), true)
})

test('index.js integration: deep quota consumed only after evidence', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(index.includes('state.deepCalls = used + 1'), false)
  assert.equal(index.includes('state.deepCalls = (state.deepCalls || 0) + 1'), true)
  assert.equal(index.includes('evidenceFailure'), true)
  assert.equal(index.includes('state.followupCompleted = true'), true)
})

test('client.js integration: custom depth lives in the canonical editor shared by both entry points', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const prelude = readFileSync(new URL('../lib/live-model-client-prelude.js', import.meta.url), 'utf8')
  assert.equal(client.includes("const SELECT_KEYS = ['visionDepth']"), true)
  assert.equal(client.includes("{ value: 'custom', label: t('visionDepthCustom') }"), true)
  assert.equal(client.includes("format('visionDepth') === 'custom'"), true)
  assert.equal(client.includes("const DEPTH_NUMBER_KEYS = ['visionDepthMaxCalls']"), true)
  assert.equal(client.includes("labelVisionDepthMaxCalls: '自定义深挖次数上限'"), true)
  assert.equal(client.includes("labelVisionDepthMaxCalls: 'Custom deep-dive call cap'"), true)
  // The current-main client prelude owns the final user-visible correction:
  // Standard stays capped at 2; only Custom 0/blank is unlimited.
  assert.equal(prelude.includes('留空或填 0 = 不限制'), true)
  assert.equal(prelude.includes('标准档仍固定最多 2 次'), true)
  assert.equal(prelude.includes('blank or 0 = unlimited'), true)
  assert.equal(prelude.includes('Standard remains capped at 2'), true)
  // 两个入口只有一份编辑器：插件入口跳转到设置 → Vision Router。
  assert.equal(client.includes("legacyMovedBody: '主设置入口现在位于「设置 → Vision Router」。此处仅保留兼容入口，不再维护第二份可编辑表单。'"), true)
  assert.equal(client.includes("legacyOpen: '打开 Vision Router 设置'"), true)
})
