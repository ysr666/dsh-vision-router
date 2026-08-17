from pathlib import Path
import json
import re

ROOT = Path('.')

def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected 1 match, got {count}')
    return text.replace(old, new, 1)

def replace_after(text, marker, old, new, label):
    pos = text.find(marker)
    if pos < 0:
        raise RuntimeError(f'{label}: marker not found')
    head, tail = text[:pos], text[pos:]
    count = tail.count(old)
    if count < 1:
        raise RuntimeError(f'{label}: target not found after marker')
    tail = tail.replace(old, new, 1)
    return head + tail

# ---------------------------------------------------------------------------
# structured-bootstrap: robust JSON extraction for fenced/prose-wrapped output
# ---------------------------------------------------------------------------
sp = ROOT / 'lib/structured-bootstrap.js'
s = sp.read_text()
insert_marker = "export function normalizeStructuredBootstrapResult(parsed, raw = '') {"
parser = r'''export function extractStructuredBootstrapJson(raw) {
  let text = String(raw ?? '').trim()
  if (text === '') return undefined
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  const accept = (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
    if (Array.isArray(value) && value.length === 1 && value[0] && typeof value[0] === 'object' && !Array.isArray(value[0])) return value[0]
    return undefined
  }
  try {
    const direct = accept(JSON.parse(text))
    if (direct !== undefined) return direct
  } catch {}

  // Find the first balanced JSON object while respecting quoted braces. This
  // tolerates a short prose preface/suffix without using the last '}' heuristic.
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            const parsed = accept(JSON.parse(text.slice(start, i + 1)))
            if (parsed !== undefined) return parsed
          } catch {}
          break
        }
      }
    }
  }
  return undefined
}

'''
if 'export function extractStructuredBootstrapJson' not in s:
    s = replace_once(s, insert_marker, parser + insert_marker, 'bootstrap parser insert')
sp.write_text(s)

# ---------------------------------------------------------------------------
# benchmark: fix SVG, grounding formats, semantic aliases, failed aggregation
# ---------------------------------------------------------------------------
bp = ROOT / 'lib/vision-capability-benchmark.js'
b = bp.read_text()
b = replace_once(
    b,
    '''function cjkText(x, y, value, size = 26, extra = '') {\n  return `<text x="${x}" y="${y}" lang="zh-CN" font-family="PingFang SC,Microsoft YaHei,Noto Sans CJK SC,Source Han Sans SC,sans-serif" font-size="${size}" fill="#111" ${extra}>${esc(value)}</text>`\n}''',
    '''function cjkText(x, y, value, size = 26, extra = '') {\n  const defaultFill = /\\bfill\\s*=/.test(extra) ? '' : ' fill="#111"'\n  return `<text x="${x}" y="${y}" lang="zh-CN" font-family="PingFang SC,Microsoft YaHei,Noto Sans CJK SC,Source Han Sans SC,sans-serif" font-size="${size}"${defaultFill} ${extra}>${esc(value)}</text>`\n}''',
    'cjk duplicate fill',
)
old_box = '''function boxIoU(actual, expected) {\n  if (!actual || !expected) return 0\n  const ax1 = Number(actual.x1), ay1 = Number(actual.y1), ax2 = Number(actual.x2), ay2 = Number(actual.y2)\n  const bx1 = Number(expected.x1), by1 = Number(expected.y1), bx2 = Number(expected.x2), by2 = Number(expected.y2)\n  if (![ax1, ay1, ax2, ay2, bx1, by1, bx2, by2].every(Number.isFinite)) return 0\n  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1))\n  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1))\n  const intersection = ix * iy\n  const areaA = Math.max(0, ax2 - ax1) * Math.max(0, ay2 - ay1)\n  const areaB = Math.max(0, bx2 - bx1) * Math.max(0, by2 - by1)\n  const union = areaA + areaB - intersection\n  return union > 0 ? intersection / union : 0\n}\n'''
new_box = '''function normalizeGroundingBox(value, width = WIDTH, height = HEIGHT) {\n  const parsed = typeof value === 'string' ? extractJson(value) : value\n  const item = Array.isArray(parsed) ? parsed[0] : parsed\n  if (!item || typeof item !== 'object') return undefined\n  let raw\n  if (item.box && typeof item.box === 'object') raw = [item.box.x1, item.box.y1, item.box.x2, item.box.y2]\n  else if ([item.x1, item.y1, item.x2, item.y2].every((x) => x !== undefined)) raw = [item.x1, item.y1, item.x2, item.y2]\n  else if (Array.isArray(item.bbox_2d) && item.bbox_2d.length >= 4) raw = item.bbox_2d.slice(0, 4)\n  if (!raw) return undefined\n  let values = raw.map(Number)\n  if (!values.every(Number.isFinite)) return undefined\n  const max = Math.max(...values.map(Math.abs))\n  if (max <= 1.0001) values = [values[0] * width, values[1] * height, values[2] * width, values[3] * height]\n  else if (max <= 1000.0001 && (values[2] > width || values[3] > height)) {\n    values = [values[0] * width / 1000, values[1] * height / 1000, values[2] * width / 1000, values[3] * height / 1000]\n  }\n  const [x1, y1, x2, y2] = values\n  return { x1, y1, x2, y2 }\n}\n\nfunction boxIoU(actual, expected) {\n  if (!actual || !expected) return 0\n  const ax1 = Number(actual.x1), ay1 = Number(actual.y1), ax2 = Number(actual.x2), ay2 = Number(actual.y2)\n  const bx1 = Number(expected.x1), by1 = Number(expected.y1), bx2 = Number(expected.x2), by2 = Number(expected.y2)\n  if (![ax1, ay1, ax2, ay2, bx1, by1, bx2, by2].every(Number.isFinite)) return 0\n  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1))\n  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1))\n  const intersection = ix * iy\n  const areaA = Math.max(0, ax2 - ax1) * Math.max(0, ay2 - ay1)\n  const areaB = Math.max(0, bx2 - bx1) * Math.max(0, by2 - by1)\n  const union = areaA + areaB - intersection\n  return union > 0 ? intersection / union : 0\n}\n\nfunction tokenCoverageWithAliases(value, tokens = []) {\n  const haystack = normalizeText(typeof value === 'string' ? value : JSON.stringify(value ?? ''))\n  const aliases = { '0': ['zero'], '1': ['one'], '2': ['two'], '3': ['three'], '4': ['four'], '5': ['five'], '6': ['six'], '7': ['seven'], '8': ['eight'], '9': ['nine'], '10': ['ten'] }\n  if (tokens.length === 0) return 1\n  let hits = 0\n  for (const token of tokens) {\n    const normalized = normalizeText(token)\n    if (haystack.includes(normalized) || (aliases[normalized] ?? []).some((alias) => haystack.includes(alias))) hits += 1\n  }\n  return hits / tokens.length\n}\n'''
b = replace_once(b, old_box, new_box, 'grounding normalization insert')
b = replace_once(
    b,
    '''  } else if (intent === 'grounding') {\n    const parsed = extractJson(output)\n    accuracy = boxIoU(parsed, fixture.expected.box)\n    details = { iou: accuracy, parsed }''',
    '''  } else if (intent === 'grounding') {\n    const parsed = extractJson(output)\n    const box = normalizeGroundingBox(parsed ?? output)\n    accuracy = boxIoU(box, fixture.expected.box)\n    details = { iou: accuracy, parsed, normalizedBox: box }''',
    'grounding scorer',
)
b = replace_once(
    b,
    '''  } else {\n    accuracy = tokenCoverage(output, fixture.expected.tokens)\n    details = { tokenCoverage: accuracy }\n  }''',
    '''  } else {\n    accuracy = tokenCoverageWithAliases(output, fixture.expected.tokens)\n    details = { tokenCoverage: accuracy }\n  }''',
    'semantic token aliases',
)
b = replace_once(
    b,
    '''  for (const result of results) {\n    if (!result || !VISION_INTENTS.includes(result.intent)) continue''',
    '''  let accepted = 0\n  for (const result of results) {\n    if (!result || result.ok === false || !VISION_INTENTS.includes(result.intent)) continue\n    accepted += 1''',
    'aggregate ignore failures',
)
b = replace_once(
    b,
    '''  return { scores: averaged, medianLatencyMs, fixtureCount: results.length }''',
    '''  return { scores: averaged, medianLatencyMs, fixtureCount: accepted, attemptedCount: results.length, failedCount: Math.max(0, results.length - accepted) }''',
    'aggregate counts',
)
bp.write_text(b)

