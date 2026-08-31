import { AsyncLocalStorage } from 'node:async_hooks'
import { runtimeLanguageFor } from './runtime-i18n.js'

// 看图深度与场景引导（depth-guidance）。
//
// 移植自 dsh-vision 的「模板 + 路由」两层结构（prompts.py / vision_client.py）：
// - 模板层：按大类各写一条引导（zoom_* 的等价物），彼此独立、无组合
// - 档位层：fast/standard/deep/custom 只决定"深挖多少"（步骤/上限），不参与提示词组合
// 因此这里是"模板集合"而非"提示词矩阵"——工作量 = 引导表 + 拼接函数。
//
// 拼接规则（运行时）：
//   guidance = 场景引导（按 visual_kind 查表）
//            + general 时内容引导（按内容大类查表，纯提示词兜底）
//            + 档位句（fast 附"档位不足"提示，搬 dsh-vision 回答节思想）
// 语言模型的追问 question 由模型自己生成（现状已自由），本模块不生成。

const MAX_OVERRIDE_CHARS = 2000
const DEPTH_RUNTIME_CONTEXT = new AsyncLocalStorage()

// index.js predates the custom tier and still normalizes an unknown depth to
// standard before it calls the helpers below. Keep the public core untouched:
// the entry-layer structured guard exposes the live settings through this
// async-local scope, so both the old inner quota and the outer hardening guard
// see one authoritative fast=1 / standard=2 / deep=4 / custom=N policy.
export function runWithDepthConfig(config, execute) {
  if (typeof execute !== 'function') return undefined
  const value = config && typeof config === 'object' ? config : {}
  return DEPTH_RUNTIME_CONTEXT.run(value, execute)
}

function activeDepth(depth, customMax) {
  const runtime = DEPTH_RUNTIME_CONTEXT.getStore()
  if (runtime && runtime.visionDepth === 'custom') {
    return { depth: 'custom', customMax: runtime.visionDepthMaxCalls }
  }
  return { depth, customMax }
}

function normalizeCustomMax(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.min(100, Math.max(1, Math.floor(number)))
}

const SCENE_GUIDANCE = Object.freeze({
  zh: Object.assign(Object.create(null), {
    code: '检测到代码内容。代码必须逐字转写，建议分区域转写 + 语义确认，避免概括。',
    document: '检测到文档内容。语义优先；仅当需要逐字引用（长文档/合同/表单）时才用 OCR。',
    ui: '检测到界面内容。建议元素清单（detect）+ 关键元素定位（ground）。',
    chat: '检测到聊天截图。关注气泡顺序与关键信息提取。',
  }),
  en: Object.assign(Object.create(null), {
    code: 'Code content detected. Transcribe code verbatim; use region-by-region transcription plus semantic verification instead of summarizing it.',
    document: 'Document content detected. Prefer semantic understanding; use OCR only when verbatim quotation is required, such as for long documents, contracts, or forms.',
    ui: 'UI content detected. Prefer an element inventory (detect) plus grounding of the important elements (ground).',
    chat: 'Chat screenshot detected. Preserve message-bubble order and extract the important information.',
  }),
})

const CONTENT_GUIDANCE = Object.freeze({
  zh: Object.assign(Object.create(null), {
    person: '图中主体为人物：关注身份/表情/数量/姿态/关系/穿着。',
    animal: '图中主体为动物：关注物种/数量/状态/环境。',
    plant: '图中主体为植物：关注种类/生长状态/环境。',
    food: '图中主体为食物：关注菜品/食材/卖相/就餐场景。',
    vehicle: '图中主体为交通工具：关注品牌/型号/颜色/新旧/牌照。',
    machine: '图中主体为机器/设备：关注类型/用途/状态/铭牌。',
    architecture: '图中主体为建筑：关注类型/风格/细节/年代。',
    object: '图中主体为物品：关注名称/材质/用途/品牌/型号。',
    scene: '图中主体为场景：关注场景类型/主体/前景背景/光线/天气。',
    meme: '图中为表情包/梗图：关注模板、文字与表达含义。',
  }),
  en: Object.assign(Object.create(null), {
    person: 'The main subject is a person or people: focus on identity, expression, count, posture, relationships, and clothing.',
    animal: 'The main subject is an animal or animals: focus on species, count, condition, and environment.',
    plant: 'The main subject is a plant or plants: focus on type, growth condition, and environment.',
    food: 'The main subject is food: focus on the dish, ingredients, appearance, and dining context.',
    vehicle: 'The main subject is a vehicle: focus on make, model, color, condition, and license plate when visible.',
    machine: 'The main subject is a machine or device: focus on type, purpose, condition, and nameplate information.',
    architecture: 'The main subject is architecture: focus on type, style, details, and period when inferable from visible evidence.',
    object: 'The main subject is an object: focus on its name, material, purpose, brand, and model when visible.',
    scene: 'The main subject is a scene: focus on scene type, subjects, foreground/background, lighting, and weather.',
    meme: 'The image is a meme/reaction image: focus on the template, text, and intended meaning.',
  }),
})

