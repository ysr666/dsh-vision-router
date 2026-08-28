import test from 'node:test'
import assert from 'node:assert/strict'

import {
  VISION_PRESENTATION_DTO_REVISION,
  projectVisionProductCandidate,
} from '../lib/vision-product-presentation.js'
import { attachCapabilityBenchmarkPresentation } from '../lib/vision-capability-benchmark-presentation.js'

const MODES = ['off', 'local-free', 'all']

function legacyBrowserBackgroundEligible(candidate, authority) {
  const background = {
    active: authority.backgroundMeasurementActive,
    mode: authority.backgroundMeasurement,
    excluded: [],
  }
  if (
    !background ||
    background.active !== true ||
    !candidate ||
    candidate.benchmarkable !== true ||
    background.excluded.some((item) => item?.key === candidate.key)
  ) return false
  if (background.mode === 'all') return true
  if (background.mode !== 'local-free') return false
  return candidate.local === true || candidate.cloudCostWarning === false
}

function expectedCapabilityState(candidate) {
  if (candidate?.measured && typeof candidate.measured === 'object' && Object.keys(candidate.measured).length > 0) {
    return 'measured'
  }
  return candidate?.benchmarkable === true ? 'unmeasured' : 'unavailable'
}

test('C2-A Host projector matches the legacy browser base eligibility matrix exactly', () => {
  for (const benchmarkable of [false, true]) {
    for (const local of [false, true]) {
      for (const cost of [0, 1]) {
        for (const measured of [undefined, { scores: { ocr: 0.8 } }]) {
          for (const backgroundMeasurement of MODES) {
            for (const backgroundMeasurementActive of [false, true]) {
              const authority = {
                execution: 'ordered',
                autoSelectionAuthorized: false,
                backgroundMeasurement,
                backgroundMeasurementAuthorized: backgroundMeasurement !== 'off',
                backgroundMeasurementActive,
              }
              const raw = {
                key: 'provider/model',
                provider: 'provider',
                model: 'model',
                benchmarkable,
                local,
                cost,
                measured,
              }
              const sanitized = {
                key: raw.key,
                provider: raw.provider,
                model: raw.model,
                benchmarkable,
                local,
                cloudCostWarning: local !== true && cost !== 0,
                measured,
              }
              const projectedRaw = projectVisionProductCandidate(raw, undefined, authority)
              const projectedSanitized = projectVisionProductCandidate(sanitized, undefined, authority)

              assert.equal(projectedRaw.canBenchmark, benchmarkable)
              assert.equal(projectedRaw.capabilityState, expectedCapabilityState(raw))
              assert.equal(
                projectedRaw.backgroundEligible,
                legacyBrowserBackgroundEligible(sanitized, authority),
                JSON.stringify({ benchmarkable, local, cost, backgroundMeasurement, backgroundMeasurementActive }),
              )
              assert.deepEqual(projectedSanitized, projectedRaw)
            }
          }
        }
      }
    }
  }
})

test('C2-A benchmark snapshot adds a versioned DTO without replacing legacy candidate fields', async () => {
  const live = {
    routingMode: 'auto',
    backgroundBenchmarking: 'local-free',
  }
  const originalCandidate = {
    key: 'http:free/model',
    provider: 'vision-http',
    model: 'free/model',
    local: false,
    cloudCostWarning: false,
    benchmarkable: true,
    evidenceScope: 'endpoint',
    protocol: 'openai-completions',
    fingerprint: 'transport-fingerprint-stays-on-legacy-snapshot',
    imageCapability: 'declared',
    measured: { scores: { ocr: 0.9 }, measuredAxes: ['ocr'] },
  }
  const manager = {
    store: {},
    async snapshot() {
      return {
        ok: true,
        suiteRevision: 3,
        queueLength: 0,
        candidates: [originalCandidate],
        jobs: [],
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'settings') return { get: () => live }
      return undefined
    },
    llm: { listProviders: () => [] },
  }

  attachCapabilityBenchmarkPresentation(manager, {
    ctx,
    config: {},
    core: {
      localProvidersOf: () => [],
      httpProvidersOf: () => [],
      DEFAULT_HTTP_PROVIDERS: [],
    },
    healthForCandidate: async () => ({ circuitOpen: true, rateLimited: true }),
  })
  attachCapabilityBenchmarkPresentation(manager, { ctx })

  const snapshot = await manager.snapshot()
  assert.equal(snapshot.presentationRevision, VISION_PRESENTATION_DTO_REVISION)
  assert.equal(snapshot.routingMode, 'auto')
  assert.equal(snapshot.currentAuthority.execution, 'auto')
  assert.equal(snapshot.candidates.length, 1)
  assert.equal(snapshot.candidates[0].fingerprint, originalCandidate.fingerprint)
  assert.deepEqual(snapshot.candidates[0].measured, originalCandidate.measured)

  const presentation = snapshot.candidates[0].presentation
  assert.equal(presentation.canBenchmark, true)
  assert.equal(presentation.capabilityState, 'measured')
  assert.equal(presentation.backgroundEligible, true)
  assert.equal(presentation.healthClass, 'rate-limited')
  assert.equal(Object.hasOwn(presentation, 'fingerprint'), false)
  assert.equal(Object.hasOwn(presentation, 'protocol'), false)
  assert.equal(Object.hasOwn(presentation, 'endpoint'), false)
})

test('C2-A presentation reads live Host authority on every snapshot', async () => {
  const live = {
    routingMode: 'ordered',
    backgroundBenchmarking: 'off',
  }
  const manager = {
    store: {},
    async snapshot() {
      return {
        ok: true,
        candidates: [{
          key: 'local/model',
          provider: 'local',
          model: 'model',
          local: true,
          cloudCostWarning: false,
          benchmarkable: true,
        }],
        jobs: [],
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'settings') return { get: () => live }
      return undefined
    },
    llm: { listProviders: () => [] },
  }

  attachCapabilityBenchmarkPresentation(manager, {
    ctx,
    core: {
      localProvidersOf: () => [],
      httpProvidersOf: () => [],
      DEFAULT_HTTP_PROVIDERS: [],
    },
  })

  const before = await manager.snapshot()
  assert.equal(before.routingMode, 'ordered')
  assert.equal(before.candidates[0].presentation.backgroundEligible, false)

  live.routingMode = 'auto'
  live.backgroundBenchmarking = 'all'
  const after = await manager.snapshot()
  assert.equal(after.routingMode, 'auto')
  assert.equal(after.candidates[0].presentation.backgroundEligible, true)
})