# ---------------------------------------------------------------------------
# scene router: content/task beats application shell after bootstrap
# ---------------------------------------------------------------------------
scp = ROOT / 'lib/vision-scene-router.js'
scene = scp.read_text()
scene = replace_once(scene, 'export function routePostBootstrapScene(baseline = {}) {', 'export function routePostBootstrapScene(baseline = {}, options = {}) {', 'scene options')
scene = replace_once(scene, "  const corpus = corpusOf(baseline)\n", "  const corpus = corpusOf(baseline)\n  const taskText = textOf(options.taskText).toLowerCase()\n", 'scene task text')
scene = replace_once(scene, "  if (visualKind === 'ui') addSignal(bucket, 'ui', 1.05, 'bootstrap visual_kind=ui')", "  if (visualKind === 'ui') addSignal(bucket, 'ui', 0.72, 'bootstrap visual_kind=ui')", 'ui shell weight')
scene = replace_once(scene, "  if (visualKind === 'document') addSignal(bucket, 'document.table', 0.2, 'bootstrap visual_kind=document')", "  if (visualKind === 'document') addSignal(bucket, 'other', 0.24, 'bootstrap visual_kind=document')", 'document generic weight')
scene = replace_once(
    scene,
    "  if (matches(corpus, /\\b(table|spreadsheet|rows?|columns?|invoice|receipt|order summary|subtotal|total)\\b|表格|行列|发票|收据|合计|总计/iu)) {\n    addSignal(bucket, 'document.table', 0.78, 'table/document-grid semantics')\n  }",
    "  if (matches(corpus, /\\b(table|spreadsheet|worksheet|workbook|grid|rows?|columns?|invoice|receipt|order summary|subtotal|total)\\b|表格|电子表格|工作表|行列|发票|收据|合计|总计/iu)) {\n    addSignal(bucket, 'document.table', 1.12, 'table/spreadsheet content semantics')\n  }",
    'table content weight',
)
scene_insert = r'''
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
'''
scene = replace_once(scene, "\n  const uiEntityCount = arr(baseline?.entities).filter", scene_insert + "\n  const uiEntityCount = arr(baseline?.entities).filter", 'scene task signals')
scp.write_text(scene)

