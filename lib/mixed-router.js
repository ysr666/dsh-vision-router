// 场景级识图路由层 · mixed 分路识别（mixed-router）。
//
// 定位：**精度优化**（不是成本优化）。
//
// bootstrap 判定 visual_kind=mixed 后，1.5.3 没有任何后续处理——模型自由深挖
// 可能漏判另一半内容、选错识别方式（§4.6 缺陷实证：第一遍只知道"这是混合的"，
// 不知道"哪几种类型 + 各在哪些区域"）。本模块把混合内容拆分为 ≤2 个分支，各
// 分支独立软引导识别方式，避免漏判/错判，**提升混合图的识别精度**；成本影响是
// 副产品（MAX_MIXED_BRANCHES=2 封顶，混合图 ≤2 次视觉调用）。
//
// 策略来源：dsh-vision（text-llm-vision main 分支）的混合路由——提交 17aff58
// 引入、d9e233b 定型为「候选列表 + 聚焦点 + 双分支」，实现于 vision_client.py
// 的 _parse_scene / _build_branches / _route_engine；语义从"实体主体"（人+飞机）
// 改为"内容类型"（文档+UI）。分支引导遵守软路由成立结论：**不硬拦截识别方式**，
// OCR 仅用于逐字专精场景（可执行代码 / 精确引用 / 合同表单 / 表格数字 / 验证码 /
// 无语义锚点的生僻字）。
//
// 模块为纯函数（零网络依赖），输入为 bootstrap 的结构化输出（visual_kind=mixed
// 时的 regions/entities），输出为分支决策（供 pre-step 钩子注入引导）。

export const MAX_MIXED_BRANCHES = 2

// bootstrap schema 中 entities[].type 的合法枚举
const ENTITY_TYPES = new Set(['text', 'button', 'input', 'image', 'icon', 'object', 'person', 'other'])

// 交互元素信号：存在即倾向 ui 分支
const UI_SIGNAL_TYPES = new Set(['button', 'input', 'icon'])

// ── 分支引导表（软引导，非白名单——模型保留逃生通道）。────────────────────────
// 匹配序：("kind","sub") 精确 → ("kind","") → "_default"（同 dsh-vision _route_engine）。
const BRANCH_GUIDANCE = new Map([
  ['document:code', '逐字转写（代码可执行性例外）'],
  ['document:form', '语义优先，逐字字段名/值确需引用时用 OCR'],
  ['document:table', '结构提取优先，数字/金额逐字（表格 OCR 专精场景）'],
  ['document:', '语义优先；仅当需要逐字引用（长文档/合同/表单）时才用 OCR'],
  ['ui:', 'detect / ground 优先（元素清单与像素定位）'],
  ['code:', '逐字转写（可执行性例外）'],
  ['table:', '结构提取优先，数字/金额逐字'],
  ['_default', '放行（模型自由选择识别方式）'],
])

// 分支输出顺序：信号强度排序（可交互 > 文字 > 其余），决定主/次分支
const KIND_PRIORITY = ['ui', 'document', 'code', 'table', 'chat', 'general']

// 可混合的媒介枚举（与 bootstrap schema 的 mixed_of 同域）
const MIXABLE_KINDS = new Set(['document', 'ui', 'code', 'chat', 'general'])

/**
 * 从 bootstrap 的 mixed_of（schema 枚举，视觉模型直接输出，已由 normalizer
 * 校验去重 + ≤2）排序为分支队列。mixed_of 为空 → []（fallback 放行）。
 * 与 content_kind 同一"schema 免费收敛"哲学——不再用 entities 启发式推断。
 */
export function normalizeMixedOf(mixedOf) {
  if (!Array.isArray(mixedOf)) return []
  const seen = new Set()
  const kinds = []
  for (const item of mixedOf) {
    if (typeof item !== 'string' || item === '') continue
    if (!MIXABLE_KINDS.has(item)) continue
    if (seen.has(item)) continue
    seen.add(item)
    kinds.push(item)
  }
  return kinds
    .sort(
      (a, b) =>
        (KIND_PRIORITY.indexOf(a) === -1 ? 99 : KIND_PRIORITY.indexOf(a)) -
        (KIND_PRIORITY.indexOf(b) === -1 ? 99 : KIND_PRIORITY.indexOf(b)),
    )
    .slice(0, MAX_MIXED_BRANCHES)
}

