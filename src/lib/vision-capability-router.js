// Capability-aware visual model routing prototype for the v2 architecture.
//
// The v2 router is intentionally measurement-only: user order expresses user
// intent, exact-endpoint self-benchmarks provide capability facts, and runtime
// health only gates temporary availability. Model names/families never create
// capability scores and unmeasured tasks never reorder the user's chain.

export const VISION_INTENTS = Object.freeze([
  'structured',
  'ocr',
  'document',
  'ui',
  'grounding',
  'detection',
  'general',
  'chart_diagram',
  'code_screenshot',
  'visual_compare',
])

export const BENCHMARK_AXES = Object.freeze([
  'structured',
  'ocr',
  'document',
  'grounding',
  'general',
])

// Internal compatibility vocabulary. `privacy` is the historical scorer name
// for the user-facing `local` preference; unlike the old implementation it is
// a stable locality policy, not a weighted privacy score.
export const VISION_STRATEGIES = Object.freeze(['quality', 'balanced', 'speed', 'privacy'])

export const AUTO_REORDER_MIN_ADVANTAGE = 0.08

const DIRECT_TASK_AXIS = Object.freeze({
  structured: 'structured',
  ocr: 'ocr',
  document: 'document',
  grounding: 'grounding',
  general: 'general',
})

const BOOTSTRAP_VISUAL_INTENT = Object.freeze({
  chat: 'ui',
  document: 'document',
  ui: 'ui',
  code: 'code_screenshot',
  general: 'general',
  unknown: 'general',
})
const BOOTSTRAP_VISUAL_KINDS = new Set(['chat', 'document', 'ui', 'code', 'general', 'mixed', 'unknown'])
const BOOTSTRAP_CONTENT_KINDS = new Set(['person', 'animal', 'plant', 'food', 'vehicle', 'machine', 'architecture', 'object', 'scene', 'meme', 'unknown'])
const BOOTSTRAP_MIXED_PRIORITY = ['ui', 'document', 'code', 'chat', 'general']

function clamp01(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(1, n))
}

function normalizedIntent(intent) {
  return VISION_INTENTS.includes(intent) ? intent : 'general'
}

function normalizedStrategy(strategy) {
  return VISION_STRATEGIES.includes(strategy) ? strategy : 'balanced'
}

function cleanEnum(value, allowed) {
  const text = typeof value === 'string' ? value.trim() : ''
  return allowed.has(text) ? text : 'unknown'
}

export function benchmarkAxisForVisionIntent(intent) {
  return DIRECT_TASK_AXIS[normalizedIntent(intent)]
}

export function inferBootstrapVisionIntents(bootstrap = {}) {
  const source = bootstrap && typeof bootstrap === 'object' && !Array.isArray(bootstrap) ? bootstrap : {}
  const visualKind = cleanEnum(source.visual_kind, BOOTSTRAP_VISUAL_KINDS)
  const contentKind = cleanEnum(source.content_kind, BOOTSTRAP_CONTENT_KINDS)

  const branchKinds = []
  if (visualKind === 'mixed') {
    const raw = Array.isArray(source.mixed_of) ? source.mixed_of : []
    const available = new Set(raw.map((item) => cleanEnum(item, new Set(BOOTSTRAP_MIXED_PRIORITY))).filter((item) => item !== 'unknown'))
    for (const kind of BOOTSTRAP_MIXED_PRIORITY) {
      if (available.has(kind) && !branchKinds.includes(kind)) branchKinds.push(kind)
      if (branchKinds.length >= 2) break
    }
  } else {
    branchKinds.push(visualKind)
  }

  const all = []
  for (const kind of branchKinds) {
    const intent = BOOTSTRAP_VISUAL_INTENT[kind] ?? 'general'
    if (!all.includes(intent)) all.push(intent)
  }
  if (all.length === 0) all.push('general')

  return {
    primary: all[0],
    secondary: all.slice(1),
    all,
    visualKind,
    contentKind,
    mixedOf: visualKind === 'mixed' ? branchKinds : [],
  }
}