# ---------------------------------------------------------------------------
# index.js: imports, HTTP response shapes, exact benchmark, state-by-id,
# task-aware scene routing, evidence budget, terminal failures, vision-first OCR
# ---------------------------------------------------------------------------
ip = ROOT / 'index.js'
idx = ip.read_text()
idx = replace_once(
    idx,
    "  structuredBootstrapMemory,\n  structuredBootstrapQuestion,\n} from './lib/structured-bootstrap.js'",
    "  structuredBootstrapMemory,\n  structuredBootstrapQuestion,\n  extractStructuredBootstrapJson,\n} from './lib/structured-bootstrap.js'\nimport {\n  CORE_BENCHMARK_INTENTS,\n  aggregateCapabilityBenchmark,\n  capabilityBenchmarkFingerprint,\n  listCapabilityBenchmarkFixtures,\n  scoreCapabilityBenchmarkResult,\n} from './lib/vision-capability-benchmark.js'\nimport { routePostBootstrapScene, sceneRouteAgentInstruction } from './lib/vision-scene-router.js'",
    'index imports',
)

# OpenAI-compatible response shapes: string, content blocks, legacy choice.text.
openai_marker = 'export async function callOpenAICompatible(provider, messages, options = {}) {'
openai_helper = r'''export function openAICompatibleResponseText(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : undefined
  const content = choice && choice.message ? choice.message.content : undefined
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const text = content
      .map((part) => part && typeof part.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('')
      .trim()
    if (text !== '') return text
  }
  if (choice && typeof choice.text === 'string') return choice.text.trim()
  return undefined
}

'''
if 'export function openAICompatibleResponseText' not in idx:
    idx = replace_once(idx, openai_marker, openai_helper + openai_marker, 'openai response helper')
idx = replace_once(
    idx,
    "  const data = await response.json()\n  const content = data && data.choices && data.choices[0] && data.choices[0].message\n    ? data.choices[0].message.content\n    : undefined\n  if (typeof content !== 'string') throw new Error(`http provider \"${provider.name}\": unexpected response shape`)\n  return content.trim()",
    "  const data = await response.json()\n  const content = openAICompatibleResponseText(data)\n  if (content === undefined) throw new Error(`http provider \"${provider.name}\": unexpected response shape`)\n  return content",
    'openai response parse',
)

# Structured state survives host Session object churn by secondary session-id key.
state_decl = '  const structuredBootstrapTurnState = new WeakMap()'
state_helpers = '''  const structuredBootstrapTurnState = new WeakMap()\n  const structuredBootstrapTurnStateById = new Map()\n  const structuredBootstrapStateGet = (session) => {\n    if (!session) return undefined\n    const direct = structuredBootstrapTurnState.get(session)\n    if (direct !== undefined) return direct\n    return session.id !== undefined ? structuredBootstrapTurnStateById.get(String(session.id)) : undefined\n  }\n  const structuredBootstrapStateSet = (session, state) => {\n    if (!session) return state\n    structuredBootstrapTurnState.set(session, state)\n    if (session.id !== undefined) structuredBootstrapTurnStateById.set(String(session.id), state)\n    return state\n  }'''
idx = replace_once(idx, state_decl, state_helpers, 'structured state helpers')
idx = idx.replace('structuredBootstrapTurnState.get(session)', 'structuredBootstrapStateGet(session)')
idx = idx.replace('structuredBootstrapTurnState.set(session, bootstrapState)', 'structuredBootstrapStateSet(session, bootstrapState)')

# Turn state: capture original user task AFTER pass-1 boundary and initialize budgets/reminder guards.
old_state = "      bootstrapState = { turn: payload.turn, required: bootstrapRequired, completed: false, followupCompleted: false, failed: false }"
new_state = "      bootstrapState = { turn: payload.turn, required: bootstrapRequired, completed: false, followupCompleted: false, failed: false, taskText: lastUserText(rawMessages), evidenceCalls: 0, maxEvidenceCalls: 4, visualTerminal: false, bootstrapReminderSent: false, followupReminderSent: false, terminalReminderSent: false }"
idx = replace_once(idx, old_state, new_state, 'bootstrap state init')
idx = replace_once(idx, "    } else if (bootstrapRequired) {\n      bootstrapState.required = true\n    }", "    } else if (bootstrapRequired) {\n      bootstrapState.required = true\n      if (!bootstrapState.taskText) bootstrapState.taskText = lastUserText(rawMessages)\n    }", 'bootstrap state refresh')

# Only one persisted reminder per phase; no Date.now ids.
idx = replace_once(idx, "if (bootstrapState.required && bootstrapState.completed !== true && bootstrapState.failed !== true) {", "if (bootstrapState.required && bootstrapState.completed !== true && bootstrapState.failed !== true && bootstrapState.bootstrapReminderSent !== true) {", 'bootstrap reminder guard')
idx = replace_after(idx, 'if (bootstrapState.required && bootstrapState.completed !== true', '      bootstrapReminder = {', '      bootstrapState.bootstrapReminderSent = true\n      bootstrapReminder = {', 'bootstrap reminder sent')
idx = idx.replace('id: `vision-router-structured-bootstrap-${payload.turn}-${Date.now()}`', 'id: `vision-router-structured-bootstrap-${payload.turn}`')
idx = replace_once(idx, "      bootstrapState.failed !== true\n    ) {", "      bootstrapState.failed !== true &&\n      bootstrapState.visualTerminal !== true &&\n      bootstrapState.followupReminderSent !== true\n    ) {", 'followup reminder guard')
idx = replace_after(idx, 'bootstrapState.followupCompleted !== true', '      bootstrapReminder = {', '      bootstrapState.followupReminderSent = true\n      bootstrapReminder = {', 'followup reminder sent')
idx = idx.replace('id: `vision-router-structured-followup-${payload.turn}-${Date.now()}`', 'id: `vision-router-structured-followup-${payload.turn}`')
idx = idx.replace("'完成后才进入自由 Agent 循环，可继续调用更多工具或作答。',", "'完成后原则上直接作答；只有新增证据确实会改变答案时再继续。默认总证据预算为 4 次，代码/表格密集场景最多 6 次，禁止无上限反复放大/改问法。',")

