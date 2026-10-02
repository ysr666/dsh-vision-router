import {
  createVisionRuntimePerformanceSampleStore,
  type VisionRuntimePerformanceRecord,
  type VisionRuntimePerformanceStore,
} from '../../../src/lib/vision-runtime-performance-store.js'

const identityContext = { deployment: 'a' }
const store: VisionRuntimePerformanceStore = createVisionRuntimePerformanceSampleStore({
  minSamples: 2,
  context: identityContext,
  identityResolver: (_backend, ctx) =>
    typeof ctx === 'object' && ctx !== null && 'deployment' in ctx
      ? String((ctx as { deployment: unknown }).deployment)
      : undefined,
})

store.record('provider/model', 'ocr', 100, 1_000)
store.record('provider/model', 'ocr', 300, 2_000)

const record: VisionRuntimePerformanceRecord | undefined =
  store.get('provider/model', 2_000)

if (record !== undefined) {
  const latency: number | undefined = record.runtimeLatencyMsByAxis.ocr
  const samples: number | undefined = record.sampleCountByAxis.ocr
  void latency
  void samples

  // @ts-expect-error ui has no direct benchmark axis
  void record.runtimeLatencyMsByAxis.ui
}

store.bindContext({ deployment: 'b' })
store.clear('provider/model')
