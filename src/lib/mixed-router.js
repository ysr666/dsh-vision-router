import { currentDepthRuntimeLocale } from './depth-guidance.js'
import { runtimeLanguageFor } from './runtime-i18n.js'

// 场景级识图路由层 · mixed 分路识别（mixed-router）。
//
// 定位：**精度优化**（不是成本优化）。
//
// bootstrap 判定 visual_kind=mixed 后，将混合内容拆为 ≤2 个分支，各分支独立
// 软引导识别方式，避免漏判/错判。深度档位现在只决定查证策略，不再通过
// fast/standard/deep 改写分支数或限制调用次数；调用次数若需要限制，由独立的
// visionDepthMaxCalls 安全阀负责。

export const MAX_MIXED_BRANCHES = 2

const ENTITY_TYPES = new Set(['text', 'button', 'input', 'image', 'icon', 'object', 'person', 'other'])
const UI_SIGNAL_TYPES = new Set(['button', 'input', 'icon'])
void ENTITY_TYPES
void UI_SIGNAL_TYPES

const BRANCH_GUIDANCE = Object.freeze({
  zh: new Map([
    ['document:code', '仅当任务依赖可执行或逐字代码时才做逐字转写；否则按语义问题查证'],
    ['document:form', '语义优先，逐字字段名/值确需引用时用 OCR'],
    ['document:table', '结构提取优先，数字/金额逐字（表格 OCR 专精场景）'],
    ['document:', '语义优先；仅当需要逐字引用（长文档/合同/表单）时才用 OCR'],
    ['ui:', '按问题需要选择语义复核、元素盘点或精确定位，不固定工具组合'],
    ['code:', '仅当任务依赖可执行或逐字代码时才要求逐字保真；否则按语义问题查证'],
    ['table:', '结构提取优先，数字/金额逐字'],
    ['_default', '放行（模型自由选择识别方式）'],
  ]),
  en: new Map([
    ['document:code', 'use verbatim transcription only when the task depends on executable or text-exact code; otherwise verify the semantic question directly'],
    ['document:form', 'prefer semantic understanding; use OCR when exact field names or values must be quoted'],
    ['document:table', 'prefer structural extraction; preserve numbers and amounts exactly (table OCR is a specialized case)'],
    ['document:', 'prefer semantic understanding; use OCR only when verbatim quotation is required for long documents, contracts, or forms'],
    ['ui:', 'choose semantic verification, element inventory, or precise localization according to the question; do not require a fixed tool combination'],
    ['code:', 'require verbatim fidelity only when the task depends on executable or text-exact code; otherwise verify the semantic question directly'],
    ['table:', 'prefer structural extraction and preserve numbers/amounts exactly'],
    ['_default', 'allow the model to choose the recognition method freely'],
  ]),
})

const KIND_PRIORITY = ['ui', 'document', 'code', 'table', 'chat', 'general']
const MIXABLE_KINDS = new Set(['document', 'ui', 'code', 'chat', 'general'])

function languageFor(locale) {
  return runtimeLanguageFor(locale ?? currentDepthRuntimeLocale(), 'zh')
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
export function mixedGuidance(kind, sub = '', locale) {
  const table = BRANCH_GUIDANCE[languageFor(locale)]
  const exact = table.get(`${kind}:${sub}`)
  if (exact !== undefined) return exact
  const fallback = table.get(`${kind}:`)
  return fallback !== undefined ? fallback : table.get('_default')
}

export function buildMixedBranches(mainKind, secondaryKinds = [], locale) {
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

export function planMixedBranches(evidence, locale) {
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
      ? `Mixed-content branch routing: precision optimization to avoid missing or misclassifying another content type; at most ${MAX_MIXED_BRANCHES} branches.`
      : `mixed 分路识别：**精度优化**（避免漏判/错判另一半内容）；最多 ${MAX_MIXED_BRANCHES} 个分支。`,
  }
}

/**
 * Generate mixed-content follow-up guidance. Depth strategy does not change
 * branch coverage; every planned branch remains visible to the model.
 */
export function renderMixedGuidance(plan, _depth, locale) {
  if (!plan || plan.fallback || plan.branches.length === 0) return undefined
  const language = languageFor(locale)
  const branches = plan.branches
  const lines = branches.map((branch) => {
    const guidance = mixedGuidance(branch.kind, branch.sub, language)
    return language === 'en'
      ? `- ${branch.kind}${branch.sub ? `.${branch.sub}` : ''}: ${guidance}`
      : `- ${branch.kind}${branch.sub ? `.${branch.sub}` : ''}：${guidance}`
  })
  const kinds = branches.map((branch) => branch.kind).join(' + ')
  const header = language === 'en'
    ? `Mixed content detected (${kinds}). Focus on the branch or branches relevant to the user question. If the answer depends on more than one branch, verify those branches separately as needed; do not reuse one branch's recognition method blindly for another branch.`
    : `检测到混合内容（${kinds}）。只关注与用户问题相关的分支；如果答案确实依赖多个分支，再按需分别验证这些分支。分支之间不要盲目混用识别方式。`
  return `${header}\n${lines.join('\n')}`
}