# Add a terminal/budget reminder once when the visual loop has ended.
terminal_insert = r'''
    if (
      bootstrapState.required &&
      bootstrapState.completed === true &&
      (bootstrapState.visualTerminal === true || bootstrapState.evidenceCalls >= bootstrapState.maxEvidenceCalls) &&
      bootstrapState.terminalReminderSent !== true
    ) {
      bootstrapState.terminalReminderSent = true
      const reason = bootstrapState.visualTerminal === true
        ? '视觉后端已进入本轮终止状态（认证/限流/超时/后端不可用），不得继续改问法重复视觉调用。'
        : `本轮结构化视觉证据预算已用完（${bootstrapState.evidenceCalls}/${bootstrapState.maxEvidenceCalls}），不得继续视觉深挖。`
      bootstrapReminder = {
        role: 'user',
        id: `vision-router-structured-terminal-${payload.turn}`,
        content: [{
          type: 'text',
          text: reason + '请基于已有证据回答；如果精确文字、数字、坐标、UI 状态或表格值仍未被一致验证，必须明确写“不确定/无法确认”，不得使用“准确、确定、就是”等措辞把推测包装成事实。',
        }],
        source: { kind: 'plugin', plugin: 'dsh-vision-router' },
      }
    }
'''
idx = replace_once(idx, "    if (hasImage) {\n      // ── dsh-vision 并入：pre-step 即时本地翻译", terminal_insert + "\n    if (hasImage) {\n      // ── dsh-vision 并入：pre-step 即时本地翻译", 'terminal reminder')

# Bootstrap parser + post-bootstrap task-aware scene route.
idx = replace_after(idx, "name: 'vision_bootstrap'", '        const parsed = extractJson(raw)', '        const parsed = extractStructuredBootstrapJson(raw)', 'bootstrap parser use')
idx = replace_after(idx, "name: 'vision_bootstrap'", '        const sceneRoute = routePostBootstrapScene(evidence)', '        const sceneRoute = routePostBootstrapScene(evidence, { taskText: bootstrapState?.taskText })', 'task-aware scene route') if 'const sceneRoute = routePostBootstrapScene(evidence)' in idx[idx.find("name: 'vision_bootstrap'"):] else idx
# Current main has no scene route yet: insert it after evidence normalization.
if 'const sceneRoute = routePostBootstrapScene(evidence' not in idx[idx.find("name: 'vision_bootstrap'"):]:
    idx = replace_after(
        idx,
        "name: 'vision_bootstrap'",
        '        const evidence = normalizeStructuredBootstrapResult(parsed, raw)\n        const memory = structuredBootstrapMemory(evidence)',
        "        const evidence = normalizeStructuredBootstrapResult(parsed, raw)\n        const sceneRoute = routePostBootstrapScene(evidence, { taskText: bootstrapState?.taskText })\n        if (bootstrapState) {\n          bootstrapState.sceneRoute = sceneRoute\n          bootstrapState.maxEvidenceCalls = sceneRoute.scene === 'document.code' || sceneRoute.scene === 'document.table' ? 6 : 4\n        }\n        const memory = structuredBootstrapMemory(evidence)",
        'scene route insert',
    )
idx = replace_after(
    idx,
    "name: 'vision_bootstrap'",
    "          evidence,\n          next:\n            'Structured baseline ready. REQUIRED next step: choose at least one task-directed tool from recommended_followups (or another evidence tool) and call it before answering. After that, continue with more tools only as needed.',",
    "          evidence,\n          scene_route: sceneRoute,\n          next: sceneRouteAgentInstruction(sceneRoute),",
    'bootstrap next scene instruction',
)

