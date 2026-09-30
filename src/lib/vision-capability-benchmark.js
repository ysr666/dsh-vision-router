import { createHash } from 'node:crypto'
import process from 'node:process'
import { VISION_INTENTS } from './vision-capability-router.js'

const WIDTH = 768
const HEIGHT = 512

export const CAPABILITY_BENCHMARK_SUITE_REVISION = 5
// Renderer-only fixes must invalidate prior evidence even when the scoring and
// prompt contract (the suite revision) is unchanged.
export const CAPABILITY_BENCHMARK_RENDERER_SCOPE = `${process.platform}/${process.arch}-proof-badge-v2`

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch])
}

function svgDoc(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><rect width="100%" height="100%" fill="#fff"/>${body}</svg>`
}

function textAttrs(extra = '') {
  const attrs = String(extra ?? '').trim()
  const defaultFill = /(?:^|\s)fill\s*=/i.test(attrs) ? '' : ' fill="#111"'
  return `${defaultFill}${attrs ? ` ${attrs}` : ''}`
}

function text(x, y, value, size = 28, extra = '') {
  return `<text x="${x}" y="${y}" font-family="Arial,Helvetica,sans-serif" font-size="${size}"${textAttrs(extra)}>${esc(value)}</text>`
}

function cjkText(x, y, value, size = 26, extra = '') {
  return `<text x="${x}" y="${y}" lang="zh-CN" font-family="Noto Sans CJK SC,Source Han Sans SC,PingFang SC,Microsoft YaHei,sans-serif" font-size="${size}"${textAttrs(extra)}>${esc(value)}</text>`
}

const OCR_ZH_CHAT_FIXTURE = Object.freeze({
  id: 'ocr-zh-chat-v2',
  intent: 'ocr',
  svg: svgDoc([
    `<rect x="24" y="20" width="720" height="56" rx="14" fill="#eef2f7"/>`,
    cjkText(48, 57, '项目讨论', 26, 'font-weight="700"'),
    cjkText(42, 116, '小林 10:24', 20, 'fill="#667085"'),
    `<rect x="42" y="132" width="618" height="62" rx="14" fill="#f4f6f8"/>`,
    cjkText(62, 171, 'OCR 模式选好后，第一次结构化识别还会跑吗？', 24),
    cjkText(42, 234, '阿哲 10:25', 20, 'fill="#667085"'),
    `<rect x="42" y="250" width="642" height="62" rx="14" fill="#eaf4ff"/>`,
    cjkText(62, 289, '会。模式选择不算识别，先跑一次结构化。', 24),
    `<rect x="62" y="332" width="370" height="48" rx="8" fill="#f2f4f7"/>`,
    cjkText(78, 364, '引用：先别合并', 22, 'fill="#475467"'),
    `<rect x="42" y="400" width="500" height="60" rx="14" fill="#eaf4ff"/>`,
    cjkText(62, 438, '收到，今晚 20:30 再测一次。', 24),
  ].join('')),
  prompt: '逐行准确转写这张中文聊天截图里的全部可见文字，保留说话人、时间、引用内容、中文标点、英文 OCR 和数字，严格按从上到下顺序输出。只输出转写文本，不要解释。',
  expected: { text: '项目讨论\n小林 10:24\nOCR 模式选好后，第一次结构化识别还会跑吗？\n阿哲 10:25\n会。模式选择不算识别，先跑一次结构化。\n引用：先别合并\n收到，今晚 20:30 再测一次。' },
})

const FIXTURES = Object.freeze({
  structured: {
    id: 'structured-dashboard-v2',
    intent: 'structured',
    svg: svgDoc([
      `<rect x="30" y="24" width="708" height="64" rx="12" fill="#e9eef7"/>`,
      text(54, 66, 'VISION BENCH DASHBOARD', 28, 'font-weight="700"'),
      `<rect x="36" y="116" width="180" height="348" rx="12" fill="#f5f5f5"/>`,
      text(58, 164, 'Overview', 24),
      text(58, 210, 'Models', 24),
      text(58, 256, 'Health', 24),
      `<rect x="248" y="118" width="458" height="150" rx="14" fill="#eef8ef"/>`,
      text(278, 166, 'STATUS', 22, 'font-weight="700"'),
      text(278, 220, 'READY', 42, 'font-weight="700"'),
      `<rect x="248" y="294" width="218" height="170" rx="14" fill="#f7f1e8"/>`,
      text(278, 342, 'Queue', 22),
      text(278, 408, '3 jobs', 36, 'font-weight="700"'),
      `<rect x="488" y="294" width="218" height="170" rx="14" fill="#eef2fb"/>`,
      text(518, 342, 'Latency', 22),
      text(518, 408, '820 ms', 36, 'font-weight="700"'),
    ].join('')),
    prompt: 'Inspect the image and return ONLY JSON with keys visual_kind, overview, regions, visible_text, relationships, uncertainties. regions and visible_text must be arrays. Transcribe all visible text accurately from the image and describe the spatial relationships you can directly observe.',
    expected: { requiredKeys: ['visual_kind', 'overview', 'regions', 'visible_text', 'relationships', 'uncertainties'], tokens: ['STATUS', 'READY', 'Queue', '3 jobs', 'Latency', '820 ms'] },
  },
  ocr: {
    id: 'ocr-latin-ui-v2',
    intent: 'ocr',
    svg: svgDoc([
      text(60, 100, 'Router Bench 7Q2', 34, 'font-weight="700"'),
      text(60, 175, 'Invoice A-1948', 32),
      text(60, 250, 'Total USD 73.40', 32),
      text(60, 325, 'Status: READY', 32),
      text(60, 400, 'Ref #VX-2049-Z', 32),
    ].join('')),
    prompt: 'Transcribe every visible text line exactly, preserving top-to-bottom order. Output only the text, no explanation.',
    expected: { text: 'Router Bench 7Q2\nInvoice A-1948\nTotal USD 73.40\nStatus: READY\nRef #VX-2049-Z' },
  },
  grounding: {
    id: 'grounding-target-v2',
    intent: 'grounding',
    svg: svgDoc([
      text(50, 70, 'Settings', 32, 'font-weight="700"'),
      `<rect x="70" y="140" width="180" height="64" rx="10" fill="#ececec"/>`,
      text(112, 182, 'Cancel', 27),
      `<rect x="516" y="344" width="176" height="72" rx="12" fill="#dcecff" stroke="#225" stroke-width="2"/>`,
      text(553, 390, 'SAVE', 30, 'font-weight="700"'),
      `<rect x="300" y="235" width="180" height="64" rx="10" fill="#f1f1f1"/>`,
      text(346, 277, 'Preview', 27),
    ].join('')),
    prompt: 'Locate the SAVE button. On the first line output [[xmin,ymin,xmax,ymax]] for the tight button rectangle. Normalize x by image width and y by image height, then scale every coordinate to the 0-1000 range. Do not add explanatory prose to the coordinate line.',
    expected: { box: { x1: 516, y1: 344, x2: 692, y2: 416 } },
  },
  document: {
    id: 'document-table-v2',
    intent: 'document',
    svg: svgDoc([
      text(48, 64, 'Order Summary', 32, 'font-weight="700"'),
      `<rect x="48" y="100" width="670" height="290" fill="none" stroke="#333"/>`,
      `<line x1="48" y1="160" x2="718" y2="160" stroke="#333"/><line x1="48" y1="230" x2="718" y2="230" stroke="#333"/><line x1="48" y1="300" x2="718" y2="300" stroke="#333"/>`,
      `<line x1="360" y1="100" x2="360" y2="390" stroke="#333"/>`,
      text(78, 140, 'Item', 24, 'font-weight="700"'), text(410, 140, 'Amount', 24, 'font-weight="700"'),
      text(78, 207, 'Camera', 25), text(410, 207, '$120', 25),
      text(78, 277, 'Cable', 25), text(410, 277, '$15', 25),
      text(78, 347, 'Total', 25, 'font-weight="700"'), text(410, 347, '$135', 25, 'font-weight="700"'),
      text(48, 448, 'Order ID: R-4821', 24),
    ].join('')),
    prompt: 'Read this document. Return ONLY JSON with title, rows, total, order_id. rows must preserve the table row order and amounts.',
    expected: {
      title: 'Order Summary',
      rows: [
        { item: 'Camera', amount: '$120' },
        { item: 'Cable', amount: '$15' },
      ],
      total: '$135',
      order_id: 'R-4821',
    },
  },
  general: {
    id: 'general-scene-v2',
    intent: 'general',
    svg: svgDoc([
      `<circle cx="165" cy="210" r="70" fill="#f7d85b" stroke="#333" stroke-width="3"/>`,
      `<rect x="340" y="145" width="150" height="130" fill="#8ed0f0" stroke="#333" stroke-width="3"/>`,
      `<polygon points="610,145 690,275 530,275" fill="#eca3b2" stroke="#333" stroke-width="3"/>`,
      text(92, 350, 'circle', 24), text(374, 350, 'square', 24), text(566, 350, 'triangle', 24),
    ].join('')),
    prompt: 'Answer in one short sentence: how many large geometric shapes are shown, and what are they from left to right?',
    expected: { tokens: ['3', 'circle', 'square', 'triangle'] },
  },
})

export const CORE_BENCHMARK_INTENTS = Object.freeze(['structured', 'ocr', 'grounding', 'document', 'general'])

export function capabilityBenchmarkFixture(intent) {
  const key = VISION_INTENTS.includes(intent) ? intent : 'general'
  return FIXTURES[key] ?? FIXTURES.general
}

export function listCapabilityBenchmarkFixtures(intents = CORE_BENCHMARK_INTENTS) {
  const fixtures = []
  for (const intent of intents) {
    fixtures.push(capabilityBenchmarkFixture(intent))
    if (intent === 'ocr') fixtures.push(OCR_ZH_CHAT_FIXTURE)
  }
  return fixtures
}

function isSensitiveKey(key) {
  return /(^|[_-])(api[_-]?key|key|token|secret|password|authorization|auth|signature|sig)([_-]|$)/i.test(String(key ?? ''))
}

function normalizeEndpoint(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') return ''
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) url.searchParams.delete(key)
    }
    url.searchParams.sort()
    const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}${url.search}`
  } catch {
    return raw.replace(/\/+$/, '')
  }
}

