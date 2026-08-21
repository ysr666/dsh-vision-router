import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTO_MEASURED_MAX_AGE_MS,
  AUTO_REORDER_MIN_ADVANTAGE,
  BENCHMARK_AXES,
  VISION_INTENTS,
  VISION_STRATEGIES,
  benchmarkAxisForVisionIntent,
  inferBootstrapVisionIntents,
  inferToolVisionIntent,
  buildVisionCapabilityProfile,
  scoreVisionCandidate,
  rankVisionCandidates,
  suggestVisionOrder,
  visionCapabilityTags,
  explainVisionRoute,
} from '../lib/vision-capability-router.js'

const NOW = 2_000_000_000_000
const DAY = 24 * 60 * 60 * 1000

function measured(scores, medianLatencyMs = {}, measuredAt = NOW) {
  return { scores, medianLatencyMs, measuredAt }
}

test('task vocabulary stays broad while benchmark axes stay explicit and measurement-only', () => {
  assert.deepEqual(VISION_STRATEGIES, ['quality', 'balanced', 'speed', 'privacy'])
  assert.deepEqual(BENCHMARK_AXES, ['structured', 'ocr', 'document', 'grounding', 'general'])
  assert.ok(VISION_INTENTS.includes('ui'))
  assert.ok(VISION_INTENTS.includes('visual_compare'))
  assert.equal(benchmarkAxisForVisionIntent('ocr'), 'ocr')
  assert.equal(benchmarkAxisForVisionIntent('ui'), undefined)
  assert.equal(inferToolVisionIntent('vision_bootstrap'), 'structured')
  assert.equal(inferToolVisionIntent('vision_ocr'), 'ocr')
  assert.equal(inferToolVisionIntent('vision_long_screenshot_ocr'), 'document')
  assert.equal(inferToolVisionIntent('vision_ground'), 'grounding')
  assert.equal(inferToolVisionIntent('vision_detect'), 'detection')
  assert.equal(inferToolVisionIntent('vision_pixel_diff'), 'visual_compare')
})

test('vision_describe infers a specialist task only from the requested operation', () => {
  assert.equal(inferToolVisionIntent('vision_describe', { question: 'Explain the circuit architecture in this schematic' }), 'chart_diagram')
  assert.equal(inferToolVisionIntent('vision_describe', { question: 'Read this compiler traceback in the terminal' }), 'code_screenshot')
  assert.equal(inferToolVisionIntent('vision_describe', { question: 'Which button in this web UI is selected?' }), 'ui')
  assert.equal(inferToolVisionIntent('vision_describe', { question: 'Summarize this invoice document' }), 'document')
  assert.equal(inferToolVisionIntent('vision_describe', { paths: ['a.png', 'b.png'], question: 'what changed?' }), 'visual_compare')
  assert.equal(inferToolVisionIntent('vision_describe', { question: 'what is in this photo?' }), 'general')
})

test('#178 structured scene signals bridge into task intents without reclassifying content_kind', () => {
  assert.deepEqual(
    inferBootstrapVisionIntents({ visual_kind: 'document', content_kind: 'unknown', mixed_of: [] }),
    { primary: 'document', secondary: [], all: ['document'], visualKind: 'document', contentKind: 'unknown', mixedOf: [] },
  )
  assert.equal(inferBootstrapVisionIntents({ visual_kind: 'chat' }).primary, 'ui')
  assert.equal(inferBootstrapVisionIntents({ visual_kind: 'code' }).primary, 'code_screenshot')
  const mixed = inferBootstrapVisionIntents({ visual_kind: 'mixed', content_kind: 'machine', mixed_of: ['general', 'document', 'ui', 'ui'] })
  assert.deepEqual(mixed.all, ['ui', 'document'])
  assert.deepEqual(mixed.mixedOf, ['ui', 'document'])
  assert.equal(mixed.contentKind, 'machine')
  assert.equal(inferBootstrapVisionIntents({ visual_kind: 'general', content_kind: 'machine' }).primary, 'general')
  assert.equal(inferBootstrapVisionIntents({ visual_kind: '__proto__', content_kind: 'constructor' }).primary, 'general')
})

test('unmeasured model names never create capability scores or change configured order', () => {
  const candidates = [
    { provider: 'google', model: 'gemini-9-ultra' },
    { provider: 'openrouter', model: 'qwen99-vl' },
    { provider: 'zhipu', model: 'glm-99v' },
    { provider: 'future-ai', model: 'unknown-vision-model' },
  ]
  for (const candidate of candidates) {
    const profile = buildVisionCapabilityProfile(candidate)
    assert.deepEqual(profile.scores, {})
    assert.equal(profile.provenance.measured, false)
  }
  assert.deepEqual(rankVisionCandidates({ intent: 'ocr', strategy: 'quality', candidates, now: NOW }).map((row) => row.model), candidates.map((row) => row.model))
})

