import {
  BENCHMARK_AXES,
  VISION_INTENTS,
  benchmarkAxisForVisionIntent,
  normalizeVisionIntent,
  type BenchmarkAxis,
  type CapabilityLatencyMap,
  type CapabilityMeasuredAtMap,
  type CapabilitySampleCountMap,
  type CapabilityScoreMap,
  type VisionIntent,
} from '../../../src/lib/vision-capability-evidence.js'

const intent: VisionIntent = normalizeVisionIntent('ocr')
const axis: BenchmarkAxis | undefined = benchmarkAxisForVisionIntent(intent)
const scores: CapabilityScoreMap = { ocr: 0.9, general: 0.7 }
const latencies: CapabilityLatencyMap = { ocr: 320 }
const measuredAt: CapabilityMeasuredAtMap = { ocr: 1_700_000_000_000 }
const counts: CapabilitySampleCountMap = { ocr: 3 }

void VISION_INTENTS
void BENCHMARK_AXES
void intent
void axis
void scores
void latencies
void measuredAt
void counts

// @ts-expect-error benchmark maps accept benchmark axes only
scores.ui = 1
// @ts-expect-error arbitrary strings are not benchmark axes
const invalidAxis: BenchmarkAxis = 'ui'
void invalidAxis
