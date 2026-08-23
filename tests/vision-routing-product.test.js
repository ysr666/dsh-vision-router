import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VISION_ROUTING_MODES,
  VISION_ROUTING_PREFERENCES,
  normalizeVisionRoutingMode,
  normalizeVisionRoutingPreference,
  routingPreferenceToCapabilityStrategy,
  resolveVisionRoutingProduct,
} from '../lib/vision-routing-product.js'
import {
  normalizeBackgroundMeasurementAuthority,
  resolveVisionRoutingAuthority,
} from '../lib/vision-routing-authority.js'
import { normalizeRuntimeVisionConfig } from '../lib/runtime-config-normalizer.js'

test('product vocabulary is auto/ordered plus plain-language preferences', () => {
  assert.deepEqual(VISION_ROUTING_MODES, ['ordered', 'auto'])
  assert.deepEqual(VISION_ROUTING_PREFERENCES, ['balanced', 'quality', 'speed', 'local'])
  assert.equal(normalizeVisionRoutingMode('auto'), 'auto')
  assert.equal(normalizeVisionRoutingMode('v2'), 'ordered')
  assert.equal(normalizeVisionRoutingPreference('local'), 'local')
  assert.equal(normalizeVisionRoutingPreference('privacy'), 'balanced')
})

test('legacy privacy strategy maps to user-facing local preference only as compatibility input', () => {
  assert.equal(normalizeVisionRoutingPreference(undefined, 'privacy'), 'local')
  assert.equal(normalizeVisionRoutingPreference(undefined, 'quality'), 'quality')
  assert.equal(routingPreferenceToCapabilityStrategy('local'), 'privacy')
  assert.equal(routingPreferenceToCapabilityStrategy('quality'), 'quality')
})

test('current draft defaults to ordered without pretending auto execution is active', () => {
  assert.deepEqual(resolveVisionRoutingProduct({}), {
    mode: 'ordered',
    preference: 'balanced',
    strategy: 'balanced',
    automatic: false,
  })
  assert.deepEqual(resolveVisionRoutingProduct({ routingMode: 'auto', routingPreference: 'local' }), {
    mode: 'auto',
    preference: 'local',
    strategy: 'privacy',
    automatic: true,
  })
})

test('routing authority fails closed and does not infer measurement from Auto', () => {
  assert.equal(normalizeBackgroundMeasurementAuthority(undefined), 'off')
  assert.equal(normalizeBackgroundMeasurementAuthority('unexpected'), 'off')
  assert.deepEqual(resolveVisionRoutingAuthority({}), {
    execution: 'ordered',
    autoSelectionAuthorized: false,
    backgroundMeasurement: 'off',
    backgroundMeasurementAuthorized: false,
    backgroundMeasurementActive: false,
    ephemeralRuntimeObservation: false,
    persistentLearning: false,
  })
  assert.deepEqual(resolveVisionRoutingAuthority({ routingMode: 'auto' }), {
    execution: 'auto',
    autoSelectionAuthorized: true,
    backgroundMeasurement: 'off',
    backgroundMeasurementAuthorized: false,
    backgroundMeasurementActive: false,
    ephemeralRuntimeObservation: true,
    persistentLearning: false,
  })
  const measurementOnly = resolveVisionRoutingAuthority({
    routingMode: 'ordered',
    backgroundBenchmarking: 'all',
  })
  assert.equal(measurementOnly.autoSelectionAuthorized, false)
  assert.equal(measurementOnly.backgroundMeasurementAuthorized, true)
  assert.equal(measurementOnly.backgroundMeasurementActive, false)
})

test('explicit background authority activates only alongside Auto preparation', () => {
  const local = resolveVisionRoutingAuthority({
    routingMode: 'auto',
    backgroundBenchmarking: 'local-free',
  })
  assert.equal(local.backgroundMeasurement, 'local-free')
  assert.equal(local.backgroundMeasurementAuthorized, true)
  assert.equal(local.backgroundMeasurementActive, true)

  const all = resolveVisionRoutingAuthority({
    routingMode: 'auto',
    backgroundBenchmarking: 'all',
  })
  assert.equal(all.backgroundMeasurement, 'all')
  assert.equal(all.backgroundMeasurementActive, true)
})

test('runtime normalization bounds product fields and preserves configured provider order', () => {
  const normalized = normalizeRuntimeVisionConfig({
    routingMode: 'auto',
    routingPreference: 'local',
    providers: [
      { provider: 'first', model: 'a', fallbacks: ['a2'] },
      { provider: 'second', model: 'b', fallbacks: [] },
    ],
  })
  assert.equal(normalized.routingMode, 'auto')
  assert.equal(normalized.routingPreference, 'local')
  assert.deepEqual(normalized.providers.map((row) => row.provider), ['first', 'second'])
})