# Exact benchmark runner after the single-backend dispatch helper.
bench_marker = '  // ── vision chain route: fallback under our own control ─────────────────────'
bench_code = r'''
  // ── v2 exact-endpoint capability benchmark ────────────────────────────────
  // Only explicitly configured backends are benchmark candidates. Auto-discovered
  // catalog models are intentionally excluded so an error cannot dump hundreds
  // of irrelevant models into the conversation.
  const capabilityBenchmarkMemory = new Map()
  const capabilityBenchmarkDir = () =>
    path.resolve(process.cwd(), String(current().artifactsDir || '.dsh-vision-router/artifacts'), 'capability-benchmarks')
  const benchmarkCandidateForPair = (pair) => ({ kind: 'adapter', key: `${pair.provider}/${pair.model}`, provider: pair.provider, model: pair.model, pair })
  const benchmarkCandidateForHttp = (provider) => ({ kind: 'http', key: `http:${provider.name}/${provider.model}`, provider: `http:${provider.name}`, model: provider.model, http: provider })
  const exactBenchmarkCandidates = async () => {
    const out = []
    const seen = new Set()
    for (const pair of pairs()) {
      if (!pair || pair.provider === HTTP_ROUTE || !adapterAvailable(ctx.llm, pair.provider)) continue
      const capability = await resolveVisionBackendCapability(pair.provider, pair.model)
      if (capability.attemptable === false) continue
      const candidate = benchmarkCandidateForPair(pair)
      if (!seen.has(candidate.key)) { seen.add(candidate.key); out.push(candidate) }
    }
    for (const provider of httpProviders()) {
      const candidate = benchmarkCandidateForHttp(provider)
      if (!seen.has(candidate.key)) { seen.add(candidate.key); out.push(candidate) }
    }
    return out
  }
  const resolveBenchmarkCandidate = (candidates, requested) => {
    const raw = String(requested ?? '').trim()
    if (raw === '') return candidates[0]
    const exact = candidates.find((item) => item.key === raw)
    if (exact) return exact
    const visionHttpModel = raw.startsWith('vision-http/') ? raw.slice('vision-http/'.length) : undefined
    if (visionHttpModel) {
      const matches = candidates.filter((item) => item.kind === 'http' && item.model === visionHttpModel)
      if (matches.length === 1) return matches[0]
    }
    const byModel = candidates.filter((item) => item.model === raw || item.key.endsWith(`/${raw}`))
    return byModel.length === 1 ? byModel[0] : undefined
  }
  const capabilityBenchmarkIdentity = async (candidate) => {
    let endpoint = ''
    const config = { kind: candidate.kind }
    if (candidate.kind === 'http') {
      endpoint = String(candidate.http?.baseURL ?? '')
      config.providerName = candidate.http?.name
      config.maxTokens = candidate.http?.maxTokens
    } else {
      const correction = await routingCorrectionForPair(candidate.pair)
      const catalog = resolvedCatalogFactsOf(candidate.pair.provider, candidate.pair.model)
      const bridge = channelBridgePlan(candidate.pair.provider, candidate.pair.model)
      endpoint = String(correction?.baseURL ?? catalog?.baseUrl ?? bridge?.transport?.baseURL ?? '')
      config.api = String(correction?.api ?? catalog?.api ?? bridge?.transport?.api ?? '')
      config.bridgeAvailable = bridge?.ok === true
    }
    const fingerprint = capabilityBenchmarkFingerprint({ provider: candidate.provider, model: candidate.model, endpoint, config })
    return { fingerprint, endpoint }
  }
  const persistCapabilityBenchmark = async (record) => {
    const dir = capabilityBenchmarkDir()
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `${record.fingerprint}.json`)
    await writeFile(file, JSON.stringify(record, null, 2))
    capabilityBenchmarkMemory.set(record.fingerprint, record)
    return file
  }
  const benchmarkImageBlock = async (bytes) => {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new Error('vision capability benchmark: attachment service is not available')
    const ref = await attachments.saveImage({ data: bytes, mediaType: 'image/png' })
    return { type: 'image', attachment: ref }
  }
  const runExactCapabilityBenchmark = async ({ backend, intents }) => {
    const candidates = await exactBenchmarkCandidates()
    const candidate = resolveBenchmarkCandidate(candidates, backend)
    if (!candidate) {
      return {
        ok: false,
        code: 'CAPABILITY_BENCHMARK_BACKEND_NOT_FOUND',
        backend: String(backend ?? ''),
        availableCount: candidates.length,
        suggestions: candidates.slice(0, 8).map((item) => item.key),
        advice: 'Omit backend to benchmark the first configured vision backend, or use one of the short suggestions.',
      }
    }
    const selectedIntents = Array.isArray(intents) && intents.length > 0
      ? [...new Set(intents.filter((intent) => CORE_BENCHMARK_INTENTS.includes(intent)))]
      : [...CORE_BENCHMARK_INTENTS]
    if (selectedIntents.length === 0) return { ok: false, code: 'CAPABILITY_BENCHMARK_NO_VALID_INTENTS', backend: candidate.key }
    const fixtures = listCapabilityBenchmarkFixtures(selectedIntents)
    const sharp = await loadSharp()
    const results = []
    const healthFailures = []
    const deadline = createDeadline(Math.max(visionTaskTimeoutMs(), fixtures.length * 15000))
    for (const fixture of fixtures) {
      if (deadline.expired()) {
        healthFailures.push({ fixture: fixture.id, intent: fixture.intent, failure: 'TIMEOUT', error: 'benchmark deadline exhausted' })
        break
      }
      let imageBytes
      try {
        imageBytes = await sharp(Buffer.from(fixture.svg)).png().toBuffer()
      } catch (error) {
        return { ok: false, code: 'CAPABILITY_BENCHMARK_FIXTURE_INVALID', fixture: fixture.id, error: error instanceof Error ? error.message : String(error) }
      }
      const block = await benchmarkImageBlock(imageBytes)
      const signal = combineSignals(deadline.signal(), AbortSignal.timeout(Math.max(1, Math.min(timeoutMs(), deadline.remaining()))))
      const startedAt = Date.now()
      try {
        let output
        if (candidate.kind === 'http') {
          const openAIBlock = toOpenAIContent([block], () => imageBytes)[0]
          const messages = appendPromptToImageOnlyMessage([{ role: 'user', content: [openAIBlock] }], fixture.prompt).messages
          output = await callOpenAICompatible(candidate.http, messages, { maxTokens: candidate.http.maxTokens ?? 2048, signal, resolveCredential })
        } else {
          const capability = await resolveVisionBackendCapability(candidate.pair.provider, candidate.pair.model)
          output = await callVisionPairWithOptionalBridge(candidate.pair, [{ role: 'user', content: [block, { type: 'text', text: fixture.prompt }], source: { kind: 'plugin', plugin: 'dsh-vision-router' } }], {
            maxTokens: 2048, signal, capability, bridgeBlocks: [block], bridgeInstruction: fixture.prompt,
          })
        }
        results.push({ ...scoreCapabilityBenchmarkResult(fixture, output, Date.now() - startedAt), ok: true, output: String(output ?? '').slice(0, 4000) })
      } catch (error) {
        const classification = classifyVisionFailure(error)
        healthFailures.push({
          fixture: fixture.id,
          intent: fixture.intent,
          failure: classification.kind ?? 'OTHER',
          latencyMs: Date.now() - startedAt,
          retryAfterMs: Number.isFinite(Number(error?.providerRetryAfterMs)) ? Number(error.providerRetryAfterMs) : undefined,
          error: error instanceof Error ? error.message : String(error),
        })
        // Infrastructure health is not capability. Stop immediately rather than
        // persisting zeroes or busy-looping through more fixtures on 429/auth/outage.
        break
      }
    }
    const aggregate = aggregateCapabilityBenchmark(results)
    if (results.length === 0) {
      const failure = healthFailures[0]
      return {
        ok: false,
        code: `CAPABILITY_BENCHMARK_${String(failure?.failure ?? 'UNAVAILABLE').toUpperCase()}`,
        backend: candidate.key,
        retryable: false,
        healthFailures,
        advice: 'No capability score was saved because the exact backend did not produce a successful fixture. Do not retry in a tight loop.',
      }
    }
    const identity = await capabilityBenchmarkIdentity(candidate)
    const record = {
      version: 3,
      backend: candidate.key,
      backendKind: candidate.kind,
      fingerprint: identity.fingerprint,
      endpoint: identity.endpoint,
      measuredAt: new Date().toISOString(),
      intents: selectedIntents,
      aggregate,
      results,
      healthFailures,
      partial: healthFailures.length > 0 || results.length < fixtures.length,
    }
    record.file = await persistCapabilityBenchmark(record)
    return { ok: true, ...record }
  }

'''
if 'const runExactCapabilityBenchmark = async' not in idx:
    idx = replace_once(idx, bench_marker, bench_code + bench_marker, 'exact benchmark runner')