export function inferToolVisionIntent(toolName, args = {}, context = {}) {
  switch (toolName) {
    case 'vision_bootstrap':
      return 'structured'
    case 'vision_ocr':
      return 'ocr'
    case 'vision_long_screenshot_ocr':
      return 'document'
    case 'vision_ground':
      return 'grounding'
    case 'vision_detect':
      return 'detection'
    case 'vision_pixel_diff':
      return 'visual_compare'
    case 'vision_describe': {
      const count =
        (Array.isArray(args.paths) ? args.paths.length : 0) +
        (Array.isArray(args.attachmentIds) ? args.attachmentIds.length : 0)
      if (count > 1) return 'visual_compare'
      const q = String(args.question ?? context.question ?? '').toLowerCase()
      if (/\b(ocr|transcribe|transcription|read all text|exact text|visible text)\b/.test(q) || /原样转述|所有文字|逐字|识别文字/.test(q)) {
        return 'ocr'
      }
      if (/\b(locate|bounding box|where is|coordinates?|position of|tight box)\b/.test(q)) {
        return 'grounding'
      }
      if (/\b(detect|find every|list all|enumerate|all buttons|all inputs|all elements|numbered inventory)\b/.test(q)) {
        return 'detection'
      }
      if (/\b(terminal|traceback|stack trace|compiler|source code|code screenshot|ide|console|log)\b/.test(q)) {
        return 'code_screenshot'
      }
      if (/\b(chart|graph|plot|diagram|architecture|circuit|schematic|flowchart)\b/.test(q)) {
        return 'chart_diagram'
      }
      if (/\b(ui|interface|button|form|webpage|website|screen|app|dialog|menu)\b/.test(q)) {
        return 'ui'
      }
      if (/\b(document|pdf|table|invoice|receipt|contract|form|paper|page layout)\b/.test(q)) {
        return 'document'
      }
      const bootstrap = context.bootstrap ?? context.structuredBootstrap
      if (bootstrap !== undefined) return inferBootstrapVisionIntents(bootstrap).primary
      return 'general'
    }
    default:
      return 'general'
  }
}

function normalizeScoreMap(value) {
  const out = {}
  for (const axis of BENCHMARK_AXES) {
    if (value && Object.prototype.hasOwnProperty.call(value, axis)) {
      const score = Number(value[axis])
      if (Number.isFinite(score)) out[axis] = clamp01(score)
    }
  }
  return out
}

function normalizeLatencyMap(value) {
  const out = {}
  for (const axis of BENCHMARK_AXES) {
    const latencyMs = Number(value?.[axis])
    if (Number.isFinite(latencyMs) && latencyMs >= 0) out[axis] = latencyMs
  }
  return out
}

export function buildVisionCapabilityProfile({
  provider,
  model,
  measured,
  local = false,
  latencyMs,
  medianLatencyMs,
  runtimeLatencyMsByAxis,
  privacy,
} = {}) {
  const record = measured && typeof measured === 'object' && !Array.isArray(measured) && measured.scores
    ? measured
    : undefined
  const scores = normalizeScoreMap(record?.scores ?? measured)
  const benchmarkLatency = normalizeLatencyMap(record?.medianLatencyMs ?? medianLatencyMs)
  const runtimeLatency = normalizeLatencyMap(runtimeLatencyMsByAxis)
  const measuredAt = Number(record?.measuredAt)
  const isLocal = local === true
  return {
    provider: String(provider ?? ''),
    model: String(model ?? ''),
    scores,
    traits: {
      local: isLocal,
      runtimeLatencyMsByAxis: runtimeLatency,
      privacy: privacy === 'local' || isLocal ? 'local' : privacy === 'private-cloud' ? 'private-cloud' : 'cloud',
    },
    observations: {
      benchmarkMedianLatencyMs: benchmarkLatency,
      ...(Number.isFinite(Number(latencyMs)) && Number(latencyMs) >= 0 ? { benchmarkLatencyMs: Number(latencyMs) } : {}),
    },
    provenance: {
      measured: Object.keys(scores).length > 0,
      ...(Number.isFinite(measuredAt) && measuredAt > 0 ? { measuredAt } : {}),
    },
  }
}