function sanitizeFingerprintValue(value, keyHint = '') {
  if (value === null || value === undefined) return value ?? null
  if (Array.isArray(value)) return value.map((item) => sanitizeFingerprintValue(item))
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isSensitiveKey(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sanitizeFingerprintValue(child, key)]),
    )
  }
  if (typeof value === 'string' && /(endpoint|base[_-]?url|url)$/i.test(keyHint)) return normalizeEndpoint(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value
  return String(value)
}

export function capabilityBenchmarkFingerprint({ provider, model, endpoint, config, credentialFingerprint } = {}) {
  const payload = JSON.stringify({
    schema: 'vision-capability-endpoint-v2',
    suiteRevision: CAPABILITY_BENCHMARK_SUITE_REVISION,
    rendererScope: CAPABILITY_BENCHMARK_RENDERER_SCOPE,
    provider: String(provider ?? '').trim(),
    model: String(model ?? '').trim(),
    endpoint: normalizeEndpoint(endpoint),
    config: sanitizeFingerprintValue(config && typeof config === 'object' ? config : null),
    credentialFingerprint: String(credentialFingerprint ?? 'none'),
  })
  return `ep2_${createHash('sha256').update(payload).digest('hex').slice(0, 32)}`
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
}

function normalizeText(value) {
  return String(value ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim().toLowerCase()
}

function levenshtein(a, b) {
  const left = [...a]
  const right = [...b]
  const prev = Array(right.length + 1).fill(0).map((_, i) => i)
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = prev[0]
    prev[0] = i
    for (let j = 1; j <= right.length; j += 1) {
      const old = prev[j]
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + cost)
      diagonal = old
    }
  }
  return prev[right.length]
}

