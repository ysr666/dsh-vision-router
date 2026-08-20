// Capability-aware visual model routing prototype for the v2 architecture.
//
// Phase 1 is deliberately runtime-neutral: it turns tool calls into visual
// intents, builds capability profiles from conservative family priors +
// measured/user overrides, and ranks candidate backends. Runtime integration
// is added only after the intent/profile contract is stable on current main.

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

export const VISION_STRATEGIES = Object.freeze(['quality', 'balanced', 'speed', 'privacy'])

const DEFAULT_CAPABILITY = Object.freeze({
  structured: 0.58,
  ocr: 0.52,
  document: 0.52,
  ui: 0.52,
  grounding: 0.45,
  detection: 0.45,
  general: 0.62,
  chart_diagram: 0.5,
  code_screenshot: 0.5,
  visual_compare: 0.56,
})

// Stable bridge from #178's normalized structured-bootstrap contract into the
// coarser capability vocabulary. content_kind intentionally stays metadata:
// a photo of a machine/architecture is not automatically a diagram.
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

const FAMILY_PRIORS = [
  {
    id: 'qwen-vl',
    match: /(?:qwen[^/]*?(?:vl|vision)|qvq)/i,
    scores: {
      structured: 0.9,
      ocr: 0.94,
      document: 0.92,
      ui: 0.9,
      grounding: 0.94,
      detection: 0.9,
      general: 0.9,
      chart_diagram: 0.86,
      code_screenshot: 0.86,
      visual_compare: 0.88,
    },
  },
  {
    id: 'glm-v',
    match: /(?:glm[-_.]?[\d.]*v|glm.*vision)/i,
    scores: {
      structured: 0.88,
      ocr: 0.91,
      document: 0.88,
      ui: 0.84,
      grounding: 0.82,
      detection: 0.8,
      general: 0.9,
      chart_diagram: 0.84,
      code_screenshot: 0.84,
      visual_compare: 0.86,
    },
  },
  {
    id: 'gemini',
    match: /gemini/i,
    scores: {
      structured: 0.92,
      ocr: 0.9,
      document: 0.92,
      ui: 0.88,
      grounding: 0.92,
      detection: 0.9,
      general: 0.94,
      chart_diagram: 0.9,
      code_screenshot: 0.9,
      visual_compare: 0.94,
    },
  },
  {
    id: 'llama-vision',
    match: /llama.*(?:vision|scout|maverick)/i,
    scores: {
      structured: 0.74,
      ocr: 0.68,
      document: 0.68,
      ui: 0.68,
      grounding: 0.62,
      detection: 0.62,
      general: 0.82,
      chart_diagram: 0.72,
      code_screenshot: 0.7,
      visual_compare: 0.78,
    },
  },
  {
    id: 'mistral-vision',
    match: /(?:pixtral|mistral.*(?:vision|small-3\.2))/i,
    scores: {
      structured: 0.76,
      ocr: 0.72,
      document: 0.76,
      ui: 0.7,
      grounding: 0.62,
      detection: 0.62,
      general: 0.84,
      chart_diagram: 0.74,
      code_screenshot: 0.72,
      visual_compare: 0.78,
    },
  },
]

const STRATEGY_WEIGHTS = Object.freeze({
  quality: { capability: 0.72, health: 0.16, speed: 0.06, cost: 0.03, privacy: 0.03 },
  balanced: { capability: 0.54, health: 0.18, speed: 0.13, cost: 0.08, privacy: 0.07 },
  speed: { capability: 0.38, health: 0.18, speed: 0.3, cost: 0.08, privacy: 0.06 },
  privacy: { capability: 0.4, health: 0.16, speed: 0.08, cost: 0.06, privacy: 0.3 },
})

function clamp01(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(1, n))
}

function normalizedIntent(intent) {
  return VISION_INTENTS.includes(intent) ? intent : 'general'
}

function cleanEnum(value, allowed) {
  const text = typeof value === 'string' ? value.trim() : ''
  return allowed.has(text) ? text : 'unknown'
}

/**
 * Consume the normalized scene contract introduced by #178 without inventing
 * a second classification system. mixed_of follows the same information
 * priority as structured-bootstrap.js and is capped at two distinct branches.
 */
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

export function inferBuiltinCapabilityPrior(provider, model) {
  const identity = `${provider ?? ''}/${model ?? ''}`
  const family = FAMILY_PRIORS.find((entry) => entry.match.test(identity))
  return {
    family: family?.id ?? 'generic-vision',
    source: family === undefined ? 'generic-prior' : 'family-prior',
    scores: { ...DEFAULT_CAPABILITY, ...(family?.scores ?? {}) },
  }
}

function normalizeScoreMap(value) {
  const out = {}
  for (const intent of VISION_INTENTS) {
    if (value && Object.prototype.hasOwnProperty.call(value, intent)) {
      out[intent] = clamp01(value[intent])
    }
  }
  return out
}

