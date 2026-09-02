import { AsyncLocalStorage } from 'node:async_hooks'
import { runtimeLanguageFor } from './runtime-i18n.js'

// 看图深度与场景引导（depth-guidance）。
//
// 深度档位只决定模型如何查证，不再隐式决定调用次数：
// - fast：整体优先，减少不必要的重复识别；
// - standard：围绕用户问题按需查证；
// - deep：主动做局部检查与交叉验证。
//
// 调用次数是独立的可选安全阀：visionDepthMaxCalls=0/空值表示不限，
// 1-100 表示本轮成功深挖证据调用的硬上限。bootstrap 预识别不计入。
// 旧配置 visionDepth=custom 继续兼容，按 standard 引导解释；正数
// visionDepthMaxCalls 仍会作为独立次数上限生效。

const MAX_OVERRIDE_CHARS = 2000
const DEPTH_RUNTIME_CONTEXT = new AsyncLocalStorage()

export function runWithDepthConfig(config, execute) {
  if (typeof execute !== 'function') return undefined
  const value = config && typeof config === 'object' ? config : {}
  return DEPTH_RUNTIME_CONTEXT.run(value, execute)
}

export function currentDepthRuntimeLocale() {
  const value = DEPTH_RUNTIME_CONTEXT.getStore()?.__visionRouterLocale
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function strategyDepth(depth) {
  const runtime = DEPTH_RUNTIME_CONTEXT.getStore()
  const candidate = runtime?.visionDepth ?? depth
  return candidate === 'fast' || candidate === 'deep' ? candidate : 'standard'
}

function normalizeMaxCalls(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return Math.min(100, Math.max(1, Math.floor(number)))
}

function effectiveMaxCalls(explicit) {
  const runtime = DEPTH_RUNTIME_CONTEXT.getStore()
  if (runtime && Object.prototype.hasOwnProperty.call(runtime, 'visionDepthMaxCalls')) {
    return normalizeMaxCalls(runtime.visionDepthMaxCalls)
  }
  return normalizeMaxCalls(explicit)
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
    fast: '本轮看图策略为快速：先做整体判断，优先使用已有视觉基线；只有关键证据不确定，或用户明确要求精确定位/逐字信息时，再调用必要的视觉工具。避免重复泛化识别。',
    standard: '本轮看图策略为标准：围绕用户问题按需查证关键区域；需要时使用定位、裁剪、OCR、比对等工具补充或验证证据。证据充分后直接作答，不必为了流程继续调用。',
    deep: '本轮看图策略为细致：主动检查关键局部并做交叉验证；对重要文字、位置、细节或差异，按需组合定位、裁剪、OCR、比对等工具，重要结论尽量由独立证据相互印证后再作答。',
  }),
  en: Object.freeze({
    fast: 'Vision strategy is Quick for this turn: start from the whole-image judgment and reuse the existing visual baseline. Call an additional vision tool only when key evidence is uncertain or the user explicitly needs precise localization or verbatim text. Avoid repeating generic recognition.',
    standard: "Vision strategy is Standard for this turn: verify the key regions required by the user's question as needed. Use grounding, cropping, OCR, comparison, or other tools when they can add or verify evidence. Answer once the evidence is sufficient; do not keep calling tools just to satisfy a workflow.",
    deep: 'Vision strategy is Thorough for this turn: proactively inspect important regions and cross-check key claims. Combine grounding, cropping, OCR, comparison, and other precision tools as needed for important text, positions, details, or differences, and prefer independent evidence to corroborate important conclusions before answering.',
  }),
})

function languageFor(locale) {
  return runtimeLanguageFor(locale ?? currentDepthRuntimeLocale(), 'zh')
}

/**
 * Optional independent call cap. The depth strategy never supplies a cap.
 * The depth parameter is retained for API/backward compatibility.
 */
export function depthLimitFor(_depth, maxCalls) {
  return effectiveMaxCalls(maxCalls)
}

/** Strategy guidance plus an optional, separately configured call-cap note. */
export function depthCopyFor(depth, maxCalls, locale) {
  const language = languageFor(locale)
  const strategy = strategyDepth(depth)
  const strategyCopy = DEPTH_COPY[language][strategy] || DEPTH_COPY[language].standard
  const cap = effectiveMaxCalls(maxCalls)
  if (cap === undefined) return strategyCopy
  const capCopy = language === 'en'
    ? `A separate deep-dive call cap is enabled for this turn: at most ${cap} successful evidence calls. The bootstrap pre-scan does not count, and failed or empty-evidence calls do not consume the cap.`
    : `本轮另启用了深挖次数上限：最多 ${cap} 次成功证据调用；bootstrap 预识别不计入，失败或空证据调用不占次数。`
  return `${strategyCopy}\n${capCopy}`
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
export function sceneGuidanceFor(visualKind, overrides, locale) {
  return resolveGuidance(visualKind, overrides, SCENE_GUIDANCE[languageFor(locale)])
}

/** 内容引导：按 content_kind 大类查表（覆盖优先）；无则空串。 */
export function contentGuidanceFor(contentKind, overrides, locale) {
  return resolveGuidance(contentKind, overrides, CONTENT_GUIDANCE[languageFor(locale)])
}

/**
 * 拼接一条完整的深挖引导（场景/内容 + 策略 + 可选独立调用上限）。
 * general 时用 content_kind 内容引导（精确方向）；content_kind 未知 → 通用兜底句。
 * guidanceOverrides：可配置的引导覆盖表（默认 undefined = 内置表）。
 * locale：显式传入优先；否则跟随当前 Host runtime locale；缺失时保留历史 zh 默认。
 */
export function renderDepthGuidance({ visualKind, contentKind, depth, guidanceOverrides, customMax, maxCalls, locale } = {}) {
  const language = languageFor(locale)
  const callCap = maxCalls === undefined ? customMax : maxCalls
  const depthCopy = depthCopyFor(depth, callCap, language)
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
  return parts.join('\n')
}