function textSimilarity(actual, expected) {
  const a = normalizeText(actual)
  const b = normalizeText(expected)
  if (a === b) return 1
  const max = Math.max(a.length, b.length)
  return max === 0 ? 1 : clamp01(1 - levenshtein(a, b) / max)
}

function extractJson(value) {
  const text = String(value ?? '').trim()
  try { return JSON.parse(text) } catch {}
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)) } catch {}
  }
  return undefined
}

function extractGroundingValue(value) {
  if (value && typeof value === 'object') return { value, source: 'structured' }
  const text = String(value ?? '').trim()
  if (text === '') return { value: undefined, source: 'none' }

  try {
    return { value: JSON.parse(text), source: 'json' }
  } catch {}

  const object = extractJson(text)
  if (object !== undefined) return { value: object, source: 'json-object-in-text' }

  const number = '-?\\d+(?:\\.\\d+)?'
  const numbersFrom = (input) => (String(input ?? '').match(new RegExp(number, 'g')) ?? []).map(Number)

  const marked = text.match(/<\|(?:begin_of_box|box_start)\|>([\s\S]*?)<\|(?:end_of_box|box_end)\|>/i)
  if (marked) {
    const values = numbersFrom(marked[1])
    if (values.length >= 4) return { value: values.slice(0, 4), source: 'glm-box-markers' }
  }

  const flatTuple = new RegExp(`[\\[\\(<]\\s*(${number})\\s*,\\s*(${number})\\s*,\\s*(${number})\\s*,\\s*(${number})\\s*[\\]\\)>]`)
  const tupleMatch = text.match(flatTuple)
  if (tupleMatch) {
    return { value: tupleMatch.slice(1, 5).map(Number), source: 'flat-four-tuple' }
  }

  const pairArray = new RegExp(`[\\[(]\\s*(${number})\\s*,\\s*(${number})\\s*[\\])]\\s*[,;]?\\s*[\\[(]\\s*(${number})\\s*,\\s*(${number})\\s*[\\])]`)
  const pairMatch = text.match(pairArray)
  if (pairMatch) {
    return { value: [[Number(pairMatch[1]), Number(pairMatch[2])], [Number(pairMatch[3]), Number(pairMatch[4])]], source: 'point-pairs' }
  }

  const labelled = new RegExp(`x(?:_?min|1)\\s*[:=]\\s*(${number})[\\s,;]+y(?:_?min|1)\\s*[:=]\\s*(${number})[\\s,;]+x(?:_?max|2)\\s*[:=]\\s*(${number})[\\s,;]+y(?:_?max|2)\\s*[:=]\\s*(${number})`, 'i')
  const labelledMatch = text.match(labelled)
  if (labelledMatch) {
    return {
      value: labelledMatch.slice(1, 5).map(Number),
      source: 'labelled-coordinates',
    }
  }

  const compactValues = numbersFrom(text)
  if (text.length <= 160 && compactValues.length === 4) {
    return { value: compactValues, source: 'compact-four-numbers' }
  }

  return { value: undefined, source: 'unparsed' }
}

