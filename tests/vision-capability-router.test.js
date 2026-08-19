import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VISION_INTENTS,
  VISION_STRATEGIES,
  inferBootstrapVisionIntents,
  inferToolVisionIntent,
  inferBuiltinCapabilityPrior,
  buildVisionCapabilityProfile,
  scoreVisionCandidate,
  rankVisionCandidates,
  visionCapabilityTags,
  explainVisionRoute,
} from '../lib/vision-capability-router.js'

test('intent vocabulary is stable and tool calls map to capabilities rather than model names', () => {
  assert.deepEqual(VISION_STRATEGIES, ['quality', 'balanced', 'speed', 'privacy'])
  assert.ok(VISION_INTENTS.includes('structured'))
  assert.ok(VISION_INTENTS.includes('ocr'))
  assert.ok(VISION_INTENTS.includes('grounding'))
  assert.equal(inferToolVisionIntent('vision_bootstrap'), 'structured')
  assert.equal(inferToolVisionIntent('vision_ocr'), 'ocr')
  assert.equal(inferToolVisionIntent('vision_long_screenshot_ocr'), 'document')
  assert.equal(inferToolVisionIntent('vision_ground'), 'grounding')
  assert.equal(inferToolVisionIntent('vision_detect'), 'detection')
  assert.equal(inferToolVisionIntent('vision_pixel_diff'), 'visual_compare')
})

test('vision_describe infers a specialist intent only from the requested operation', () => {
  assert.equal(
    inferToolVisionIntent('vision_describe', { question: 'Explain the circuit architecture in this schematic' }),
    'chart_diagram',
  )
  assert.equal(
    inferToolVisionIntent('vision_describe', { question: 'Read this compiler traceback in the terminal' }),
    'code_screenshot',
  )
  assert.equal(
    inferToolVisionIntent('vision_describe', { question: 'Which button in this web UI is selected?' }),
    'ui',
  )
  assert.equal(
    inferToolVisionIntent('vision_describe', { question: 'Summarize this invoice document' }),
    'document',
  )
  assert.equal(
    inferToolVisionIntent('vision_describe', { paths: ['a.png', 'b.png'], question: 'what changed?' }),
    'visual_compare',
  )
  assert.equal(inferToolVisionIntent('vision_describe', { question: 'what is in this photo?' }), 'general')
})

test('#178 structured scene signals bridge into capability intents without reclassifying content_kind', () => {
  assert.deepEqual(
    inferBootstrapVisionIntents({ visual_kind: 'document', content_kind: 'unknown', mixed_of: [] }),
    {
      primary: 'document',
      secondary: [],
      all: ['document'],
      visualKind: 'document',
      contentKind: 'unknown',
      mixedOf: [],
    },
  )
  assert.equal(inferBootstrapVisionIntents({ visual_kind: 'chat' }).primary, 'ui')
  assert.equal(inferBootstrapVisionIntents({ visual_kind: 'code' }).primary, 'code_screenshot')

  const mixed = inferBootstrapVisionIntents({
    visual_kind: 'mixed',
    content_kind: 'machine',
    mixed_of: ['general', 'document', 'ui', 'ui'],
  })
  assert.deepEqual(mixed.all, ['ui', 'document'])
  assert.deepEqual(mixed.mixedOf, ['ui', 'document'])
  assert.equal(mixed.contentKind, 'machine')

  // content_kind remains metadata: a machine photo is not silently relabelled
  // as a chart/diagram just because the physical subject is a machine.
  assert.equal(
    inferBootstrapVisionIntents({ visual_kind: 'general', content_kind: 'machine' }).primary,
    'general',
  )
  assert.equal(
    inferToolVisionIntent(
      'vision_describe',
      { question: 'check the important details' },
      { bootstrap: { visual_kind: 'code', content_kind: 'unknown' } },
    ),
    'code_screenshot',
  )
  assert.equal(
    inferToolVisionIntent(
      'vision_describe',
      { question: 'Explain the circuit architecture in this schematic' },
      { bootstrap: { visual_kind: 'document' } },
    ),
    'chart_diagram',
  )
  assert.equal(inferBootstrapVisionIntents({ visual_kind: '__proto__', content_kind: 'constructor' }).primary, 'general')
})

test('family priors are conservative and unknown models remain routable', () => {
  const qwen = inferBuiltinCapabilityPrior('openrouter', 'qwen3-vl-235b')
  const glm = inferBuiltinCapabilityPrior('zhipu', 'glm-4.6v-flash')
  const gemini = inferBuiltinCapabilityPrior('google', 'gemini-2.5-flash')
  const unknown = inferBuiltinCapabilityPrior('custom', 'my-private-model')
  assert.equal(qwen.family, 'qwen-vl')
  assert.ok(qwen.scores.ocr > qwen.scores.general - 0.1)
  assert.equal(glm.family, 'glm-v')
  assert.equal(gemini.family, 'gemini')
  assert.equal(unknown.family, 'generic-vision')
  assert.equal(unknown.source, 'generic-prior')
  assert.ok(unknown.scores.general > 0)
})