function speedScore(latencyMs) {
  if (!Number.isFinite(latencyMs)) return undefined
  return 1 / (1 + Math.max(0, latencyMs) / 4000)
}

function candidateBlocked(health = {}) {
  return health?.circuitOpen === true || health?.rateLimited === true
}

function candidateKey(candidate) {
  if (candidate?.key) return String(candidate.key)
  return `${candidate?.provider ?? ''}/${candidate?.model ?? ''}`
}

function measuredAtOf(candidate, rawMeasured, profile) {
  const values = [
    candidate?.measuredAt,
    rawMeasured?.measuredAt,
    profile?.provenance?.measuredAt,
  ]
  for (const value of values) {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return n
  }
  return undefined
}

function runtimeLatencyForAxis(profile, axis) {
  const axisLatency = Number(profile?.traits?.runtimeLatencyMsByAxis?.[axis])
  return Number.isFinite(axisLatency) && axisLatency >= 0 ? axisLatency : undefined
}

export function scoreVisionCandidate({
  intent,
  profile,
  strategy = 'balanced',
  measuredAt,
} = {}) {
  const resolvedIntent = normalizedIntent(intent)
  const resolvedStrategy = normalizedStrategy(strategy)
  const axis = benchmarkAxisForVisionIntent(resolvedIntent)
  const provenanceValid = Number.isFinite(Number(measuredAt)) && Number(measuredAt) > 0
  const capability = axis === undefined ? undefined : Number(profile?.scores?.[axis])
  const measuredCapability = provenanceValid && Number.isFinite(capability) ? clamp01(capability) : undefined
  const latencyMs = axis === undefined ? undefined : runtimeLatencyForAxis(profile, axis)
  const speed = speedScore(latencyMs)

  let score
  if (measuredCapability !== undefined) {
    if (resolvedStrategy === 'quality' || resolvedStrategy === 'privacy') {
      score = measuredCapability
    } else if (speed !== undefined && resolvedStrategy === 'speed') {
      score = measuredCapability * 0.55 + speed * 0.45
    } else if (speed !== undefined && resolvedStrategy === 'balanced') {
      score = measuredCapability * 0.8 + speed * 0.2
    }
  }

  return {
    score,
    comparable: Number.isFinite(score),
    intent: resolvedIntent,
    axis,
    strategy: resolvedStrategy,
    components: {
      capability: measuredCapability,
      speed,
      latencyMs,
      latencySource: speed === undefined ? undefined : 'runtime',
      local: profile?.traits?.local === true,
      measured: measuredCapability !== undefined,
      performanceObserved: speed !== undefined,
      provenanceValid,
    },
  }
}

function prepareCandidate(candidate, index, { intent, strategy, measured, health }) {
  const key = candidateKey(candidate)
  const rawMeasured = measured[key]
  const profile = candidate.profile ?? buildVisionCapabilityProfile({
    provider: candidate.provider,
    model: candidate.model,
    local: candidate.local,
    latencyMs: candidate.benchmarkLatencyMs,
    medianLatencyMs: candidate.benchmarkMedianLatencyMsByAxis,
    runtimeLatencyMsByAxis: candidate.runtimeLatencyMsByAxis,
    privacy: candidate.privacy,
    measured: rawMeasured,
  })
  const measuredAt = measuredAtOf(candidate, rawMeasured, profile)
  const scored = scoreVisionCandidate({ intent, profile, strategy, measuredAt })
  const observedHealth = health[key] ?? candidate.health
  const blocked = candidateBlocked(observedHealth)
  return {
    ...candidate,
    key,
    originalIndex: index,
    profile,
    health: observedHealth,
    blocked,
    measuredAt,
    ...scored,
  }
}

function stableLocalFirst(entries) {
  return [
    ...entries.filter((entry) => entry.profile?.traits?.local === true),
    ...entries.filter((entry) => entry.profile?.traits?.local !== true),
  ]
}