function tokenCoverage(value, tokens = []) {
  const haystack = normalizeText(typeof value === 'string' ? value : JSON.stringify(value ?? ''))
  if (tokens.length === 0) return 1
  const hits = tokens.filter((token) => haystack.includes(normalizeText(token))).length
  return hits / tokens.length
}

function documentScore(output, expected = {}) {
  const parsed = extractJson(output)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { score: 0, details: { jsonValid: false, title: 0, rows: 0, total: 0, orderId: 0 } }
  }
  const eq = (left, right) => normalizeText(left) === normalizeText(right)
  const title = eq(parsed.title, expected.title) ? 1 : 0
  const total = eq(parsed.total, expected.total) ? 1 : 0
  const orderId = eq(parsed.order_id, expected.order_id) ? 1 : 0
  const expectedRows = Array.isArray(expected.rows) ? expected.rows : []
  const actualRows = Array.isArray(parsed.rows) ? parsed.rows : []
  let rowHits = 0
  for (let index = 0; index < expectedRows.length; index += 1) {
    const actual = actualRows[index]
    const wanted = expectedRows[index]
    if (!actual || typeof actual !== 'object') continue
    const actualItem = actual.item ?? actual.name ?? actual.label
    const actualAmount = actual.amount ?? actual.value ?? actual.price
    if (eq(actualItem, wanted.item) && eq(actualAmount, wanted.amount)) rowHits += 1
  }
  const rows = expectedRows.length > 0 && actualRows.length === expectedRows.length ? rowHits / expectedRows.length : 0
  const score = clamp01(title * 0.2 + rows * 0.5 + total * 0.15 + orderId * 0.15)
  return { score, details: { jsonValid: true, title, rows, total, orderId } }
}

