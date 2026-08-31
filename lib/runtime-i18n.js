const DEFAULT_LANGUAGE = 'zh'

const RUNTIME_MESSAGES = Object.freeze({
  zh: Object.freeze({
    attachmentName: '图片',
    staleSystemPrompt: '[vision-router: 系统提示已过期]',
    cachedImageMemory: '[图片「{name}」此前由视觉模型读取，内容记录：\n{memory}\n]',
    cachedAttachmentMemory: '[图片附件「{name}」：此前会话中已读取，内容记录：\n{memory}\n]',
    instantLocalNote: '[图片「{name}」{instant}]（注：以上是本地视觉识别结果，可直接作为当前图片的视觉证据；若问题需要像素级定位/裁剪/OCR/比色等，再调用视觉工具。）',
    freshAttachmentNote: '[已收到图片「{name}」（附件 id：「{id}」）。我可以借助视觉工具来看图：先结合当前问题判断需要什么视觉证据；若已有本地预识别结果可直接使用，需要像素级定位/裁剪/OCR/比色等再调用对应视觉工具。]',
    structuredBootstrapReminder: '已收到图片。我开启了「结构化预识别」：请先基于结构化视觉基线理解整图，再继续至少一次有针对性的视觉取证，然后再回答用户。',
    structuredFollowupBase: '图片的整体预识别已经完成。请把它当作视觉基线，不要重复做同一遍泛化识别；接下来根据用户问题选择能新增或验证证据的视觉工具。',
    ocrPolicy: '不要默认把 OCR 当第二步；只有当用户需要逐字转写、精确字段/数字、代码、合同/表单或其他逐字证据时才使用 OCR。',
    autoMountReminder: '本轮消息包含图片，像素级视觉工具已自动挂载。请仅在能新增或验证视觉证据时调用；不要为了满足形式而重复识图。',
    deepToolsUnavailable: '视觉深看工具尚不可用。',
    deepToolsAlreadyMounted: '视觉深看工具已在挂载状态。',
    deepToolsMounted: '视觉深看工具已挂载：{tools}',
    depthLimitReason: '本轮深度档位为 {depth}，深挖调用已达上限 {limit} 次；请基于已有证据作答',
    localStructuredPrompt: '请按以下结构识别这张图片（这是本地视觉识别）：\n1. 一句话概括整图。\n2. 列出关键人物/物体/界面元素及其关系。\n3. 转写对当前理解重要且清晰可见的文字；不要臆测看不清的文字。\n4. 如果能判断，指出画面类型、场景和用户最可能关心的细节。\n要求：基于可见证据，简洁但具体；不确定处明确说明。',
    localPlainPrompt: '请详细描述这张图片中可见的内容。优先回答主体、关键细节、重要文字以及它们之间的关系；不要臆测看不清的信息。',
    localRecognitionPrefix: '已由本地视觉识别（本地识别 {elapsedSec}s）\n{plain}',
    skillTitle: '视觉深看工具 · Vision Tools',
    skillDescription: '对图片做像素级深挖：问答、定位、裁剪、OCR、颜色、差异、截图、SVG 描摹与抠图。',
    skillWhenToUse: '当整图预识别不足以回答问题，且需要新增或验证像素级视觉证据时使用。',
    skillContent: '先使用已有的结构化预识别/图片记忆作为基线。只有当问题确实需要更多视觉证据时，再选择最小必要工具：vision_ask 用于定向问答，vision_ground/vision_detect 用于定位，vision_crop 用于局部放大，vision_ocr 用于逐字证据，其他工具用于颜色、差异、SVG、抠图或桌面截图。不要重复已经完成的泛化识图。',
    ocrFallbackPrompt: '请原样转述图中的所有文字，保留换行与顺序；无法辨认的部分用 [无法辨认] 标记。只输出文字本身。',
  }),
  en: Object.freeze({
    attachmentName: 'image',
    staleSystemPrompt: '[vision-router: stale system prompt removed]',
    cachedImageMemory: '[Image “{name}” was read earlier by the vision model. Recorded visual memory:\n{memory}\n]',
    cachedAttachmentMemory: '[Image attachment “{name}” was read earlier in this conversation. Recorded visual memory:\n{memory}\n]',
    instantLocalNote: '[Image “{name}”{instant}] (Note: the text above is the local vision result and can be used directly as evidence for this image. Call a vision tool only if the question needs pixel-level grounding, cropping, OCR, color analysis, or similar evidence.)',
    freshAttachmentNote: '[Received image “{name}” (attachment id: “{id}”). I can inspect it with vision tools: first decide what visual evidence the current question needs; reuse any local pre-recognition result when available, and call pixel-level grounding, crop, OCR, color, or other tools only when needed.]',
    structuredBootstrapReminder: 'An image was received. Structured visual bootstrap is enabled: first use the structured baseline to understand the whole image, then perform at least one targeted visual evidence call before answering the user.',
    structuredFollowupBase: 'The whole-image structured bootstrap is complete. Treat it as the visual baseline and do not repeat the same generic recognition pass; next choose a vision tool only when it can add or verify evidence required by the user’s question.',
    ocrPolicy: 'Do not use OCR as the default second step. Use it only when the user needs verbatim transcription, exact fields or numbers, code, contracts/forms, or other text-exact evidence.',
    autoMountReminder: 'This turn contains an image, so pixel-level vision tools were mounted automatically. Call them only when they can add or verify visual evidence; do not repeat image recognition merely to satisfy a workflow.',
    deepToolsUnavailable: 'Pixel-level vision tools are not available yet.',
    deepToolsAlreadyMounted: 'Pixel-level vision tools are already mounted.',
    deepToolsMounted: 'Pixel-level vision tools mounted: {tools}',
    depthLimitReason: 'The {depth} vision-depth tier has reached its limit of {limit} deep-evidence calls for this turn; answer from the evidence already collected.',
    localStructuredPrompt: 'Analyze this image using the following structure (local vision recognition):\n1. Summarize the whole image in one sentence.\n2. List the key people, objects, or UI elements and their relationships.\n3. Transcribe clearly visible text that matters to understanding the image; do not guess unreadable text.\n4. When possible, identify the image type, scene, and details the user is most likely to care about.\nRequirements: stay grounded in visible evidence, be concise but specific, and state uncertainty explicitly.',
    localPlainPrompt: 'Describe the visible contents of this image in detail. Prioritize the main subject, important details, relevant text, and their relationships. Do not guess information that is not clearly visible.',
    localRecognitionPrefix: 'Recognized by local vision (local recognition {elapsedSec}s)\n{plain}',
    skillTitle: 'Vision Tools',
    skillDescription: 'Pixel-level image inspection: Q&A, grounding, crop, OCR, colors, diffs, screenshots, SVG tracing, and cutout.',
    skillWhenToUse: 'Use when the whole-image baseline is insufficient and the question needs new or verified pixel-level visual evidence.',
    skillContent: 'Start from the existing structured bootstrap or image memory. Only when the question genuinely needs more visual evidence, choose the smallest necessary tool: vision_ask for targeted Q&A, vision_ground/vision_detect for localization, vision_crop for local zoom, vision_ocr for verbatim text evidence, and the other tools for colors, diffs, SVG tracing, cutout, or desktop screenshots. Do not repeat generic image recognition that is already complete.',
    ocrFallbackPrompt: 'Transcribe all text in the image verbatim, preserving line breaks and order. Mark unreadable parts as [unreadable]. Output only the transcription.',
  }),
})

