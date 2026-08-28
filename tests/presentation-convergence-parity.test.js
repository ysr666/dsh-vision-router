import test from 'node:test'
import assert from 'node:assert/strict'

import {
  VISION_PRESENTATION_DTO_REVISION,
  projectVisionBackgroundRuntime,
  projectVisionCandidateBackground,
  projectVisionProductCandidate,
} from '../lib/vision-product-presentation.js'
import { attachCapabilityBenchmarkPresentation } from '../lib/vision-capability-benchmark-presentation.js'

const MODES = ['off', 'local-free', 'all']
const SCORE_ORDER = ['structured', 'ocr', 'document', 'grounding', 'general']

function legacyBrowserBackgroundEligible(candidate, authorityOrBackground) {
  const background = Object.hasOwn(authorityOrBackground ?? {}, 'active')
    ? authorityOrBackground
    : {
        active: authorityOrBackground?.backgroundMeasurementActive,
        mode: authorityOrBackground?.backgroundMeasurement,
        excluded: [],
      }
  if (
    !background ||
    background.active !== true ||
    !candidate ||
    candidate.benchmarkable !== true ||
    (Array.isArray(background.excluded) && background.excluded.some((item) => item?.key === candidate.key))
  ) return false
  if (background.mode === 'all') return true
  if (background.mode !== 'local-free') return false
  return candidate.local === true || candidate.cloudCostWarning === false
}

function legacyCoverageOf(measured) {
  if (!measured) return []
  if (Array.isArray(measured.measuredAxes)) {
    return SCORE_ORDER.filter((axis) => measured.measuredAxes.includes(axis))
  }
  if (Array.isArray(measured.coverage)) {
    return SCORE_ORDER.filter((axis) => measured.coverage.includes(axis))
  }
  const scores = measured.scores || {}
  return SCORE_ORDER.filter((axis) => Number.isFinite(Number(scores[axis])))
}

function legacyBackgroundNeedsWork(candidate) {
  return !!candidate && legacyCoverageOf(candidate.measured).length < SCORE_ORDER.length
}

function itemForKey(rows, key) {
  return Array.isArray(rows) ? rows.find((item) => item?.key === key) : undefined
}

function legacyBrowserBackgroundState(candidate, background) {
  if (background?.running?.key === candidate?.key) return 'running'
  const excluded = itemForKey(background?.excluded, candidate?.key)
  if (excluded?.reason === 'measured-text-only') return 'measured-text-only'
  const deferred = itemForKey(background?.deferred, candidate?.key)
  if (deferred) return deferred.retryable === true ? 'deferred' : 'stopped'
  const eligible = legacyBrowserBackgroundEligible(candidate, background) && legacyBackgroundNeedsWork(candidate)
  if (candidate?.measured) return eligible ? 'measured-waiting' : 'measured'
  if (eligible) {
    if (background?.paused === true) return 'paused'
    if (candidate?.imageCapability === 'text-only') return 'awaiting-verification'
    return 'waiting'
  }
  if (candidate?.imageCapability === 'text-only') return 'declared-text-only'
  if (candidate?.benchmarkable !== true) return 'unavailable'
  if (background?.active === true && background?.mode === 'local-free') return 'policy-excluded'
  return 'not-measured'
}

function expectedCapabilityState(candidate) {
  if (candidate?.measured && typeof candidate.measured === 'object' && Object.keys(candidate.measured).length > 0) {
    return 'measured'
  }
  return candidate?.benchmarkable === true ? 'unmeasured' : 'unavailable'
}

