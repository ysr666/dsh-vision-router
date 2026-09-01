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

// 看图深度只控制查证策略；次数限制由独立的 visionDepthMaxCalls 安全阀负责。

test('depthLimitFor: built-in depth strategies are unlimited by default', () => {
  assert.equal(depthLimitFor('fast'), undefined)
  assert.equal(depthLimitFor('standard'), undefined)
  assert.equal(depthLimitFor('deep'), undefined)
  assert.equal(depthLimitFor(undefined), undefined)
  assert.equal(depthLimitFor('custom'), undefined)
})

test('depthLimitFor: an explicit positive cap applies independently of strategy', () => {
  for (const depth of ['fast', 'standard', 'deep', 'custom', 'bogus']) {
    assert.equal(depthLimitFor(depth, 1), 1)
    assert.equal(depthLimitFor(depth, 6), 6)
    assert.equal(depthLimitFor(depth, 100), 100)
    assert.equal(depthLimitFor(depth, 101), 100)
    assert.equal(depthLimitFor(depth, 6.9), 6)
    assert.equal(depthLimitFor(depth, 0), undefined)
    assert.equal(depthLimitFor(depth, undefined), undefined)
  }
})

test('runtime depth context carries the independent cap through the legacy inner helper', async () => {
  const capped = await runWithDepthConfig(
    { visionDepth: 'standard', visionDepthMaxCalls: 6 },
    async () => depthLimitFor('standard'),
  )
  assert.equal(capped, 6)

  const unlimited = await runWithDepthConfig(
    { visionDepth: 'deep', visionDepthMaxCalls: 0 },
    async () => depthLimitFor('deep'),
  )
  assert.equal(unlimited, undefined)

  const legacyCustom = await runWithDepthConfig(
    { visionDepth: 'custom', visionDepthMaxCalls: 6 },
    async () => renderDepthGuidance({ visualKind: 'document', depth: 'standard' }),
  )
  assert.match(legacyCustom, /看图策略为标准/)
  assert.match(legacyCustom, /另启用了深挖次数上限：最多 6 次/)
  assert.doesNotMatch(legacyCustom, /看图策略为自定义|深度档位为 custom/)
})

test('depthCopyFor: built-in tiers are guidance strategies, not count promises', () => {
  const fast = depthCopyFor('fast')
  const standard = depthCopyFor('standard')
  const deep = depthCopyFor('deep')
  assert.match(fast, /看图策略为快速/)
  assert.match(fast, /整体判断/)
  assert.match(standard, /看图策略为标准/)
  assert.match(standard, /按需查证/)
  assert.match(deep, /看图策略为细致/)
  assert.match(deep, /交叉验证/)
  for (const copy of [fast, standard, deep]) {
    assert.doesNotMatch(copy, /最多.*次|1-2 次|2-4 次|第 2 次之后/)
  }
})

test('depthCopyFor: explicit cap is a separate note and is bilingual', () => {
  assert.match(depthCopyFor('standard', 6), /另启用了深挖次数上限：最多 6 次/)
  assert.match(depthCopyFor('deep', 6, 'en-US'), /Thorough/)
  assert.match(depthCopyFor('deep', 6, 'en-US'), /separate deep-dive call cap.*6 successful evidence calls/i)
})

