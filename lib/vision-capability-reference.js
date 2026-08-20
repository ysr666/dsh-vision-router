import {
  BENCHMARK_AXES,
  benchmarkAxisForVisionIntent,
  buildVisionCapabilityProfile,
} from './vision-capability-router.js'

const INTENT_LABELS = Object.freeze({
  structured: '结构化',
  ocr: 'OCR',
  document: '文档',
  grounding: '定位',
  general: '通用',
})

function keyOf(candidate) {
  if (candidate && candidate.key) return String(candidate.key)
  return `${candidate?.provider ?? ''}/${candidate?.model ?? ''}`
}

function rounded(value) {
  return Number(Number(value ?? 0).toFixed(2))
}

/**
 * Capability references are measurement-only. Unknown/new models stay
 * explicitly unverified; model names and families never create capability
 * claims. The user's configured order remains the only default preference.
 */
export function summarizeVisionCapabilityCandidate(candidate, options = {}) {
  const key = keyOf(candidate)
  const measured = options.measured?.[key]
  const profile = candidate?.profile ?? buildVisionCapabilityProfile({
    provider: candidate?.provider,
    model: candidate?.model,
    local: candidate?.local,
    latencyMs: candidate?.latencyMs,
    privacy: candidate?.privacy,
    measured,
  })

  const coverage = BENCHMARK_AXES.filter((axis) => Number.isFinite(Number(profile?.scores?.[axis])))
  const strengths = coverage
    .map((axis) => ({
      intent: axis,
      label: INTENT_LABELS[axis] ?? axis,
      score: rounded(profile.scores[axis]),
    }))
    .filter((item) => item.score >= 0.72)
    .sort((a, b) => b.score - a.score || a.intent.localeCompare(b.intent))
    .slice(0, 4)

  const measuredEvidence = coverage.length > 0
  return {
    key,
    provider: profile?.provider ?? candidate?.provider ?? '',
    model: profile?.model ?? candidate?.model ?? '',
    evidence: measuredEvidence ? 'measured' : 'unverified',
    verified: measuredEvidence,
    coverage,
    strengths,
    needsBenchmark: !measuredEvidence,
    profile,
  }
}

/**
 * Build the compact reference that can be fed to the text agent in shadow
 * experiments. It reports only exact-endpoint measurements or explicit absence
 * of measurements; there is no family-prior/manual-capability evidence layer.
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
      : item.verified ? '暂无高分专项' : '能力未测'
    const coverage = item.coverage.length > 0
      ? item.coverage.map((axis) => INTENT_LABELS[axis] ?? axis).join('、')
      : '无'
    return `- ${item.key} | ${item.verified ? '实测' : '未测'} | 覆盖:${coverage} | ${strengths}${item.needsBenchmark ? ' | 建议自测' : ''}`
  })

  return {
    models: summaries,
    text: [
      '当前视觉模型能力参考（只展示当前端点实测，不根据模型名称推断）：',
      ...lines,
      '未测能力保持未知；自动路由应继续尊重用户配置顺序。',
    ].join('\n'),
  }
}

/**
 * Decide which exact-endpoint fixtures should be run first. For task types
 * without a direct benchmark axis, discovery does not invent a proxy score;
 * it simply fills the core measured axes until a dedicated fixture exists.
 */
export function planVisionCapabilityDiscovery(summaryOrCandidate, options = {}) {
  const summary = summaryOrCandidate?.coverage && summaryOrCandidate?.profile
    ? summaryOrCandidate
    : summarizeVisionCapabilityCandidate(summaryOrCandidate, options)
  const taskAxis = benchmarkAxisForVisionIntent(options.taskIntent)
  const budget = Number.isInteger(options.budget) && options.budget > 0 ? options.budget : 4
  const measured = new Set(summary.coverage ?? [])
  const ordered = []
  const add = (axis) => {
    if (BENCHMARK_AXES.includes(axis) && !ordered.includes(axis)) ordered.push(axis)
  }

  add(taskAxis)
  for (const axis of BENCHMARK_AXES) {
    if (!measured.has(axis)) add(axis)
  }
  for (const axis of BENCHMARK_AXES) add(axis)

  const needed = taskAxis ? !measured.has(taskAxis) : measured.size < BENCHMARK_AXES.length
  return {
    backend: summary.key,
    needed,
    intents: ordered.slice(0, budget),
    reason: needed
      ? taskAxis
        ? `exact benchmark coverage is missing for ${taskAxis}`
        : 'this task has no direct benchmark axis; fill measured coverage without inventing a proxy capability'
      : 'the exact endpoint already has the required measured capability',
  }
}