function normalizeLocaleTag(value) {
  return String(value ?? '')
    .trim()
    .replaceAll('_', '-')
    .toLowerCase()
}

/**
 * Resolve the plugin's two built-in runtime dictionaries from an arbitrary
 * host locale. Chinese locale tags use zh; every other explicit locale falls
 * back to en, matching DSH's external-locale fallback direction. When the host
 * does not expose a preference at all, keep the plugin's historical zh default.
 */
export function runtimeLanguageFor(preference, fallback = DEFAULT_LANGUAGE) {
  const normalized = normalizeLocaleTag(preference)
  if (!normalized) return fallback === 'en' ? 'en' : DEFAULT_LANGUAGE
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh'
  return 'en'
}

export function readHostLocalePreference(ctx) {
  try {
    const settings = ctx?.get?.('settings')
    const snapshot = settings?.get?.('locale')
    const preference = snapshot && typeof snapshot === 'object' ? snapshot.preference : undefined
    return typeof preference === 'string' && preference.trim() !== '' ? preference.trim() : undefined
  } catch {
    return undefined
  }
}

function interpolate(template, values) {
  const input = values && typeof values === 'object' ? values : {}
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(input, key) ? String(input[key] ?? '') : match,
  )
}

export function runtimeMessage(language, key, values) {
  const lane = language === 'en' ? 'en' : 'zh'
  const template = RUNTIME_MESSAGES[lane][key]
  if (typeof template !== 'string') throw new Error(`Unknown runtime i18n key: ${key}`)
  return interpolate(template, values)
}

/**
 * Live host-side translator. No locale state is copied into the plugin: every
 * call reads settings.get('locale').preference again, so a host locale change
 * takes effect without rebuilding the runtime or restarting the plugin.
 */
export function createRuntimeI18n(ctx, { fallback = DEFAULT_LANGUAGE } = {}) {
  const language = () => runtimeLanguageFor(readHostLocalePreference(ctx), fallback)
  return Object.freeze({
    language,
    preference: () => readHostLocalePreference(ctx),
    t(key, values) {
      return runtimeMessage(language(), key, values)
    },
  })
}

export const DEEP_TOOL_MOUNT_STATE = Object.freeze({
  unavailable: 'unavailable',
  alreadyMounted: 'already-mounted',
  mounted: 'mounted',
})