test('measured capability dominates prior and explicit override wins last', () => {
  const profile = buildVisionCapabilityProfile({
    provider: 'custom',
    model: 'm',
    measured: { ocr: 0.95, grounding: 0.2 },
    override: { grounding: 0.99 },
  })
  assert.ok(profile.scores.ocr > 0.85)
  assert.equal(profile.scores.grounding, 0.99)
  assert.equal(profile.confidence.ocr, 0.9)
  assert.equal(profile.confidence.grounding, 1)
  assert.equal(profile.provenance.measured, true)
  assert.equal(profile.provenance.override, true)
})

test('quality strategy prefers stronger capability while speed can prefer a faster model', () => {
  const strong = buildVisionCapabilityProfile({
    provider: 'p',
    model: 'strong',
    measured: { ocr: 0.98 },
    latencyMs: 7000,
    cost: 0.6,
  })
  const fast = buildVisionCapabilityProfile({
    provider: 'p',
    model: 'fast',
    measured: { ocr: 0.78 },
    latencyMs: 300,
    cost: 0.2,
  })
  const qualityStrong = scoreVisionCandidate({ intent: 'ocr', profile: strong, strategy: 'quality' })
  const qualityFast = scoreVisionCandidate({ intent: 'ocr', profile: fast, strategy: 'quality' })
  assert.ok(qualityStrong.score > qualityFast.score)
  const speedStrong = scoreVisionCandidate({ intent: 'ocr', profile: strong, strategy: 'speed' })
  const speedFast = scoreVisionCandidate({ intent: 'ocr', profile: fast, strategy: 'speed' })
  assert.ok(speedFast.score > speedStrong.score)
})

test('privacy strategy can route to a local model even when cloud capability is slightly higher', () => {
  const ranked = rankVisionCandidates({
    intent: 'general',
    strategy: 'privacy',
    candidates: [
      { provider: 'cloud', model: 'great', profile: buildVisionCapabilityProfile({ provider: 'cloud', model: 'great', measured: { general: 0.96 }, privacy: 'cloud', latencyMs: 600 }) },
      { provider: 'vision-http', model: 'local-ollama/qwen2.5vl', profile: buildVisionCapabilityProfile({ provider: 'vision-http', model: 'local-ollama/qwen2.5vl', measured: { general: 0.86 }, local: true, latencyMs: 900 }) },
    ],
  })
  assert.equal(ranked[0].provider, 'vision-http')
  assert.equal(ranked[0].profile.traits.local, true)
})

test('health state pushes circuit-open and rate-limited models to the bottom', () => {
  const candidates = [
    { provider: 'p', model: 'best', latencyMs: 500 },
    { provider: 'p', model: 'healthy', latencyMs: 700 },
  ]
  const ranked = rankVisionCandidates({
    intent: 'structured',
    candidates,
    measured: {
      'p/best': { structured: 1 },
      'p/healthy': { structured: 0.75 },
    },
    health: {
      'p/best': { circuitOpen: true },
      'p/healthy': { recentSuccess: true },
    },
  })
  assert.equal(ranked[0].key, 'p/healthy')
  assert.equal(ranked[1].components.health, 0)
})

test('ranking is per-intent: the same pool can choose different specialists', () => {
  const candidates = [
    { provider: 'p', model: 'reader' },
    { provider: 'p', model: 'locator' },
  ]
  const measured = {
    'p/reader': { ocr: 0.98, grounding: 0.45 },
    'p/locator': { ocr: 0.65, grounding: 0.97 },
  }
  const ocr = rankVisionCandidates({ intent: 'ocr', candidates, measured, strategy: 'quality' })
  const grounding = rankVisionCandidates({ intent: 'grounding', candidates, measured, strategy: 'quality' })
  assert.equal(ocr[0].key, 'p/reader')
  assert.equal(grounding[0].key, 'p/locator')
})

test('capability tags and route explanation are UI/diagnostics-ready', () => {
  const profile = buildVisionCapabilityProfile({
    provider: 'p',
    model: 'specialist',
    measured: { ocr: 0.99, document: 0.96, grounding: 0.4 },
  })
  const tags = visionCapabilityTags(profile, 0.85)
  assert.ok(tags.includes('ocr'))
  assert.ok(tags.includes('document'))
  assert.ok(!tags.includes('grounding'))

  const ranked = rankVisionCandidates({
    intent: 'ocr',
    strategy: 'balanced',
    candidates: [{ provider: 'p', model: 'specialist', profile }],
  })
  const explanation = explainVisionRoute(ranked)
  assert.deepEqual(explanation.map((x) => x.backend), ['p/specialist'])
  assert.equal(explanation[0].intent, 'ocr')
  assert.equal(typeof explanation[0].score, 'number')
})