test('measured profile preserves exact benchmark scores without prior blending or manual overrides', () => {
  const profile = buildVisionCapabilityProfile({ provider: 'custom', model: 'm', measured: { ocr: 0.95, grounding: 0.2, detection: 0.99 } })
  assert.deepEqual(profile.scores, { ocr: 0.95, grounding: 0.2 })
  assert.equal(profile.provenance.measured, true)
  assert.equal(Object.prototype.hasOwnProperty.call(profile, 'family'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(profile, 'confidence'), false)
})

test('quality uses measured capability while speed uses only same-axis measured latency', () => {
  const strong = buildVisionCapabilityProfile({ provider: 'p', model: 'strong', measured: measured({ ocr: 0.98 }, { ocr: 7000 }) })
  const fast = buildVisionCapabilityProfile({ provider: 'p', model: 'fast', measured: measured({ ocr: 0.78 }, { ocr: 300 }) })
  const qualityStrong = scoreVisionCandidate({ intent: 'ocr', profile: strong, strategy: 'quality', measuredAt: NOW, now: NOW })
  const qualityFast = scoreVisionCandidate({ intent: 'ocr', profile: fast, strategy: 'quality', measuredAt: NOW, now: NOW })
  assert.ok(qualityStrong.score > qualityFast.score)
  const speedStrong = scoreVisionCandidate({ intent: 'ocr', profile: strong, strategy: 'speed', measuredAt: NOW, now: NOW })
  const speedFast = scoreVisionCandidate({ intent: 'ocr', profile: fast, strategy: 'speed', measuredAt: NOW, now: NOW })
  assert.ok(speedFast.score > speedStrong.score)
})

test('balanced and speed never substitute aggregate or another-axis latency', () => {
  const profile = buildVisionCapabilityProfile({
    provider: 'p',
    model: 'm',
    measured: measured({ ocr: 0.9 }, { document: 50 }),
    latencyMs: 100,
  })
  assert.equal(scoreVisionCandidate({ intent: 'ocr', profile, strategy: 'quality', measuredAt: NOW, now: NOW }).comparable, true)
  assert.equal(scoreVisionCandidate({ intent: 'ocr', profile, strategy: 'balanced', measuredAt: NOW, now: NOW }).comparable, false)
  assert.equal(scoreVisionCandidate({ intent: 'ocr', profile, strategy: 'speed', measuredAt: NOW, now: NOW }).comparable, false)
})

test('measurement without a valid measuredAt timestamp is rejected as malformed provenance, not as old evidence', () => {
  const candidates = [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }]
  const result = suggestVisionOrder({
    intent: 'ocr',
    strategy: 'quality',
    now: NOW,
    candidates,
    measured: {
      'p/a': { scores: { ocr: 0.2 } },
      'p/b': { scores: { ocr: 1 } },
    },
  })
  assert.deepEqual(result.ranked.map((row) => row.key), ['p/a', 'p/b'])
  assert.ok(result.ranked.every((row) => row.comparable === false))
})

test('a single measured backend cannot leapfrog an unmeasured user preference', () => {
  const ranked = rankVisionCandidates({
    intent: 'ocr', strategy: 'quality', now: NOW,
    candidates: [{ provider: 'p', model: 'unknown-first' }, { provider: 'p', model: 'measured-second' }],
    measured: { 'p/measured-second': measured({ ocr: 0.99 }) },
  })
  assert.deepEqual(ranked.map((row) => row.key), ['p/unknown-first', 'p/measured-second'])
})

test('an unmeasured backend is an ordering barrier for measured candidates behind it', () => {
  const ranked = rankVisionCandidates({
    intent: 'ocr', strategy: 'quality', now: NOW,
    candidates: [
      { provider: 'p', model: 'measured-a' },
      { provider: 'p', model: 'unknown-b' },
      { provider: 'p', model: 'measured-c' },
    ],
    measured: {
      'p/measured-a': measured({ ocr: 0.6 }),
      'p/measured-c': measured({ ocr: 0.99 }),
    },
  })
  assert.deepEqual(ranked.map((row) => row.key), ['p/measured-a', 'p/unknown-b', 'p/measured-c'])
})