test('C2-A Host projector preserves the compatibility browser base eligibility matrix exactly', () => {
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

test('C2-B runtime projection matches the capability-runtime public shape exactly', () => {
  const authority = {
    backgroundMeasurement: 'local-free',
    backgroundMeasurementActive: true,
  }
  const state = {
    activeForeground: 1,
    activeManualBenchmarks: 0,
    idleRemainingMs: 1234,
    running: {
      key: 'provider/model',
      axis: 'ocr',
      completed: 1,
      total: 2,
      elapsedMs: 90,
    },
    deferred: [{
      key: 'deferred/model',
      axis: 'general',
      errorClass: 'rate-limit',
      errorCode: 'RATE_LIMITED',
      retryable: true,
      until: 999,
    }],
    excluded: [{ key: 'text/model', reason: 'measured-text-only' }],
  }

  assert.deepEqual(
    JSON.parse(JSON.stringify(projectVisionBackgroundRuntime(state, authority))),
    {
      mode: 'local-free',
      active: true,
      paused: true,
      idleRemainingMs: 1234,
      running: {
        key: 'provider/model',
        axis: 'ocr',
        completed: 1,
        total: 2,
        elapsedMs: 90,
      },
      deferred: [{
        key: 'deferred/model',
        axis: 'general',
        errorClass: 'rate-limit',
        errorCode: 'RATE_LIMITED',
        retryable: true,
        until: 999,
      }],
      excluded: [{ key: 'text/model', reason: 'measured-text-only' }],
    },
  )
})

test('C2-B Host background state matches legacy render precedence where scheduler and browser agree', () => {
  const core = {
    DEFAULT_HTTP_PROVIDERS: [{
      name: 'ovh-free',
      model: 'vision',
      baseURL: 'https://free.example/v1',
      apiKeyEnv: '',
    }],
  }
  const baseBackground = {
    mode: 'all',
    active: true,
    paused: false,
    running: null,
    deferred: [],
    excluded: [],
  }
  const scenarios = [
    {
      name: 'running wins over measured and other background state',
      candidate: { key: 'p/m', benchmarkable: true, local: true, measured: { scores: { ocr: 1 } } },
      background: {
        ...baseBackground,
        running: { key: 'p/m', axis: 'ocr', completed: 1, total: 2 },
        excluded: [{ key: 'p/m', reason: 'measured-text-only' }],
        deferred: [{ key: 'p/m', retryable: true, errorClass: 'network' }],
      },
    },
    {
      name: 'measured text-only wins over deferred',
      candidate: { key: 'p/m', benchmarkable: true, local: true },
      background: {
        ...baseBackground,
        excluded: [{ key: 'p/m', reason: 'measured-text-only' }],
        deferred: [{ key: 'p/m', retryable: true, errorClass: 'network' }],
      },
    },
    {
      name: 'retryable deferred',
      candidate: { key: 'p/m', benchmarkable: true, local: true },
      background: {
        ...baseBackground,
        deferred: [{ key: 'p/m', retryable: true, errorClass: 'rate-limit' }],
      },
    },
    {
      name: 'nonretryable stopped',
      candidate: { key: 'p/m', benchmarkable: true, local: true },
      background: {
        ...baseBackground,
        deferred: [{ key: 'p/m', retryable: false, errorClass: 'auth' }],
      },
    },
    {
      name: 'partial measured waiting',
      candidate: { key: 'p/m', benchmarkable: true, local: true, measured: { scores: { ocr: 1 } } },
      background: baseBackground,
    },
    {
      name: 'complete measured',
      candidate: {
        key: 'p/m',
        benchmarkable: true,
        local: true,
        measured: { scores: Object.fromEntries(SCORE_ORDER.map((axis) => [axis, 1])) },
      },
      background: baseBackground,
    },
    {
      name: 'paused eligible candidate',
      candidate: { key: 'p/m', benchmarkable: true, local: true },
      background: { ...baseBackground, paused: true },
    },
    {
      name: 'declared text-only still awaits actual verification when eligible',
      candidate: { key: 'p/m', benchmarkable: true, local: true, imageCapability: 'text-only' },
      background: baseBackground,
    },
    {
      name: 'benchmark unavailable',
      candidate: { key: 'p/m', benchmarkable: false, local: true },
      background: baseBackground,
    },
    {
      name: 'paid cloud local-free policy exclusion',
      candidate: { key: 'p/m', benchmarkable: true, local: false, cloudCostWarning: true },
      background: { ...baseBackground, mode: 'local-free' },
    },
    {
      name: 'trusted built-in free route is eligible under local-free',
      candidate: {
        key: 'http:ovh-free/vision',
        provider: 'vision-http',
        model: 'ovh-free/vision',
        endpoint: 'https://free.example/v1',
        benchmarkable: true,
        local: false,
        cloudCostWarning: false,
        routeRole: 'user',
      },
      background: { ...baseBackground, mode: 'local-free' },
    },
    {
      name: 'background off remains not measured',
      candidate: { key: 'p/m', benchmarkable: true, local: true },
      background: { ...baseBackground, mode: 'off', active: false },
    },
  ]

  for (const scenario of scenarios) {
    const actual = projectVisionCandidateBackground(scenario.candidate, scenario.background, core)
    assert.equal(
      actual.state,
      legacyBrowserBackgroundState(scenario.candidate, scenario.background),
      scenario.name,
    )
  }
})

test('C2-B records intentional legacy UI correction for untrusted zero-cost remote routes', () => {
  const candidate = {
    key: 'http:ovh-custom/vision',
    provider: 'vision-http',
    model: 'ovh-custom/vision',
    endpoint: 'https://custom.example/v1',
    benchmarkable: true,
    local: false,
    cost: 0,
    cloudCostWarning: false,
    routeRole: 'user',
  }
  const background = {
    mode: 'local-free',
    active: true,
    paused: false,
    running: null,
    deferred: [],
    excluded: [],
  }

  assert.equal(legacyBrowserBackgroundState(candidate, background), 'waiting')
  const host = projectVisionCandidateBackground(candidate, background, { DEFAULT_HTTP_PROVIDERS: [] })
  assert.equal(host.state, 'policy-excluded')
  assert.equal(host.policyEligible, false)
  assert.equal(host.reason, 'local-free-policy-excludes-route')
})

test('C2-B records intentional legacy UI correction for fallback-only routes', () => {
  const candidate = {
    key: 'http:fallback/vision',
    provider: 'vision-http',
    model: 'fallback/vision',
    endpoint: 'https://fallback.example/v1',
    benchmarkable: true,
    local: false,
    cloudCostWarning: true,
    routeRole: 'fallback-only',
  }
  const background = {
    mode: 'all',
    active: true,
    paused: false,
    running: null,
    deferred: [],
    excluded: [],
  }

  assert.equal(legacyBrowserBackgroundState(candidate, background), 'waiting')
  const host = projectVisionCandidateBackground(candidate, background, { DEFAULT_HTTP_PROVIDERS: [] })
  assert.equal(host.state, 'not-measured')
  assert.equal(host.policyEligible, false)
  assert.equal(host.reason, 'fallback-only-route')
})

test('C2-B benchmark snapshot adds runtime DTO without replacing legacy candidate fields', async () => {
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
    store: {
      backgroundProfiler: {
        snapshot() {
          return {
            activeForeground: 1,
            activeManualBenchmarks: 0,
            idleRemainingMs: 750,
            running: undefined,
            deferred: [],
            excluded: [],
          }
        },
      },
    },
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
  assert.equal(snapshot.background.mode, 'local-free')
  assert.equal(snapshot.background.active, true)
  assert.equal(snapshot.background.paused, true)
  assert.equal(snapshot.background.idleRemainingMs, 750)
  assert.equal(snapshot.candidates.length, 1)
  assert.equal(snapshot.candidates[0].fingerprint, originalCandidate.fingerprint)
  assert.deepEqual(snapshot.candidates[0].measured, originalCandidate.measured)

  const presentation = snapshot.candidates[0].presentation
  assert.equal(presentation.canBenchmark, true)
  assert.equal(presentation.capabilityState, 'measured')
  assert.equal(presentation.backgroundEligible, true)
  assert.equal(presentation.healthClass, 'rate-limited')
  assert.equal(presentation.background.state, 'measured')
  assert.equal(presentation.background.policyEligible, false)
  assert.equal(presentation.background.reason, 'local-free-policy-excludes-route')
  assert.equal(Object.hasOwn(presentation, 'fingerprint'), false)
  assert.equal(Object.hasOwn(presentation, 'protocol'), false)
  assert.equal(Object.hasOwn(presentation, 'endpoint'), false)
})

test('C2-B presentation and runtime state read live Host authority on every snapshot', async () => {
  const live = {
    routingMode: 'ordered',
    backgroundBenchmarking: 'off',
  }
  const manager = {
    store: {
      backgroundProfiler: {
        snapshot() {
          return {
            activeForeground: 0,
            activeManualBenchmarks: 0,
            idleRemainingMs: 0,
            deferred: [],
            excluded: [],
          }
        },
      },
    },
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
  assert.equal(before.background.mode, 'off')
  assert.equal(before.background.active, false)
  assert.equal(before.candidates[0].presentation.backgroundEligible, false)
  assert.equal(before.candidates[0].presentation.background.state, 'not-measured')

  live.routingMode = 'auto'
  live.backgroundBenchmarking = 'all'
  const after = await manager.snapshot()
  assert.equal(after.routingMode, 'auto')
  assert.equal(after.background.mode, 'all')
  assert.equal(after.background.active, true)
  assert.equal(after.candidates[0].presentation.backgroundEligible, true)
  assert.equal(after.candidates[0].presentation.background.state, 'waiting')
})
