import {
  VISION_INTENTS,
  buildVisionCapabilityProfile,
} from './vision-capability-router.js'

const INTENT_LABELS = Object.freeze({
  structured: '结构化',
  ocr: 'OCR',
  document: '文档',
  ui: 'UI',
  grounding: '定位',
  detection: '检测',
  general: '通用',
  chart_diagram: '图表/架构',
  code_screenshot: '代码截图',
  visual_compare: '多图比较',
})

function keyOf(candidate) {
  if (candidate && candidate.key) return String(candidate.key)
  return `${candidate?.provider ?? ''}/${candidate?.model ?? ''}`
}

function rounded(value) {
  return Number(Number(value ?? 0).toFixed(2))
}

/**
 * A capability reference is evidence, not a permanent model leaderboard.
 * Unknown/new models therefore stay explicitly "unverified" instead of being
 * assigned confident specialist labels from their name alone.
 */
export function summarizeVisionCapabilityCandidate(candidate, options = {}) {
  const key = keyOf(candidate)
  const profile = candidate?.profile ?? buildVisionCapabilityProfile({
    provider: candidate?.provider,
    model: candidate?.model,
    local: candidate?.local,
    latencyMs: candidate?.latencyMs,
    cost: candidate?.cost,
    privacy: candidate?.privacy,
    measured: options.measured?.[key],
    override: options.overrides?.[key],
  })

  const ranked = VISION_INTENTS
    .map((intent) => ({
      intent,
      score: Number(profile?.scores?.[intent] ?? 0),
      confidence: Number(profile?.confidence?.[intent] ?? 0),
    }))
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence)

  const provenance = profile?.provenance ?? {}
  const evidence = provenance.override
    ? 'manual-override'
    : provenance.measured
      ? 'measured'
      : provenance.prior === 'family-prior'
        ? 'family-prior'
        : 'unverified'

  // Generic priors have deliberately low confidence. Do not tell the agent an
  // unknown future model is "good at OCR" merely because every vision model
  // receives a generic fallback score.
  const strengths = ranked
    .filter((item) => item.confidence >= 0.55 && item.score >= 0.72)
    .slice(0, 4)
    .map((item) => ({
      intent: item.intent,
      label: INTENT_LABELS[item.intent] ?? item.intent,
      score: rounded(item.score),
      confidence: rounded(item.confidence),
    }))

  const maxConfidence = Math.max(0, ...ranked.map((item) => item.confidence))
  return {
    key,
    provider: profile?.provider ?? candidate?.provider ?? '',
    model: profile?.model ?? candidate?.model ?? '',
    family: profile?.family ?? 'generic-vision',
    evidence,
    verified: evidence === 'measured' || evidence === 'manual-override',
    confidence: rounded(maxConfidence),
    strengths,
    needsBenchmark: maxConfidence < 0.7 || strengths.length === 0,
    profile,
  }
}

/**
 * Build the compact reference that can be fed to the text agent in shadow
 * experiments. It intentionally communicates provenance/confidence so the
 * agent can distinguish a measured specialist from a weak family guess.
 */
export function buildAgentVisionModelReference(candidates = [], options = {}) {
  const maxModels = Number.isInteger(options.maxModels) && options.maxModels > 0
    ? options.maxModels
    : 8
  const summaries = candidates
    .slice(0, maxModels)
    .map((candidate) => summarizeVisionCapabilityCandidate(candidate, options))

  if (summaries.length === 0) return { text: '', models: [] }

  const lines = summaries.map((item) => {
    const strengths = item.strengths.length > 0
      ? item.strengths.map((entry) => `${entry.label}:${entry.score}`).join('、')
      : '能力未验证'
    const source = item.evidence === 'measured'
      ? '实测'
      : item.evidence === 'manual-override'
        ? '人工确认'
        : item.evidence === 'family-prior'
          ? '家族先验'
          : '未知新模型'
    return `- ${item.key} | ${source} | ${strengths}${item.needsBenchmark ? ' | 建议自测' : ''}`
  })

  return {
    models: summaries,
    text: [
      '当前视觉模型能力参考（只代表现有证据，不是永久排行榜）：',
      ...lines,
      '优先相信“实测/人工确认”；“家族先验”只作弱参考；未知新模型在自测前不要臆测其专长。',
    ].join('\n'),
  }
}

/**
 * Decide which tiny capability fixtures should be run first for a new or
 * weakly-known backend. This is the long-term answer to future model churn:
 * probe the exact configured endpoint instead of waiting for a hard-coded
 * model-name update.
 */
export function planVisionCapabilityDiscovery(summaryOrCandidate, options = {}) {
  const summary = summaryOrCandidate?.strengths && summaryOrCandidate?.profile
    ? summaryOrCandidate
    : summarizeVisionCapabilityCandidate(summaryOrCandidate, options)
  const taskIntent = VISION_INTENTS.includes(options.taskIntent) ? options.taskIntent : undefined
  const budget = Number.isInteger(options.budget) && options.budget > 0 ? options.budget : 4

  const lowConfidence = VISION_INTENTS
    .map((intent) => ({
      intent,
      confidence: Number(summary.profile?.confidence?.[intent] ?? 0),
    }))
    .sort((a, b) => a.confidence - b.confidence)

  const ordered = []
  const add = (intent) => {
    if (VISION_INTENTS.includes(intent) && !ordered.includes(intent)) ordered.push(intent)
  }
  // Validate the capability needed by the current task first, then a compact
  // cross-section that separates OCR/spatial/general behavior well.
  add(taskIntent)
  add('structured')
  add('ocr')
  add('grounding')
  add('general')
  for (const item of lowConfidence) add(item.intent)

  return {
    backend: summary.key,
    needed: summary.needsBenchmark,
    intents: ordered.slice(0, budget),
    reason: summary.needsBenchmark
      ? 'capability evidence is weak; benchmark the exact configured backend/fingerprint before promoting it as a specialist'
      : 'existing measured/manual evidence is already strong enough for routing',
  }
}
