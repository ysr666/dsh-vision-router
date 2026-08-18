// 看图深度与场景引导（depth-guidance）。
//
// 移植自 dsh-vision 的「模板 + 路由」两层结构（prompts.py / vision_client.py）：
// - 模板层：按大类各写一条引导（zoom_* 的等价物），彼此独立、无组合
// - 档位层：fast/standard/deep 只决定"深挖多少"（步骤/上限），不参与提示词组合
// 因此这里是"模板集合"而非"提示词矩阵"——工作量 = 引导表 + 拼接函数。
//
// 拼接规则（运行时）：
//   guidance = 场景引导（按 visual_kind 查表）
//            + general 时内容引导（按内容大类查表，纯提示词兜底）
//            + 档位句（fast 附"档位不足"提示，搬 dsh-vision 回答节思想）
// 语言模型的追问 question 由模型自己生成（现状已自由），本模块不生成。

const MAX_OVERRIDE_CHARS = 2000

// 用 null-prototype 表避免异常 kind（如 constructor / __proto__）命中
// Object.prototype 上的继承属性。
const SCENE_GUIDANCE = Object.assign(Object.create(null), {
  code: '检测到代码内容。代码必须逐字转写，建议分区域转写 + 语义确认，避免概括。',
  document: '检测到文档内容。语义优先；仅当需要逐字引用（长文档/合同/表单）时才用 OCR。',
  ui: '检测到界面内容。建议元素清单（detect）+ 关键元素定位（ground）。',
  chat: '检测到聊天截图。关注气泡顺序与关键信息提取。',
  // general 无固定场景引导——由 content_kind 内容引导接管（bootstrap 判出）
  // mixed / unknown 无场景引导（mixed 走分支引导，unknown 放行）
})

// ── 内容引导表（按 content_kind 大类；bootstrap 判出，纯提示词方向，无出口绑定）──
// 能力上限由用户配置的后端链决定，本表只负责"问对方向"。
const CONTENT_GUIDANCE = Object.assign(Object.create(null), {
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
})

// general 且 content_kind 未知时的通用兜底（要求模型自行判断主体方向）。
const GENERAL_FALLBACK_GUIDANCE =
  '检测到未能明确归类的图。请先判断图中主体类别（人物/动物/植物/食物/交通工具/机器/建筑/物品/场景/表情包），' +
  '再按该主体方向深挖（深挖时由你自行生成针对性问题）。'

// ── 档位句 ────────────────────────────────────────────────────────────────
const DEPTH_COPY = {
  fast: '本轮深度档位为 fast：仅做初步判断 + 1 次深挖即可；若你的问题需要深度定向识别，请告知用户升级档位。',
  standard: '本轮深度档位为 standard：深挖 1-2 次即可；第 2 次之后会停止新的证据调用。',
  deep: '本轮深度档位为 deep：可做 2-4 次充分深挖（定位→裁剪→比对→OCR 等）后再作答。',
}

/**
 * 深度硬上限：fast=1、standard=2、deep=4。bootstrap 那 1 遍不计入。
 * UI/提示词里的“1-2 次”现在与运行时限制一致，避免默认档位无界深挖。
 */
export function depthLimitFor(depth) {
  if (depth === 'fast') return 1
  if (depth === 'deep') return 4
  return 2
}

/** 查表：覆盖表（guidanceOverrides）优先，其次内置表，最后 fallback。 */
function resolveGuidance(kind, overrides, table, fallback = '') {
  if (Array.isArray(overrides)) {
    // 后写覆盖前写：重复 kind 的导入/编辑结果确定为 last-wins。
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
export function sceneGuidanceFor(visualKind, overrides) {
  return resolveGuidance(visualKind, overrides, SCENE_GUIDANCE)
}

/** 内容引导：按内容大类查表（覆盖优先）；无则空串。 */
export function contentGuidanceFor(contentKind, overrides) {
  return resolveGuidance(contentKind, overrides, CONTENT_GUIDANCE)
}

/**
 * 拼接一条完整的深挖引导（场景/内容 + 档位）。
 * general 时用 content_kind 内容引导（精确方向）；content_kind 未知 → 通用兜底句。
 * guidanceOverrides：可配置的引导覆盖表（默认 undefined = 内置表）。
 * @param {object} opts - { visualKind, contentKind, depth, guidanceOverrides }
 * @returns {string} 空串表示无引导（放行）
 */
export function renderDepthGuidance({ visualKind, contentKind, depth, guidanceOverrides } = {}) {
  const depthCopy = DEPTH_COPY[depth === 'fast' || depth === 'deep' ? depth : 'standard']
  if (!depthCopy) return ''
  const scene = sceneGuidanceFor(visualKind, guidanceOverrides)
  const content = contentGuidanceFor(contentKind, guidanceOverrides)
  const parts = []
  if (scene) {
    parts.push(scene)
  } else if (visualKind === 'general') {
    // general（媒介无引导）：bootstrap 判出的 content_kind 给精确方向；未知则兜底
    parts.push(content || GENERAL_FALLBACK_GUIDANCE)
  }
  parts.push(depthCopy)
  return parts.join('')
}