function rawBox(value) {
  if (!value) return undefined
  if (Array.isArray(value)) {
    if (value.length === 1) return rawBox(value[0])
    if (value.length >= 4 && value.slice(0, 4).every((item) => !Array.isArray(item) && typeof item !== 'object')) {
      return { x1: value[0], y1: value[1], x2: value[2], y2: value[3], shape: 'array' }
    }
    if (value.length >= 2 && Array.isArray(value[0]) && Array.isArray(value[1]) && value[0].length >= 2 && value[1].length >= 2) {
      return { x1: value[0][0], y1: value[0][1], x2: value[1][0], y2: value[1][1], shape: 'point-pairs' }
    }
    return undefined
  }
  if (typeof value !== 'object') return undefined
  for (const key of ['box', 'bbox', 'bounding_box', 'boundingBox', 'coordinates', 'position', 'rect', 'region', 'points']) {
    if (value[key] !== undefined) {
      const nested = rawBox(value[key])
      if (nested) return nested
    }
  }
  if (['x1', 'y1', 'x2', 'y2'].every((key) => value[key] !== undefined)) {
    return { x1: value.x1, y1: value.y1, x2: value.x2, y2: value.y2, shape: 'corners' }
  }
  if (['xmin', 'ymin', 'xmax', 'ymax'].every((key) => value[key] !== undefined)) {
    return { x1: value.xmin, y1: value.ymin, x2: value.xmax, y2: value.ymax, shape: 'minmax' }
  }
  if (['x_min', 'y_min', 'x_max', 'y_max'].every((key) => value[key] !== undefined)) {
    return { x1: value.x_min, y1: value.y_min, x2: value.x_max, y2: value.y_max, shape: 'minmax-underscored' }
  }
  if (['left', 'top', 'right', 'bottom'].every((key) => value[key] !== undefined)) {
    return { x1: value.left, y1: value.top, x2: value.right, y2: value.bottom, shape: 'ltrb' }
  }
  if (['x', 'y', 'width', 'height'].every((key) => value[key] !== undefined)) {
    return {
      x1: value.x,
      y1: value.y,
      x2: Number(value.x) + Number(value.width),
      y2: Number(value.y) + Number(value.height),
      shape: 'xywh',
    }
  }
  return undefined
}

function normalizedBox(raw, coordinateSpace, width, height) {
  let x1 = Number(raw.x1), y1 = Number(raw.y1), x2 = Number(raw.x2), y2 = Number(raw.y2)
  if (![x1, y1, x2, y2].every(Number.isFinite)) return undefined
  if (coordinateSpace === 'normalized-1') {
    x1 *= width; x2 *= width; y1 *= height; y2 *= height
  } else if (coordinateSpace === 'percent-100') {
    x1 = x1 / 100 * width; x2 = x2 / 100 * width; y1 = y1 / 100 * height; y2 = y2 / 100 * height
  } else if (coordinateSpace === 'normalized-1000') {
    x1 = x1 / 1000 * width; x2 = x2 / 1000 * width; y1 = y1 / 1000 * height; y2 = y2 / 1000 * height
  }
  if (x2 < x1) [x1, x2] = [x2, x1]
  if (y2 < y1) [y1, y2] = [y2, y1]
  return { box: { x1, y1, x2, y2 }, coordinateSpace, shape: raw.shape }
}

function groundingBoxCandidates(value, width = WIDTH, height = HEIGHT) {
  const raw = rawBox(value)
  if (!raw) return []
  const values = [raw.x1, raw.y1, raw.x2, raw.y2].map(Number)
  if (!values.every(Number.isFinite)) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  const candidates = []
  const push = (space) => {
    const normalized = normalizedBox(raw, space, width, height)
    if (normalized && !candidates.some((item) => item.coordinateSpace === space)) candidates.push(normalized)
  }
  if (min >= 0 && max <= 1.000001) push('normalized-1')
  if (min >= 0 && max <= 100) push('percent-100')
  if (min >= 0 && max <= 1000) push('normalized-1000')
  if (min >= 0 && values[0] <= width * 1.5 && values[2] <= width * 1.5 && values[1] <= height * 1.5 && values[3] <= height * 1.5) push('pixels')
  return candidates
}

