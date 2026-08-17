// Post-bootstrap scene router for the structured 1+x vision flow.
//
// The universal bootstrap stays mode-free: it looks at pixels first and emits
// a task-independent evidence map. Only AFTER that pass do we classify the
// visual scene and suggest the next specialist capability/tool. This keeps the
// user's proposed Scan -> scene -> Zoom -> specialist -> inference flow without
// reintroducing a pre-bootstrap OCR/document/UI/code mode choice.

export const VISION_SCENES = Object.freeze([
  'document.chat',
  'document.code',
  'document.table',
  'ui',
  'other',
])

const SCENE_INTENTS = Object.freeze({
  'document.chat': 'ocr',
  'document.code': 'code_screenshot',
  'document.table': 'document',
  ui: 'ui',
  other: 'general',
})

const textOf = (value) => (typeof value === 'string' ? value.trim() : '')
const arr = (value) => (Array.isArray(value) ? value : [])

function corpusOf(baseline) {
  const parts = [
    textOf(baseline?.visual_kind),
    textOf(baseline?.overview),
    ...arr(baseline?.regions).flatMap((item) => [textOf(item?.role), textOf(item?.content), textOf(item?.location)]),
    ...arr(baseline?.visible_text).map((item) => textOf(item?.text)),
    ...arr(baseline?.entities).flatMap((item) => [textOf(item?.type), textOf(item?.label), textOf(item?.state)]),
    ...arr(baseline?.uncertainties).map((item) => typeof item === 'string' ? item : textOf(item?.detail)),
  ]
  return parts.filter(Boolean).join('\n').toLowerCase()
}

function addSignal(bucket, scene, weight, signal) {
  bucket.scores[scene] += weight
  if (signal && !bucket.signals[scene].includes(signal)) bucket.signals[scene].push(signal)
}

function matches(text, pattern) {
  return pattern.test(text)
}

function chooseScene(scores) {
  const ranked = VISION_SCENES
    .map((scene) => ({ scene, score: scores[scene] }))
    .sort((a, b) => b.score - a.score || VISION_SCENES.indexOf(a.scene) - VISION_SCENES.indexOf(b.scene))
  const first = ranked[0]
  const second = ranked[1]
  if (!first || first.score <= 0) return { scene: 'other', score: 0, margin: 0 }
  return { scene: first.scene, score: first.score, margin: first.score - (second?.score ?? 0) }
}

function confidenceOf(score, margin) {
  // Explicit visual_kind signals put the score around 1.0. Keyword-only
  // evidence stays deliberately lower so ambiguous screenshots remain honest.
  const raw = 0.42 + Math.min(0.38, score * 0.26) + Math.min(0.18, Math.max(0, margin) * 0.22)
  return Number(Math.max(0.4, Math.min(0.99, raw)).toFixed(2))
}

function uncertaintyTarget(baseline) {
  const first = arr(baseline?.uncertainties).find((item) => {
    const detail = typeof item === 'string' ? item : textOf(item?.detail)
    return detail !== ''
  })
  if (!first) return ''
  if (typeof first === 'string') return first.trim()
  const region = textOf(first?.region_id)
  const detail = textOf(first?.detail)
  return [region, detail].filter(Boolean).join(': ')
}

function specialistFor(scene, baseline) {
  switch (scene) {
    case 'document.chat':
      return {
        tool: 'vision_ocr',
        intent: 'ocr',
        instruction:
          'Transcribe the relevant chat/message region faithfully in reading order, preserving speaker names, timestamps, punctuation and quoted text. Use OCR because exact text is the specialist requirement for this scene.',
      }
    case 'document.code':
      return {
        tool: 'vision_describe',
        intent: 'code_screenshot',
        instruction:
          'Inspect the code/terminal/log screenshot closely. Read the exact error lines, code tokens and nearby context needed for diagnosis; do not invent off-screen code.',
      }
    case 'document.table':
      return {
        tool: 'vision_describe',
        intent: 'document',
        instruction:
          'Read the document/table structure precisely, preserving headers, row/column relationships, totals and identifiers. Use a focused crop first when dense cells are uncertain.',
      }
    case 'ui':
      return {
        tool: 'vision_detect',
        intent: 'ui',
        instruction:
          'Enumerate the relevant UI controls/elements and their visible states. If the task asks for one exact target, use vision_ground before or after detection to verify its location.',
      }
    default: {
      const visualKind = textOf(baseline?.visual_kind).toLowerCase()
      return {
        tool: 'vision_describe',
        intent: visualKind === 'document' ? 'document' : 'general',
        instruction:
          visualKind === 'document'
            ? 'Inspect the document semantically and verify the regions that matter to the user task; use OCR only if verbatim text is required.'
            : 'Take a focused second look at the task-relevant region/object and add only evidence that the structured baseline does not already establish.',
      }
    }
  }
}