test('small measured deltas preserve user order while a material delta can reorder adjacent peers', () => {
  assert.equal(AUTO_REORDER_MIN_ADVANTAGE, 0.08)
  const candidates = [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }]
  const small = suggestVisionOrder({
    intent: 'ocr', strategy: 'quality', candidates, now: NOW,
    measured: { 'p/a': measured({ ocr: 0.91 }), 'p/b': measured({ ocr: 0.94 }) },
  })
  assert.deepEqual(small.ranked.map((row) => row.key), ['p/a', 'p/b'])
  assert.deepEqual(small.decisions, [])
  const large = suggestVisionOrder({
    intent: 'ocr', strategy: 'quality', candidates, now: NOW,
    measured: { 'p/a': measured({ ocr: 0.61 }), 'p/b': measured({ ocr: 0.94 }) },
  })
  assert.deepEqual(large.ranked.map((row) => row.key), ['p/b', 'p/a'])
  assert.equal(large.decisions[0].reason, 'measured-advantage')
  assert.equal(large.decisions[0].delta, 0.33)
})

test('tasks without a direct benchmark axis never reorder from capability measurements', () => {
  const ranked = rankVisionCandidates({
    intent: 'ui', strategy: 'quality', now: NOW,
    candidates: [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }],
    measured: {
      'p/a': measured({ structured: 0.2, ocr: 0.2 }),
      'p/b': measured({ structured: 1, ocr: 1 }),
    },
  })
  assert.deepEqual(ranked.map((row) => row.key), ['p/a', 'p/b'])
  assert.ok(ranked.every((row) => row.comparable === false))
})

test('measurement age alone never invalidates Auto evidence', () => {
  assert.equal(AUTO_MEASURED_MAX_AGE_MS, Number.MAX_SAFE_INTEGER)
  const old = NOW - 365 * DAY
  const ranked = rankVisionCandidates({
    intent: 'ocr', strategy: 'quality', now: NOW,
    candidates: [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }],
    measured: {
      'p/a': measured({ ocr: 0.2 }, {}, old),
      'p/b': measured({ ocr: 1 }, {}, old),
    },
  })
  assert.deepEqual(ranked.map((row) => row.key), ['p/b', 'p/a'])
  assert.ok(ranked.every((row) => row.comparable === true))
})

test('local preference is an explicit policy and may cross unmeasured cloud backends', () => {
  const ranked = rankVisionCandidates({
    intent: 'general', strategy: 'privacy', now: NOW,
    candidates: [
      { provider: 'cloud', model: 'a' },
      { provider: 'vision-http', model: 'local-b', local: true, privacy: 'local' },
      { provider: 'cloud', model: 'c' },
      { provider: 'vision-http', model: 'local-d', local: true, privacy: 'local' },
    ],
  })
  assert.deepEqual(ranked.map((row) => row.model), ['local-b', 'local-d', 'a', 'c'])
})

test('runtime health is an availability gate, not a capability-score penalty', () => {
  const candidates = [{ provider: 'p', model: 'best' }, { provider: 'p', model: 'unknown' }]
  const result = suggestVisionOrder({
    intent: 'ocr', strategy: 'quality', candidates, now: NOW,
    measured: { 'p/best': measured({ ocr: 1 }) },
    health: { 'p/best': { circuitOpen: true } },
  })
  assert.deepEqual(result.ranked.map((row) => row.key), ['p/unknown', 'p/best'])
  assert.deepEqual(result.blockedBackends, ['p/best'])
  assert.equal(result.ranked[1].profile.scores.ocr, 1)
  assert.equal(result.ranked[1].blocked, true)
})

test('fallback-only backends never leapfrog user-selected routes even with stronger measurements', () => {
  const ranked = rankVisionCandidates({
    intent: 'ocr', strategy: 'quality', now: NOW,
    candidates: [
      { provider: 'p', model: 'user-a' },
      { provider: 'vision-http', model: 'ovh/free', routeRole: 'fallback-only' },
    ],
    measured: {
      'p/user-a': measured({ ocr: 0.3 }),
      'vision-http/ovh/free': measured({ ocr: 1 }),
    },
  })
  assert.deepEqual(ranked.map((row) => row.key), ['p/user-a', 'vision-http/ovh/free'])
})

test('capability tags and route explanation expose only measured benchmark axes', () => {
  const profile = buildVisionCapabilityProfile({ provider: 'p', model: 'specialist', measured: measured({ ocr: 0.99, document: 0.96, grounding: 0.4 }) })
  const tags = visionCapabilityTags(profile, 0.85)
  assert.deepEqual(tags, ['ocr', 'document'])
  const ranked = rankVisionCandidates({
    intent: 'ocr', strategy: 'quality', now: NOW,
    candidates: [{ provider: 'p', model: 'specialist', profile, measuredAt: NOW }],
  })
  const explanation = explainVisionRoute(ranked)
  assert.deepEqual(explanation.map((x) => x.backend), ['p/specialist'])
  assert.equal(explanation[0].intent, 'ocr')
  assert.equal(explanation[0].axis, 'ocr')
  assert.equal(explanation[0].capability, 0.99)
  assert.equal(explanation[0].health, 1)
})