export function buildVisionCapabilityProfile({
  provider,
  model,
  measured,
  override,
  local = false,
  latencyMs,
  cost = 0.5,
  privacy,
} = {}) {
  const prior = inferBuiltinCapabilityPrior(provider, model)
  const measuredScores = normalizeScoreMap(measured?.scores ?? measured)
  const overrideScores = normalizeScoreMap(override?.scores ?? override)
  const scores = {}
  const confidence = {}

  for (const intent of VISION_INTENTS) {
    const base = prior.scores[intent]
    const hasMeasured = Object.prototype.hasOwnProperty.call(measuredScores, intent)
    const hasOverride = Object.prototype.hasOwnProperty.call(overrideScores, intent)
    // Measurements should materially move the prior while retaining a little
    // family knowledge for sparse/cheap fixtures. Explicit user overrides win.
    const measuredBlend = hasMeasured ? base * 0.2 + measuredScores[intent] * 0.8 : base
    scores[intent] = hasOverride ? overrideScores[intent] : clamp01(measuredBlend, base)
    confidence[intent] = hasOverride ? 1 : hasMeasured ? 0.9 : prior.source === 'family-prior' ? 0.62 : 0.3
  }

  const isLocal = local === true
  return {
    provider: String(provider ?? ''),
    model: String(model ?? ''),
    family: prior.family,
    scores,
    confidence,
    traits: {
      local: isLocal,
      latencyMs: Number.isFinite(Number(latencyMs)) ? Math.max(0, Number(latencyMs)) : undefined,
      cost: clamp01(cost, 0.5),
      privacy: privacy === 'local' || isLocal ? 'local' : privacy === 'private-cloud' ? 'private-cloud' : 'cloud',
    },
    provenance: {
      prior: prior.source,
      measured: Object.keys(measuredScores).length > 0,
      override: Object.keys(overrideScores).length > 0,
    },
  }
}

function speedScore(latencyMs) {
  if (!Number.isFinite(latencyMs)) return 0.5
  // Smoothly maps 0ms => 1, 1s => .8, 4s => .5, 12s => .25.
  return 1 / (1 + Math.max(0, latencyMs) / 4000)
}

function healthScore(health = {}) {
  if (health.circuitOpen === true || health.rateLimited === true) return 0
  const failures = Math.max(0, Number(health.recentFailures) || 0)
  const successBoost = health.recentSuccess === true ? 0.08 : 0
  return clamp01(1 - Math.min(0.75, failures * 0.16) + successBoost, 1)
}

function privacyScore(traits = {}) {
  if (traits.privacy === 'local' || traits.local === true) return 1
  if (traits.privacy === 'private-cloud') return 0.7
  return 0.25
}

function costScore(cost) {
  return 1 - clamp01(cost, 0.5)
}

export function scoreVisionCandidate({ intent, profile, health, strategy = 'balanced' }) {
  const normalizedStrategy = VISION_STRATEGIES.includes(strategy) ? strategy : 'balanced'
  const weights = STRATEGY_WEIGHTS[normalizedStrategy]
  const resolvedIntent = normalizedIntent(intent)
  const capability = clamp01(profile?.scores?.[resolvedIntent], DEFAULT_CAPABILITY[resolvedIntent])
  const healthValue = healthScore(health)
  const speed = speedScore(profile?.traits?.latencyMs)
  const cost = costScore(profile?.traits?.cost)
  const privacy = privacyScore(profile?.traits)
  const score =
    capability * weights.capability +
    healthValue * weights.health +
    speed * weights.speed +
    cost * weights.cost +
    privacy * weights.privacy

  return {
    score,
    intent: resolvedIntent,
    strategy: normalizedStrategy,
    components: { capability, health: healthValue, speed, cost, privacy },
  }
}

function candidateKey(candidate) {
  if (candidate?.key) return String(candidate.key)
  return `${candidate?.provider ?? ''}/${candidate?.model ?? ''}`
}

export function rankVisionCandidates({
  intent,
  candidates = [],
  strategy = 'balanced',
  measured = {},
  overrides = {},
  health = {},
} = {}) {
  const resolvedIntent = normalizedIntent(intent)
  return candidates
    .map((candidate, index) => {
      const key = candidateKey(candidate)
      const profile =
        candidate.profile ??
        buildVisionCapabilityProfile({
          provider: candidate.provider,
          model: candidate.model,
          local: candidate.local,
          latencyMs: candidate.latencyMs,
          cost: candidate.cost,
          privacy: candidate.privacy,
          measured: measured[key],
          override: overrides[key],
        })
      const scored = scoreVisionCandidate({
        intent: resolvedIntent,
        profile,
        health: health[key] ?? candidate.health,
        strategy,
      })
      return {
        ...candidate,
        key,
        originalIndex: index,
        profile,
        ...scored,
      }
    })
    .sort((a, b) => {
      // A tripped backend should never win due to a tiny capability delta.
      if (a.components.health === 0 && b.components.health !== 0) return 1
      if (b.components.health === 0 && a.components.health !== 0) return -1
      if (b.score !== a.score) return b.score - a.score
      return a.originalIndex - b.originalIndex
    })
}

export function visionCapabilityTags(profile, threshold = 0.8) {
  const min = clamp01(threshold, 0.8)
  return VISION_INTENTS.filter((intent) => clamp01(profile?.scores?.[intent], 0) >= min)
}

export function explainVisionRoute(ranked = []) {
  return ranked.map((entry, index) => ({
    rank: index + 1,
    backend: entry.key,
    score: Number(entry.score.toFixed(4)),
    intent: entry.intent,
    capability: Number(entry.components.capability.toFixed(3)),
    health: Number(entry.components.health.toFixed(3)),
    speed: Number(entry.components.speed.toFixed(3)),
    privacy: Number(entry.components.privacy.toFixed(3)),
    provenance: entry.profile?.provenance,
  }))
}