export function normalizeGroundingBox(value, width = WIDTH, height = HEIGHT) {
  const candidates = groundingBoxCandidates(value, width, height)
  if (candidates.length === 0) return undefined
  const raw = rawBox(value)
  const values = [raw.x1, raw.y1, raw.x2, raw.y2].map(Number)
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min >= 0 && max <= 1.000001) return candidates.find((item) => item.coordinateSpace === 'normalized-1')
  if (min >= 0 && max <= 100) return candidates.find((item) => item.coordinateSpace === 'percent-100')
  if (min >= 0 && max <= 1000 && (values[0] > width || values[2] > width || values[1] > height || values[3] > height)) {
    return candidates.find((item) => item.coordinateSpace === 'normalized-1000')
  }
  return candidates.find((item) => item.coordinateSpace === 'pixels') ?? candidates[0]
}

function boxIoU(actual, expected) {
  if (!actual || !expected) return 0
  const ax1 = Number(actual.x1), ay1 = Number(actual.y1), ax2 = Number(actual.x2), ay2 = Number(actual.y2)
  const bx1 = Number(expected.x1), by1 = Number(expected.y1), bx2 = Number(expected.x2), by2 = Number(expected.y2)
  if (![ax1, ay1, ax2, ay2, bx1, by1, bx2, by2].every(Number.isFinite)) return 0
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1))
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1))
  const intersection = ix * iy
  const areaA = Math.max(0, ax2 - ax1) * Math.max(0, ay2 - ay1)
  const areaB = Math.max(0, bx2 - bx1) * Math.max(0, by2 - by1)
  const union = areaA + areaB - intersection
  return union > 0 ? intersection / union : 0
}

export function scoreCapabilityBenchmarkResult(fixture, output, latencyMs) {
  const intent = fixture?.intent ?? 'general'
  let accuracy = 0
  let details = {}

  if (intent === 'ocr') {
    accuracy = textSimilarity(output, fixture.expected.text)
    details = { textSimilarity: accuracy }
  } else if (intent === 'grounding') {
    const extraction = extractGroundingValue(output)
    const candidates = groundingBoxCandidates(extraction.value)
      .map((candidate) => ({ ...candidate, iou: boxIoU(candidate.box, fixture.expected.box) }))
      .sort((a, b) => b.iou - a.iou)
    const best = candidates[0]
    accuracy = best?.iou ?? 0
    details = {
      iou: accuracy,
      parseSource: extraction.source,
      parsed: extraction.value,
      normalized: best?.box,
      coordinateSpace: best?.coordinateSpace,
      responseShape: best?.shape,
      formatValid: best !== undefined,
      candidateSpaces: candidates.map((candidate) => candidate.coordinateSpace),
    }
  } else if (intent === 'structured') {
    const parsed = extractJson(output)
    const required = fixture.expected.requiredKeys ?? []
    const keyCoverage = parsed && required.length > 0
      ? required.filter((key) => Object.prototype.hasOwnProperty.call(parsed, key)).length / required.length
      : 0
    const tokens = tokenCoverage(parsed ?? output, fixture.expected.tokens)
    accuracy = clamp01(keyCoverage * 0.55 + tokens * 0.45)
    details = { jsonValid: parsed !== undefined, keyCoverage, tokenCoverage: tokens }
  } else if (intent === 'document') {
    const document = documentScore(output, fixture.expected)
    accuracy = document.score
    details = document.details
  } else {
    accuracy = tokenCoverage(output, fixture.expected.tokens)
    details = { tokenCoverage: accuracy }
  }

  return {
    fixture: fixture.id,
    intent,
    score: Number(clamp01(accuracy).toFixed(4)),
    latencyMs: Number.isFinite(Number(latencyMs)) ? Math.max(0, Number(latencyMs)) : undefined,
    details,
  }
}

export function aggregateCapabilityBenchmark(results = []) {
  const scores = {}
  const latency = {}
  for (const result of results) {
    if (!result || !VISION_INTENTS.includes(result.intent)) continue
    if (!scores[result.intent]) scores[result.intent] = []
    scores[result.intent].push(clamp01(Number(result.score)))
    if (Number.isFinite(Number(result.latencyMs))) {
      if (!latency[result.intent]) latency[result.intent] = []
      latency[result.intent].push(Number(result.latencyMs))
    }
  }
  const averaged = {}
  const medianLatencyMs = {}
  for (const [intent, values] of Object.entries(scores)) {
    averaged[intent] = Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4))
  }
  for (const [intent, values] of Object.entries(latency)) {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    medianLatencyMs[intent] = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  }
  return { scores: averaged, medianLatencyMs, fixtureCount: results.length }
}