# Register benchmark tool before bootstrap. Backend is optional and defaults to current first configured backend.
benchmark_tool = r'''    deepToolDefs.push({
      name: 'vision_capability_benchmark',
      description:
        'Developer v2 exact-endpoint self-benchmark. Runs privacy-safe generated fixtures against ONE exact configured vision backend with NO model fallback. Infrastructure failures (429/auth/timeout/outage) are health failures, never capability score zero. Use only when the user explicitly asks to test model capabilities.',
      parameters: {
        type: 'object',
        properties: {
          backend: { type: 'string', description: 'Optional exact backend key. Omit to use the first configured vision backend. vision-http/<model> is accepted as an alias for the matching built-in HTTP backend.' },
          intents: { type: 'array', items: { type: 'string', enum: CORE_BENCHMARK_INTENTS }, description: 'Optional subset. Defaults to structured, ocr, grounding, document, general.' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) {
        return JSON.stringify(await runExactCapabilityBenchmark({ backend: args.backend, intents: args.intents }))
      },
    })

'''
idx = replace_once(idx, "    // Universal structured first pass for the optional 1+x flow.", benchmark_tool + "    // Universal structured first pass for the optional 1+x flow.", 'benchmark tool register')

# Evidence budget + terminal failure semantics in the deep-tool wrapper.
idx = replace_once(
    idx,
    "    const structuredFollowupEvidenceTools = new Set([\n      'vision_describe',\n      'vision_ground',\n      'vision_detect',\n      'vision_ocr',\n      'vision_colors',\n      'vision_pixel_diff',\n      'vision_long_screenshot_ocr',\n    ])",
    "    const structuredFollowupEvidenceTools = new Set([\n      'vision_describe', 'vision_ground', 'vision_detect', 'vision_ocr', 'vision_colors', 'vision_pixel_diff', 'vision_long_screenshot_ocr',\n    ])\n    const structuredBudgetTools = new Set([...structuredFollowupEvidenceTools, 'vision_crop'])\n    const structuredNetworkTools = new Set(['vision_describe', 'vision_ground', 'vision_detect', 'vision_ocr', 'vision_long_screenshot_ocr'])\n    const terminalVisionCodes = new Set([\n      VISION_RESULT_CODES.AUTH_FAILED, VISION_RESULT_CODES.RATE_LIMITED, VISION_RESULT_CODES.TIMEOUT,\n      VISION_RESULT_CODES.BACKEND_UNAVAILABLE, VISION_RESULT_CODES.BACKEND_UNAVAILABLE_THIS_TURN,\n    ])\n    const parsedToolResult = (value) => {\n      if (typeof value !== 'string') return value && typeof value === 'object' ? value : undefined\n      try { return JSON.parse(value) } catch { return undefined }\n    }",
    'evidence budget sets',
)
wrapper_marker = "                async execute(args, exec) {\n                  const session = exec && exec.agent && exec.agent.session\n                  const state = session ? structuredBootstrapStateGet(session) : undefined"
wrapper_replace = wrapper_marker + r'''
                  if (
                    structuredBootstrapEnabled() && state && state.required && state.completed === true &&
                    state.visualTerminal === true && structuredNetworkTools.has(def.name)
                  ) {
                    return JSON.stringify({ ok: false, code: 'STRUCTURED_VISUAL_TERMINAL', retryable: false, reason: 'visual backend is terminal for this turn; answer from existing evidence instead of retrying' })
                  }
                  if (
                    structuredBootstrapEnabled() && state && state.required && state.completed === true &&
                    structuredBudgetTools.has(def.name) && Number(state.evidenceCalls ?? 0) >= Number(state.maxEvidenceCalls ?? 4)
                  ) {
                    state.followupCompleted = true
                    return JSON.stringify({ ok: false, code: 'STRUCTURED_EVIDENCE_BUDGET_EXHAUSTED', retryable: false, used: state.evidenceCalls, limit: state.maxEvidenceCalls, reason: 'structured vision evidence budget exhausted; answer now or explicitly state uncertainty' })
                  }'''
