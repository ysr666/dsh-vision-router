import { runtimeLanguageFor } from './runtime-i18n.js'

// 场景级识图路由层 · mixed 分路识别（mixed-router）。
//
// 定位：**精度优化**（不是成本优化）。
//
// bootstrap 判定 visual_kind=mixed 后，1.5.3 没有任何后续处理——模型自由深挖
// 可能漏判另一半内容、选错识别方式（§4.6 缺陷实证：第一遍只知道"这是混合的"，
// 不知道"哪几种类型 + 各在哪些区域"）。本模块把混合内容拆分为 ≤2 个分支，各
// 分支独立软引导识别方式，避免漏判/错判，**提升混合图的识别精度**；成本影响是
// 副产品（MAX_MIXED_BRANCHES=2 封顶，混合图 ≤2 次视觉调用）。

export const MAX_MIXED_BRANCHES = 2

const ENTITY_TYPES = new Set(['text', 'button', 'input', 'image', 'icon', 'object', 'person', 'other'])
const UI_SIGNAL_TYPES = new Set(['button', 'input', 'icon'])
void ENTITY_TYPES
void UI_SIGNAL_TYPES

const BRANCH_GUIDANCE = Object.freeze({
  zh: new Map([
    ['document:code', '逐字转写（代码可执行性例外）'],
    ['document:form', '语义优先，逐字字段名/值确需引用时用 OCR'],
    ['document:table', '结构提取优先，数字/金额逐字（表格 OCR 专精场景）'],
    ['document:', '语义优先；仅当需要逐字引用（长文档/合同/表单）时才用 OCR'],
    ['ui:', 'detect / ground 优先（元素清单与像素定位）'],
    ['code:', '逐字转写（可执行性例外）'],
    ['table:', '结构提取优先，数字/金额逐字'],
    ['_default', '放行（模型自由选择识别方式）'],
  ]),
  en: new Map([
    ['document:code', 'transcribe verbatim (code executability requires text-exact evidence)'],
    ['document:form', 'prefer semantic understanding; use OCR when exact field names or values must be quoted'],
    ['document:table', 'prefer structural extraction; preserve numbers and amounts exactly (table OCR is a specialized case)'],
    ['document:', 'prefer semantic understanding; use OCR only when verbatim quotation is required for long documents, contracts, or forms'],
    ['ui:', 'prefer detect / ground for element inventory and pixel localization'],
    ['code:', 'transcribe verbatim (executability requires text-exact evidence)'],
    ['table:', 'prefer structural extraction and preserve numbers/amounts exactly'],
    ['_default', 'allow the model to choose the recognition method freely'],
  ]),
})

const KIND_PRIORITY = ['ui', 'document', 'code', 'table', 'chat', 'general']
const MIXABLE_KINDS = new Set(['document', 'ui', 'code', 'chat', 'general'])

function languageFor(locale) {
  return runtimeLanguageFor(locale, 'zh')
}

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

/** 分支引导：(kind,sub) 精确 → (kind,'') → _default。 */
export function mixedGuidance(kind, sub = '', locale = 'zh') {
  const table = BRANCH_GUIDANCE[languageFor(locale)]
  const exact = table.get(`${kind}:${sub}`)
  if (exact !== undefined) return exact
  const fallback = table.get(`${kind}:`)
  return fallback !== undefined ? fallback : table.get('_default')
}

export function buildMixedBranches(mainKind, secondaryKinds = [], locale = 'zh') {
  const seen = new Set([mainKind])
  const out = [{ kind: mainKind, sub: '', guidance: mixedGuidance(mainKind, '', locale) }]
  for (const kind of secondaryKinds) {
    if (seen.has(kind) || kind === 'unknown') continue
    seen.add(kind)
    out.push({ kind, sub: '', guidance: mixedGuidance(kind, '', locale) })
    if (out.length >= MAX_MIXED_BRANCHES) break
  }
  return out
}

export function planMixedBranches(evidence, locale = 'zh') {
  const language = languageFor(locale)
  if (!evidence || typeof evidence !== 'object') {
    return {
      visual_kind: 'mixed',
      branches: [],
      fallback: true,
      note: language === 'en'
        ? 'Mixed-content details are missing → allow the model to choose the recognition method freely.'
        : 'mixed 细分缺失 → 放行（模型自由选择识别方式，同现状行为）',
    }
  }
  const kinds = normalizeMixedOf(evidence.mixed_of)
  if (kinds.length === 0) {
    return {
      visual_kind: 'mixed',
      branches: [],
      fallback: true,
      note: language === 'en'
        ? 'Mixed-content details are missing → allow the model to choose the recognition method freely.'
        : 'mixed 细分缺失 → 放行（模型自由选择识别方式，同现状行为）',
    }
  }
  return {
    visual_kind: 'mixed',
    branches: buildMixedBranches(kinds[0], kinds.slice(1), language),
    fallback: false,
    note: language === 'en'
      ? `Mixed-content branch routing: precision optimization to avoid missing or misclassifying the other content type; ≤${MAX_MIXED_BRANCHES} branches, one recognition call per branch, with bounded cost.`
      : `mixed 分路识别：**精度优化**（避免漏判/错判另一半内容）；≤${MAX_MIXED_BRANCHES} 分支，每分支一次识别调用，成本封顶`,
  }
}

/**
 * Generate the mixed-content follow-up guidance. fast uses only the primary
 * branch so its copy remains consistent with depthLimitFor('fast')=1.
 */
export function renderMixedGuidance(plan, depth, locale = 'zh') {
  if (!plan || plan.fallback || plan.branches.length === 0) return undefined
  const language = languageFor(locale)
  const fast = depth === 'fast'
  const branches = fast ? plan.branches.slice(0, 1) : plan.branches
  const lines = branches.map((branch) => {
    const guidance = mixedGuidance(branch.kind, branch.sub, language)
    return language === 'en'
      ? `- ${branch.kind}${branch.sub ? `.${branch.sub}` : ''}: ${guidance}`
      : `- ${branch.kind}${branch.sub ? `.${branch.sub}` : ''}：${guidance}`
  })
  const kinds = plan.branches.map((branch) => branch.kind).join(' + ')
  let header
  if (language === 'en') {
    header = fast
      ? `Mixed content detected (${kinds}). Vision depth is fast for this turn: verify the primary branch (${branches[0].kind}) once; raise the depth tier for full branch-by-branch verification.`
      : `Mixed content detected (${kinds}). To avoid omissions or misclassification, verify each branch separately with at least one recognition call before answering; do not reuse one branch's recognition method blindly for another branch.`
  } else {
    header = fast
      ? `检测到混合内容（${kinds}）。本轮深度档位为 fast：先验证主分支（${branches[0].kind}）一次；完整分路验证需升级档位。`
      : `检测到混合内容（${kinds}）。为避免漏判/错判（精度优化），请按分支分别验证，各分支至少一次识别调用后再作答；分支之间不要混用识别方式。`
  }
  return `${header}\n${lines.join('\n')}`
}
