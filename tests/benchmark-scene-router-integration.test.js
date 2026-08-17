import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('exact backend benchmark is wired without the normal fallback walker', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /name: 'vision_capability_benchmark'/)
  assert.match(source, /const runExactCapabilityBenchmark = async/)
  assert.match(source, /listCapabilityBenchmarkFixtures/)
  assert.match(source, /callVisionPairWithOptionalBridge/)
  assert.match(source, /callOpenAICompatible/)
  assert.match(source, /CAPABILITY_BENCHMARK_BACKEND_NOT_FOUND/)
  assert.match(source, /capability-benchmarks/)
  assert.match(source, /buildAgentVisionModelReference\(candidates, \{ measured \}\)/)
  const start = source.indexOf('const runExactCapabilityBenchmark = async')
  const end = source.indexOf('// Build a compact evidence-aware model reference for the text agent.', start)
  assert.ok(start >= 0 && end > start)
  const runner = source.slice(start, end)
  assert.doesNotMatch(runner, /answerVision\(/)
  assert.match(runner, /candidate\.kind === 'http'/)
})

test('bootstrap result is routed only after structured evidence exists', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /routePostBootstrapScene\(evidence\)/)
  assert.match(source, /scene_route: sceneRoute/)
  assert.match(source, /sceneRouteAgentInstruction\(sceneRoute\)/)
  const evidencePos = source.indexOf('const evidence = normalizeStructuredBootstrapResult(parsed, raw)')
  const scenePos = source.indexOf('const sceneRoute = routePostBootstrapScene(evidence)', evidencePos)
  assert.ok(evidencePos >= 0 && scenePos > evidencePos)
})