export function routePostBootstrapScene(baseline = {}, options = {}) {
  const visualKind = textOf(baseline?.visual_kind).toLowerCase()
  const corpus = corpusOf(baseline)
  const taskText = textOf(options.taskText).toLowerCase()
  const bucket = {
    scores: Object.fromEntries(VISION_SCENES.map((scene) => [scene, 0])),
    signals: Object.fromEntries(VISION_SCENES.map((scene) => [scene, []])),
  }

  if (visualKind === 'chat') addSignal(bucket, 'document.chat', 1.05, 'bootstrap visual_kind=chat')
  if (visualKind === 'code') addSignal(bucket, 'document.code', 1.05, 'bootstrap visual_kind=code')
  if (visualKind === 'ui') addSignal(bucket, 'ui', 0.72, 'bootstrap visual_kind=ui')
  if (visualKind === 'general') addSignal(bucket, 'other', 0.9, 'bootstrap visual_kind=general')
  if (visualKind === 'document') addSignal(bucket, 'other', 0.24, 'bootstrap visual_kind=document')
  if (visualKind === 'mixed') addSignal(bucket, 'other', 0.2, 'bootstrap visual_kind=mixed')

  if (matches(corpus, /\b(chat|message|conversation|messenger|speaker|timestamp|quoted message)\b|聊天|消息|对话|气泡|说话人|时间戳|引用/iu)) {
    addSignal(bucket, 'document.chat', 0.72, 'chat/message semantics')
  }
  if (matches(corpus, /\b(source code|code screenshot|terminal|console|traceback|stack trace|compiler|exception|shell|ide|log output)\b|代码|源码|终端|控制台|报错|堆栈|日志/iu)) {
    addSignal(bucket, 'document.code', 0.72, 'code/terminal semantics')
  }
  if (matches(corpus, /\b(table|spreadsheet|worksheet|workbook|grid|rows?|columns?|invoice|receipt|order summary|subtotal|total)\b|表格|电子表格|工作表|行列|发票|收据|合计|总计/iu)) {
    addSignal(bucket, 'document.table', 1.12, 'table/spreadsheet content semantics')
  }
  if (matches(corpus, /\b(button|input|checkbox|toggle|menu|dialog|modal|toolbar|webpage|website|settings|app screen|navigation)\b|按钮|输入框|复选框|开关|菜单|弹窗|网页|设置|界面|控件/iu)) {
    addSignal(bucket, 'ui', 0.7, 'UI/control semantics')
  }

  // The user task is consulted only AFTER the task-independent bootstrap. It
  // selects the relevant content scene (e.g. a table inside WPS/Excel) without
  // contaminating pass 1 with a task goal.
  if (/逐字|原样|完整.*聊天|发言顺序|聊天记录|transcribe|verbatim|chat log/i.test(taskText)) {
    addSignal(bucket, 'document.chat', 0.86, 'user task requests chat/verbatim reading')
  }
  if (/每一行|逐行|行列|金额|合计|总计|核对.*总|表格|工作表|spreadsheet|rows?|columns?|amount|total/i.test(taskText)) {
    addSignal(bucket, 'document.table', 0.94, 'user task targets table/spreadsheet data')
  }
  if (/报错|哪一行|代码|终端|traceback|stack trace|compiler|source code|error line/i.test(taskText)) {
    addSignal(bucket, 'document.code', 0.86, 'user task targets code/error evidence')
  }
  if (/按钮|开关|点哪里|在哪里|控件|设置|button|toggle|where.*click|ui/i.test(taskText)) {
    addSignal(bucket, 'ui', 0.82, 'user task targets UI controls/state')
  }

  const uiEntityCount = arr(baseline?.entities).filter((item) =>
    /^(button|input|icon|checkbox|toggle|menu|dialog|control)$/i.test(textOf(item?.type)),
  ).length
  if (uiEntityCount >= 2) addSignal(bucket, 'ui', Math.min(0.55, uiEntityCount * 0.12), `${uiEntityCount} UI entities`)

  const { scene, score, margin } = chooseScene(bucket.scores)
  const specialist = specialistFor(scene, baseline)
  const target = uncertaintyTarget(baseline)
  const hasUncertainty = target !== '' || arr(baseline?.visible_text).some((item) => item?.uncertain === true)
  const denseScene = scene === 'document.code' || scene === 'document.table' || scene === 'ui'
  const zoomRecommended = hasUncertainty || denseScene

  return {
    scene,
    confidence: confidenceOf(score, margin),
    primaryIntent: specialist.intent ?? SCENE_INTENTS[scene] ?? 'general',
    matchedSignals: bucket.signals[scene],
    zoom: {
      recommended: zoomRecommended,
      target: target || (denseScene ? 'the most information-dense task-relevant region' : ''),
      method: zoomRecommended ? 'ground_then_crop_if_needed' : 'none',
      tools: zoomRecommended ? ['vision_ground', 'vision_crop'] : [],
      reason: hasUncertainty
        ? 'The bootstrap reported uncertain evidence; localize and enlarge it before specialist reading.'
        : denseScene
          ? 'Dense code/table/UI regions often benefit from a focused crop before exact specialist reading.'
          : 'The baseline is not reporting a region that obviously needs enlargement.',
    },
    specialist,
    inferencePolicy:
      'Infer only after specialist evidence. Never guess exact text, coordinates, UI state, table values, or code that remains unreadable; if uncertainty still affects the answer, call another focused vision tool or state the uncertainty.',
  }
}

export function sceneRouteAgentInstruction(route) {
  if (!route || typeof route !== 'object') {
    return 'Structured baseline ready. Run at least one focused evidence tool before answering, then continue only as needed.'
  }
  const zoom = route.zoom?.recommended
    ? `Zoom first when it helps: ${route.zoom.method} targeting ${route.zoom.target || 'the uncertain/dense region'}. `
    : ''
  const specialist = route.specialist?.tool || 'vision_describe'
  const instruction = route.specialist?.instruction || 'Add task-relevant evidence.'
  return (
    `Post-bootstrap scene route: ${route.scene} (confidence ${route.confidence}); primary capability ${route.primaryIntent}. ` +
    zoom +
    `Required next evidence call: use ${specialist} (or an equivalent tool when the user's exact task requires it). ${instruction} ` +
    'After that, reason from evidence; if a material uncertainty remains, use another focused vision tool instead of guessing.'
  )
}
