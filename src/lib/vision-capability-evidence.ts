export const VISION_INTENTS = [
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
] as const

export type VisionIntent = (typeof VISION_INTENTS)[number]

export const BENCHMARK_AXES = [
  'structured',
  'ocr',
  'document',
  'grounding',
  'general',
] as const

export type BenchmarkAxis = (typeof BENCHMARK_AXES)[number]

export type CapabilityScoreMap = Partial<Record<BenchmarkAxis, number>>
export type CapabilityLatencyMap = Partial<Record<BenchmarkAxis, number>>
export type CapabilityMeasuredAtMap = Partial<Record<BenchmarkAxis, number>>
export type CapabilitySampleCountMap = Partial<Record<BenchmarkAxis, number>>

const DIRECT_TASK_AXIS: Readonly<Partial<Record<VisionIntent, BenchmarkAxis>>> = Object.freeze({
  structured: 'structured',
  ocr: 'ocr',
  document: 'document',
  grounding: 'grounding',
  general: 'general',
})

export function normalizeVisionIntent(intent: unknown): VisionIntent {
  return typeof intent === 'string'
    && (VISION_INTENTS as readonly string[]).includes(intent)
    ? intent as VisionIntent
    : 'general'
}

export function benchmarkAxisForVisionIntent(
  intent: unknown,
): BenchmarkAxis | undefined {
  return DIRECT_TASK_AXIS[normalizeVisionIntent(intent)]
}