idx = replace_once(idx, wrapper_marker, wrapper_replace, 'wrapper budget precheck')
idx = replace_once(
    idx,
    "                    effectiveArgs = { ...(args ?? {}), engine: 'vision' }",
    "                    effectiveArgs = { ...(args ?? {}), engine: 'vision-first' }",
    'structured OCR vision-first',
)
old_post = '''                  const result = await def.execute(effectiveArgs, exec)\n                  if (\n                    structuredBootstrapEnabled() &&\n                    state &&\n                    state.required &&\n                    state.completed === true &&\n                    state.failed !== true &&\n                    structuredFollowupEvidenceTools.has(def.name)\n                  ) {\n                    state.followupCompleted = true\n                  }\n                  return result'''
new_post = '''                  const result = await def.execute(effectiveArgs, exec)\n                  if (structuredBootstrapEnabled() && state && state.required && state.completed === true && state.failed !== true) {\n                    if (structuredBudgetTools.has(def.name)) state.evidenceCalls = Number(state.evidenceCalls ?? 0) + 1\n                    const parsedResult = parsedToolResult(result)\n                    const terminal = parsedResult && parsedResult.ok === false && terminalVisionCodes.has(parsedResult.code)\n                    if (terminal) {\n                      state.visualTerminal = true\n                      state.followupCompleted = true\n                    } else if (structuredFollowupEvidenceTools.has(def.name)) {\n                      state.followupCompleted = true\n                    }\n                  }\n                  return result'''
idx = replace_once(idx, old_post, new_post, 'wrapper result state')

# Replace OCR tool definition with accuracy-first mode that degrades to local OCR on backend outage.
ocr_start = idx.find("    deepToolDefs.push({\n      name: 'vision_ocr'")
ocr_end = idx.find("    deepToolDefs.push({\n      name: 'vision_long_screenshot_ocr'", ocr_start)
if ocr_start < 0 or ocr_end < 0:
    raise RuntimeError('OCR tool segment not found')
new_ocr = r'''    deepToolDefs.push({
      name: 'vision_ocr',
      description:
        'Transcribe TEXT from an image. auto = local Tesseract first then vision fallback; vision-first = vision model first for accuracy, then local Tesseract only as a degraded fallback when the vision backend is unavailable; tesseract/vision force one engine. Returns text and engine metadata. OCR is not a generic retry for object/scene recognition.',
      parameters: {
        type: 'object',
        properties: {
          image: { type: 'string', description: 'Local image path or uploaded attachment id (sha256:...)' },
          engine: { type: 'string', description: 'auto (default), vision-first, tesseract, or vision' },
        },
        required: ['image'],
        additionalProperties: false,
      },
      output: stringOutput,
      async execute(args, exec) {
        const { bytes, mediaType } = await readImageBytes(exec, args.image)
        const engine = ['tesseract', 'vision', 'vision-first'].includes(args.engine) ? args.engine : 'auto'
        const deadline = createDeadline(ocrBudgetMs())
        const runLocal = async () => {
          if (deadline.expired()) return ''
          return (await ocrWithTesseract(bytes, Math.min(12000, deadline.remaining()))).trim()
        }
        if (engine === 'auto' || engine === 'tesseract') {
          try {
            const text = await runLocal()
            if (text !== '' || engine === 'tesseract') return JSON.stringify({ engine: 'tesseract', text })
          } catch (error) {
            if (engine === 'tesseract') throw new Error(`vision_ocr: local tesseract failed (${error && error.message ? error.message : String(error)})`)
            ctx.logger?.warn('vision-router: tesseract OCR unavailable, falling back to vision model')
          }
        }
        if (deadline.expired()) return JSON.stringify({ engine: 'none', ok: false, code: VISION_RESULT_CODES.TIMEOUT, retryable: false, text: '', reason: 'vision_ocr: OCR budget exhausted' })
        const vision = await answerVisionForTool(exec, bytes, mediaType, '请原样转述图中的所有文字，保持阅读顺序（从上到下、从左到右）与段落结构，不要添加解释。只输出文字本身。', { deadline })
        if (vision.ok !== false) return JSON.stringify({ engine: 'vision', text: vision.text })
        if (engine === 'vision-first') {
          try {
            const text = await runLocal()
            if (text !== '') return JSON.stringify({ engine: 'tesseract', degradedFromVision: true, visionFailure: { code: vision.code, reason: vision.reason }, text })
          } catch (error) {
            return JSON.stringify({ engine: 'none', ...vision, localFallbackError: error && error.message ? error.message : String(error), text: '' })
          }
        }
        return JSON.stringify({ engine: 'none', ...vision, text: '' })
      },
    })

'''
idx = idx[:ocr_start] + new_ocr + idx[ocr_end:]

# Long screenshot OCR accepts bootstrap-style attachmentIds alias.
long_marker = "      name: 'vision_long_screenshot_ocr'"
idx = replace_after(idx, long_marker, "          image: { type: 'string', description: 'Local image path (png/jpeg/webp/gif), workspace-relative or absolute; or the attachment id (e.g. \"sha256:...\") of an image uploaded in this conversation' },", "          image: { type: 'string', description: 'Local image path or uploaded attachment id (sha256:...)' },\n          attachmentIds: { type: 'array', items: { type: 'string' }, description: 'Compatibility alias: first uploaded attachment id is used when image is omitted' },", 'long OCR attachmentIds schema')
idx = replace_after(idx, long_marker, "        required: ['image'],", "        required: [],", 'long OCR optional image schema')
idx = replace_after(idx, long_marker, "        const { bytes, mediaType } = await readImageBytes(exec, args.image)", "        const imageInput = typeof args.image === 'string' && args.image.trim() !== ''\n          ? args.image.trim()\n          : Array.isArray(args.attachmentIds) && typeof args.attachmentIds[0] === 'string'\n            ? args.attachmentIds[0].trim()\n            : ''\n        if (imageInput === '') throw new Error('vision_long_screenshot_ocr: provide image or attachmentIds[0]')\n        const { bytes, mediaType } = await readImageBytes(exec, imageInput)", 'long OCR input alias')
# Within this tool segment, use the resolved source for artifacts/manifest.
seg_start = idx.find(long_marker)
seg_end = idx.find("    deepToolDefs.push({", seg_start + len(long_marker))
segment = idx[seg_start:seg_end]
segment = segment.replace("artifactStem(args.image, 'ocr')", "artifactStem(imageInput, 'ocr')")
segment = segment.replace('source: args.image,', 'source: imageInput,')
idx = idx[:seg_start] + segment + idx[seg_end:]