function conservativeMeasuredReorder(entries, minAdvantage, decisions) {
  const result = [...entries]
  for (let i = 1; i < result.length; i += 1) {
    let j = i
    while (j > 0) {
      const left = result[j - 1]
      const right = result[j]
      if (!left.comparable || !right.comparable) break
      const delta = Number(right.score) - Number(left.score)
      if (!(delta >= minAdvantage)) break
      result[j - 1] = right
      result[j] = left
      decisions.push({
        type: 'reorder',
        reason: 'measured-advantage',
        before: left.key,
        promoted: right.key,
        intent: right.intent,
        axis: right.axis,
        leftScore: Number(left.score.toFixed(4)),
        rightScore: Number(right.score.toFixed(4)),
        delta: Number(delta.toFixed(4)),
      })
      j -= 1
    }
  }
  return result
}

export function suggestVisionOrder({
  intent,
  candidates = [],
  strategy = 'balanced',
  measured = {},
  health = {},
  minAdvantage = AUTO_REORDER_MIN_ADVANTAGE,
} = {}) {
  const resolvedIntent = normalizedIntent(intent)
  const resolvedStrategy = normalizedStrategy(strategy)
  const threshold = Math.max(0, Math.min(1, Number(minAdvantage) || 0))
  const prepared = candidates.map((candidate, index) => prepareCandidate(candidate, index, {
    intent: resolvedIntent,
    strategy: resolvedStrategy,
    measured,
    health,
  }))

  const available = prepared.filter((entry) => !entry.blocked)
  const blocked = prepared.filter((entry) => entry.blocked)
  const routable = available.filter((entry) => entry.routeRole !== 'fallback-only')
  const fallbackOnly = available.filter((entry) => entry.routeRole === 'fallback-only')
  const decisions = blocked.map((entry) => ({
    type: 'availability',
    reason: entry.health?.rateLimited === true ? 'rate-limited' : 'circuit-open',
    backend: entry.key,
  }))

  let routed
  if (resolvedStrategy === 'privacy') {
    const localFirst = stableLocalFirst(routable)
    const local = localFirst.filter((entry) => entry.profile?.traits?.local === true)
    const cloud = localFirst.filter((entry) => entry.profile?.traits?.local !== true)
    routed = [
      ...conservativeMeasuredReorder(local, threshold, decisions),
      ...conservativeMeasuredReorder(cloud, threshold, decisions),
    ]
  } else {
    routed = conservativeMeasuredReorder(routable, threshold, decisions)
  }

  return {
    ranked: [...routed, ...fallbackOnly, ...blocked],
    decisions,
    blockedBackends: blocked.map((entry) => entry.key),
    incomparableBackends: prepared.filter((entry) => !entry.comparable).map((entry) => entry.key),
    intent: resolvedIntent,
    axis: benchmarkAxisForVisionIntent(resolvedIntent),
    strategy: resolvedStrategy,
  }
}

export function rankVisionCandidates(options = {}) {
  return suggestVisionOrder(options).ranked
}

export function visionCapabilityTags(profile, threshold = 0.8) {
  const min = clamp01(threshold, 0.8)
  return BENCHMARK_AXES.filter((axis) => {
    const score = Number(profile?.scores?.[axis])
    return Number.isFinite(score) && clamp01(score) >= min
  })
}

function roundedOrNull(value, digits = 3) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null
}

export function explainVisionRoute(ranked = []) {
  return ranked.map((entry, index) => ({
    rank: index + 1,
    backend: entry.key,
    score: roundedOrNull(entry.score, 4),
    intent: entry.intent,
    axis: entry.axis ?? null,
    capability: roundedOrNull(entry.components?.capability),
    speed: roundedOrNull(entry.components?.speed),
    latencyMs: Number.isFinite(Number(entry.components?.latencyMs)) ? Number(entry.components.latencyMs) : null,
    latencySource: entry.components?.latencySource ?? null,
    health: entry.blocked ? 0 : 1,
    local: entry.profile?.traits?.local === true,
    measured: entry.components?.measured === true,
    performanceObserved: entry.components?.performanceObserved === true,
    provenanceValid: entry.components?.provenanceValid === true,
    provenance: entry.profile?.provenance,
  }))
}