/** 分支引导：("kind","sub") 精确 → ("kind","") → "_default"。 */
export function mixedGuidance(kind, sub = '') {
  const exact = BRANCH_GUIDANCE.get(`${kind}:${sub}`)
  if (exact !== undefined) return exact
  const fallback = BRANCH_GUIDANCE.get(`${kind}:`)
  return fallback !== undefined ? fallback : BRANCH_GUIDANCE.get('_default')
}

/**
 * 分支队列：主分支必含，次分支按序追加；去重 + MAX_MIXED_BRANCHES 封顶。
 * 移植 dsh-vision _build_branches 语义（主类必含 + 聚焦点差异类 + ≤2 封顶）。
 * 内容类型（document/ui/code/table）是单一路径，不产生多分支；分支只出现在
 * mixed 图的 ui+document 等组合。
 * `general` 是 mixed_of 的合法枚举（schema 允许 document|ui|code|chat|
 * general）——作为次分支必须保留：`['ui', 'general']` 表示"界面 + 未能归类
 * 的另一部分内容"，丢弃 general 会让那一半内容失去分支引导，与"避免 mixed
 * 另一半内容被漏判"的目标冲突。general 分支的引导为放行（模型自由识别）。
 * 仅 `unknown`（非法值，normalizer 已过滤，此处仅为独立调用防呆）跳过。
 */
export function buildMixedBranches(mainKind, secondaryKinds = []) {
  const seen = new Set([mainKind])
  const out = [{ kind: mainKind, sub: '', guidance: mixedGuidance(mainKind) }]
  for (const kind of secondaryKinds) {
    if (seen.has(kind) || kind === 'unknown') continue
    seen.add(kind)
    out.push({ kind, sub: '', guidance: mixedGuidance(kind) })
    if (out.length >= MAX_MIXED_BRANCHES) break
  }
  return out
}

/**
 * 消费 bootstrap 的结构化输出（normalizer 已产出校验过的 mixed_of），产出
 * mixed 分路决策。防呆：mixed_of 缺失/为空 → fallback=true（放行，绝不硬拦）；
 * 1 类 → 单分支；2 类 → 双分支（≤2 封顶）。
 */
export function planMixedBranches(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    return { visual_kind: 'mixed', branches: [], fallback: true, note: 'mixed 细分缺失 → 放行（模型自由选择识别方式，同现状行为）' }
  }
  const kinds = normalizeMixedOf(evidence.mixed_of)
  if (kinds.length === 0) {
    return { visual_kind: 'mixed', branches: [], fallback: true, note: 'mixed 细分缺失 → 放行（模型自由选择识别方式，同现状行为）' }
  }
  return {
    visual_kind: 'mixed',
    branches: buildMixedBranches(kinds[0], kinds.slice(1)),
    fallback: false,
    note: `mixed 分路识别：**精度优化**（避免漏判/错判另一半内容）；≤${MAX_MIXED_BRANCHES} 分支，每分支一次识别调用，成本封顶`,
  }
}

/**
 * 生成注入给模型的混合分支引导文案（中文，供 followupReminder 使用）。
 * depth='fast' 时退化为单主分支：fast 档位成本优先，精度优化的双分支
 * 让位于档位——文案与 depthLimitFor('fast')=1 的硬上限保持一致，不再出现
 * "各分支至少一次识别调用"（≥2 次）与 fast 档位句（1 次深挖即可）自相矛盾。
 * 其他档位（含默认）保持完整双分支精度引导。
 */
export function renderMixedGuidance(plan, depth) {
  if (!plan || plan.fallback || plan.branches.length === 0) return undefined
  const fast = depth === 'fast'
  const branches = fast ? plan.branches.slice(0, 1) : plan.branches
  const lines = branches.map((branch) => `- ${branch.kind}${branch.sub ? `.${branch.sub}` : ''}：${branch.guidance}`)
  const kinds = plan.branches.map((branch) => branch.kind).join(' + ')
  const header = fast
    ? `检测到混合内容（${kinds}）。本轮深度档位为 fast：先验证主分支（${branches[0].kind}）一次；完整分路验证需升级档位。`
    : `检测到混合内容（${kinds}）。为避免漏判/错判（精度优化），请按分支分别验证，各分支至少一次识别调用后再作答；` +
      '分支之间不要混用识别方式。'
  return `${header}\n${lines.join('\n')}`
}