ip.write_text(idx)

# ---------------------------------------------------------------------------
# tests
# ---------------------------------------------------------------------------
tp = ROOT / 'tests/session-hardening.test.js'
tp.write_text(r'''import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { extractStructuredBootstrapJson } from '../lib/structured-bootstrap.js'
import { openAICompatibleResponseText } from '../index.js'

test('bootstrap JSON parser accepts fenced and prose-wrapped objects', () => {
  const fenced = extractStructuredBootstrapJson('```json\n{"visual_kind":"chat","overview":"x { y }"}\n```')
  assert.equal(fenced.visual_kind, 'chat')
  const prose = extractStructuredBootstrapJson('Here is the result:\n{"visual_kind":"ui","regions":[]}\nDone.')
  assert.equal(prose.visual_kind, 'ui')
})

test('OpenAI-compatible response parser accepts content arrays but never reasoning-only payloads', () => {
  assert.equal(openAICompatibleResponseText({ choices: [{ message: { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] } }] }), 'hello world')
  assert.equal(openAICompatibleResponseText({ choices: [{ text: 'legacy' }] }), 'legacy')
  assert.equal(openAICompatibleResponseText({ choices: [{ message: { content: null, reasoning: 'private reasoning' } }] }), undefined)
})

test('runtime hardening keeps structured state by session id and caps evidence calls', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /structuredBootstrapTurnStateById/)
  assert.match(source, /STRUCTURED_EVIDENCE_BUDGET_EXHAUSTED/)
  assert.match(source, /engine: 'vision-first'/)
  assert.match(source, /STRUCTURED_VISUAL_TERMINAL/)
  assert.doesNotMatch(source, /vision-router-structured-followup-\$\{payload\.turn\}-\$\{Date\.now\(\)\}/)
})

test('long screenshot OCR accepts attachmentIds compatibility alias', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const start = source.indexOf("name: 'vision_long_screenshot_ocr'")
  const end = source.indexOf("deepToolDefs.push", start + 30)
  const segment = source.slice(start, end)
  assert.match(segment, /attachmentIds/)
  assert.match(segment, /imageInput/)
})
''')

# Extend old benchmark tests with regression cases and update aggregate expectation.
btest = ROOT / 'tests/vision-capability-benchmark.test.js'
t = btest.read_text()
t = t.replace("  assert.equal(aggregate.fixtureCount, 3)\n", "  assert.equal(aggregate.fixtureCount, 3)\n  assert.equal(aggregate.attemptedCount, 3)\n")
t += r'''

test('grounding scorer accepts Qwen bbox_2d on a 0..1000 coordinate scale', () => {
  const fixture = capabilityBenchmarkFixture('grounding')
  const output = JSON.stringify([{ bbox_2d: [672, 672, 901, 813], label: 'SAVE' }])
  const scored = scoreCapabilityBenchmarkResult(fixture, output, 300)
  assert.ok(scored.score > 0.85)
})

test('general scorer treats trivial number words as semantic aliases', () => {
  const fixture = capabilityBenchmarkFixture('general')
  const scored = scoreCapabilityBenchmarkResult(fixture, 'There are three large shapes: circle, square, triangle.', 300)
  assert.equal(scored.score, 1)
})

test('aggregate excludes infrastructure failures from capability scores', () => {
  const aggregate = aggregateCapabilityBenchmark([
    { intent: 'ocr', score: 0.9, ok: true, latencyMs: 400 },
    { intent: 'ocr', score: 0, ok: false, failure: 'RATE_LIMIT', latencyMs: 20 },
  ])
  assert.equal(aggregate.scores.ocr, 0.9)
  assert.equal(aggregate.fixtureCount, 1)
  assert.equal(aggregate.failedCount, 1)
})
'''
btest.write_text(t)

stest = ROOT / 'tests/vision-scene-router.test.js'
t = stest.read_text()
t += r'''

test('spreadsheet content beats an outer application UI shell', () => {
  const route = routePostBootstrapScene({
    visual_kind: 'ui',
    overview: 'WPS spreadsheet application',
    regions: [{ id: 'r1', role: 'spreadsheet grid', content: 'table rows columns Amount Total' }],
    entities: [{ id: 'e1', type: 'button', label: 'Save' }],
  }, { taskText: '把每一行项目和金额整理出来，并核对总计是否正确' })
  assert.equal(route.scene, 'document.table')
  assert.equal(route.primaryIntent, 'document')
})
'''
stest.write_text(t)

# package.json: preserve current main suite and append the new tests.
pkgp = ROOT / 'package.json'
pkg = json.loads(pkgp.read_text())
script = pkg['scripts']['test']
for name in ['tests/vision-capability-router.test.js', 'tests/vision-capability-benchmark.test.js', 'tests/vision-scene-router.test.js', 'tests/session-hardening.test.js']:
    if name not in script:
        script += ' ' + name
pkg['scripts']['test'] = script
pkgp.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + '\n')