test('runtime depth locale follows the host locale when no explicit locale is passed', async () => {
  const en = await runWithDepthConfig(
    { visionDepth: 'standard', visionDepthMaxCalls: 0, __visionRouterLocale: 'en-US' },
    async () => renderDepthGuidance({ visualKind: 'ui', depth: 'standard' }),
  )
  assert.match(en, /UI content detected/)
  assert.match(en, /Vision strategy is Standard/)
  assert.doesNotMatch(en, /检测到|本轮看图策略/)

  const zh = await runWithDepthConfig(
    { visionDepth: 'deep', visionDepthMaxCalls: 0, __visionRouterLocale: 'zh-CN' },
    async () => renderDepthGuidance({ visualKind: 'ui', depth: 'deep' }),
  )
  assert.match(zh, /检测到界面内容/)
  assert.match(zh, /本轮看图策略为细致/)
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

test('renderDepthGuidance: scene + strategy for document', () => {
  const text = renderDepthGuidance({ visualKind: 'document', depth: 'deep' })
  assert.match(text, /语义优先/)
  assert.match(text, /主动检查关键局部并做交叉验证/)
  assert.doesNotMatch(text, /2-4 次/)
})

test('renderDepthGuidance: general uses content_kind precise guidance when known', () => {
  const text = renderDepthGuidance({ visualKind: 'general', contentKind: 'food', depth: 'standard' })
  assert.match(text, /食物/)
  assert.match(text, /看图策略为标准/)
  assert.doesNotMatch(text, /请先判断/)
})

test('renderDepthGuidance: general falls to self-judge guidance when content_kind unknown', () => {
  const text = renderDepthGuidance({ visualKind: 'general', contentKind: 'unknown', depth: 'standard' })
  assert.match(text, /请先判断图中主体/)
  assert.match(text, /看图策略为标准/)
})

test('renderDepthGuidance: fast stays lightweight without forbidding further evidence', () => {
  const text = renderDepthGuidance({ visualKind: 'ui', depth: 'fast' })
  assert.match(text, /detect/)
  assert.match(text, /看图策略为快速/)
  assert.match(text, /关键证据不确定/)
  assert.doesNotMatch(text, /升级档位|最多.*次/)
})

test('renderDepthGuidance: unknown releases strategy copy only', () => {
  const text = renderDepthGuidance({ visualKind: 'unknown', depth: 'standard' })
  assert.match(text, /看图策略为标准/)
  assert.doesNotMatch(text, /检测到/)
})

test('renderDepthGuidance: invalid and legacy custom depth fall back to standard strategy', () => {
  assert.match(renderDepthGuidance({ visualKind: 'document', depth: 'bogus' }), /看图策略为标准/)
  assert.match(renderDepthGuidance({ visualKind: 'document', depth: 'custom' }), /看图策略为标准/)
})

test('guidanceOverrides: user copy wins over built-in for scene kinds', () => {
  const overrides = [{ kind: 'document', text: '重点关注合同条款与签名。' }]
  const text = renderDepthGuidance({ visualKind: 'document', depth: 'standard', guidanceOverrides: overrides })
  assert.match(text, /合同条款与签名/)
  assert.doesNotMatch(text, /语义优先/)
  assert.match(text, /看图策略为标准/)
})

test('guidanceOverrides: duplicate kind is deterministic last-wins and bounded', () => {
  const overrides = [
    { kind: 'document', text: 'old' },
    { kind: 'document', text: 'new' + 'x'.repeat(3000) },
  ]
  const text = renderDepthGuidance({ visualKind: 'document', depth: 'standard', guidanceOverrides: overrides })
  assert.match(text, /^new/)
  assert.doesNotMatch(text, /^old/)
  assert.ok(text.length < 2400)
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

test('index.js integration: legacy inner guard remains but receives the independent cap policy', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(index.includes("visionDepth: z.union(['fast', 'standard', 'deep']).default('standard')"), true)
  assert.equal(index.includes('depthLimitFor(visionDepth())'), true)
  assert.equal(index.includes('renderDepthGuidance({'), true)
  assert.equal(index.includes("code: 'VISION_DEPTH_LIMIT'"), true)
})

test('index.js integration: evidence calls are counted only after evidence is produced', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(index.includes('state.deepCalls = used + 1'), false)
  assert.equal(index.includes('state.deepCalls = (state.deepCalls || 0) + 1'), true)
  assert.equal(index.includes('evidenceFailure'), true)
  assert.equal(index.includes('state.followupCompleted = true'), true)
})

test('client presentation: depth strategy and optional cap are separate bilingual controls', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const prelude = readFileSync(new URL('../lib/vision-turn-budget-client-prelude.js', import.meta.url), 'utf8')
  assert.equal(client.includes("const SELECT_KEYS = ['visionDepth']"), true)
  assert.match(prelude, /快速（优先整体判断）/)
  assert.match(prelude, /标准（按需查证，默认）/)
  assert.match(prelude, /细致（主动交叉验证）/)
  assert.match(prelude, /Quick \(overall-first\)/)
  assert.match(prelude, /Standard \(evidence as needed, default\)/)
  assert.match(prelude, /Thorough \(proactive cross-checking\)/)
  assert.match(prelude, /限制深挖次数/)
  assert.match(prelude, /Limit deep-dive calls/)
  assert.match(prelude, /DEPTH_CAP_FIELD = 'visionDepthMaxCalls'/)
  assert.match(prelude, /values\.has\('fast'\).*values\.has\('standard'\).*values\.has\('deep'\).*values\.has\('custom'\)/s)
  assert.match(prelude, /node\.props\.value === 'custom'/)
  assert.doesNotMatch(prelude, /Standard remains capped at 2|标准档仍固定最多 2 次/)
})