const GENERAL_FALLBACK_GUIDANCE = Object.freeze({
  zh: '检测到未能明确归类的图。请先判断图中主体类别（人物/动物/植物/食物/交通工具/机器/建筑/物品/场景/表情包），再按该主体方向深挖（深挖时由你自行生成针对性问题）。',
  en: 'The image could not be classified confidently. First identify the main subject category (person, animal, plant, food, vehicle, machine, architecture, object, scene, or meme), then deepen the inspection in that direction and generate targeted questions as needed.',
})

const DEPTH_COPY = Object.freeze({
  zh: Object.freeze({
    fast: '本轮深度档位为 fast：仅做初步判断 + 1 次深挖即可；若你的问题需要深度定向识别，请告知用户升级档位。',
    standard: '本轮深度档位为 standard：深挖 1-2 次即可；第 2 次之后会停止新的证据调用。',
    deep: '本轮深度档位为 deep：可做 2-4 次充分深挖（定位→裁剪→比对→OCR 等）后再作答。',
  }),
  en: Object.freeze({
    fast: 'Vision depth is fast for this turn: make the initial judgment plus at most 1 deep-evidence call. If the question needs deeper targeted inspection, tell the user to raise the depth tier.',
    standard: 'Vision depth is standard for this turn: use 1-2 deep-evidence calls as needed; no new evidence calls are allowed after the second.',
    deep: 'Vision depth is deep for this turn: use 2-4 evidence calls as needed (for example grounding → crop → comparison → OCR) before answering.',
  }),
})

function languageFor(locale) {
  return runtimeLanguageFor(locale, 'zh')
}

/**
 * 深度硬上限：fast=1、standard=2、deep=4。bootstrap 那 1 遍不计入。
 * custom=N（1-100）时 N 是本轮成功深挖调用的硬上限；custom=0/空值
 * 表示不设置次数上限。保存过的 custom 数值在切回内置档位后保留但不生效。
 */
export function depthLimitFor(depth, customMax) {
  const active = activeDepth(depth, customMax)
  if (active.depth === 'custom') {
    const custom = normalizeCustomMax(active.customMax)
    return custom > 0 ? custom : undefined
  }
  if (active.depth === 'fast') return 1
  if (active.depth === 'deep') return 4
  return 2
}

/** 档位句，与 depthLimitFor 的实际硬限制保持一致。 */
export function depthCopyFor(depth, customMax, locale = 'zh') {
  const active = activeDepth(depth, customMax)
  const language = languageFor(locale)
  if (active.depth === 'custom') {
    const custom = normalizeCustomMax(active.customMax)
    if (language === 'en') {
      return custom > 0
        ? `Vision depth has a custom limit of ${custom} deep-evidence calls for this turn; once reached, answer from the evidence already collected.`
        : 'Vision depth is custom with no call-count limit for this turn; continue calling vision tools only when they can add or verify evidence.'
    }
    return custom > 0
      ? `本轮已自定义深挖上限为 ${custom} 次；达到上限后请基于已有证据作答。`
      : '本轮已选择自定义深挖：不设置次数上限；请只在能新增或验证证据时继续调用视觉工具。'
  }
  return DEPTH_COPY[language][active.depth === 'fast' || active.depth === 'deep' ? active.depth : 'standard'] || ''
}

/** 查表：覆盖表（guidanceOverrides）优先，其次内置表，最后 fallback。 */
function resolveGuidance(kind, overrides, table, fallback = '') {
  if (Array.isArray(overrides)) {
    for (let i = overrides.length - 1; i >= 0; i--) {
      const entry = overrides[i]
      if (entry && entry.kind === kind && typeof entry.text === 'string' && entry.text.trim() !== '') {
        return entry.text.trim().slice(0, MAX_OVERRIDE_CHARS)
      }
    }
  }
  return Object.prototype.hasOwnProperty.call(table, kind) ? table[kind] : fallback
}

/** 场景引导：按 visual_kind 查表（覆盖优先）；无则空串（不硬套）。 */
export function sceneGuidanceFor(visualKind, overrides, locale = 'zh') {
  return resolveGuidance(visualKind, overrides, SCENE_GUIDANCE[languageFor(locale)])
}

/** 内容引导：按内容大类查表（覆盖优先）；无则空串。 */
export function contentGuidanceFor(contentKind, overrides, locale = 'zh') {
  return resolveGuidance(contentKind, overrides, CONTENT_GUIDANCE[languageFor(locale)])
}

/**
 * 拼接一条完整的深挖引导（场景/内容 + 档位）。
 * general 时用 content_kind 内容引导（精确方向）；content_kind 未知 → 通用兜底句。
 * guidanceOverrides：可配置的引导覆盖表（默认 undefined = 内置表）。
 * locale：宿主 locale.preference；缺失时保留历史 zh 默认。
 * @returns {string} 空串表示无引导（放行）
 */
export function renderDepthGuidance({ visualKind, contentKind, depth, guidanceOverrides, customMax, locale = 'zh' } = {}) {
  const language = languageFor(locale)
  const depthCopy = depthCopyFor(depth, customMax, language)
  if (!depthCopy) return ''
  const scene = sceneGuidanceFor(visualKind, guidanceOverrides, language)
  const content = contentGuidanceFor(contentKind, guidanceOverrides, language)
  const parts = []
  if (scene) {
    parts.push(scene)
  } else if (visualKind === 'general') {
    parts.push(content || GENERAL_FALLBACK_GUIDANCE[language])
  }
  parts.push(depthCopy)
  return parts.join('')
}
