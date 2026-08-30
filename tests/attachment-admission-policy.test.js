import test from 'node:test'
import assert from 'node:assert/strict'

import { ensureVisionAttachmentAdmissionPolicy } from '../lib/dsh-contract-compat.js'

const legacyLimits = (overrides = {}) => Object.freeze({
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100 * 1024 * 1024,
  maxImagePixels: 100_000_000,
  maxImageDimension: 2000,
  mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  ...overrides,
})

const alphaNormalizationDefaults = (overrides = {}) => Object.freeze({
  maxPixels: 2048 * 2048,
  maxDimension: 8192,
  maxBytes: 4 * 1024 * 1024,
  ...overrides,
})

function contextFor(store) {
  return {
    get(name) {
      return name === 'attachments' ? store : undefined
    },
  }
}

test('repairs the historical Vision Router 20MiB/100MP overlay on rc8 limits', () => {
  const store = { imageLimits: legacyLimits() }
  const logs = []
  const result = ensureVisionAttachmentAdmissionPolicy(contextFor(store), {
    info(...args) { logs.push(args) },
  })

  assert.equal(result.changed, true)
  assert.equal(result.reason, 'legacy-overlay-repaired')
  assert.equal(store.imageLimits.maxImageDimension, 10_000)
  assert.equal(store.imageLimits.maxImageBytes, 20 * 1024 * 1024)
  assert.equal(store.imageLimits.maxImagePixels, 100_000_000)
  assert.equal(Object.isFrozen(store.imageLimits), true)
  assert.equal(logs.length, 1)
})

test('repairs a stale pre-alpha DVR profile after alpha materializes its new defaults', () => {
  const store = {
    // A historical profile row contains only the 20MiB/100MP DVR pair. On
    // alpha the omitted dimensions/policy materialize as these Host defaults.
    imageLimits: legacyLimits({ maxImageDimension: 8192 }),
    normalizationPolicy: alphaNormalizationDefaults(),
  }
  const result = ensureVisionAttachmentAdmissionPolicy(contextFor(store))

  assert.equal(result.changed, true)
  assert.equal(result.reason, 'legacy-alpha-policy-repaired')
  assert.equal(store.imageLimits.maxImageDimension, 10_000)
  assert.deepEqual(store.normalizationPolicy, {
    maxPixels: 100_000_000,
    maxDimension: 10_000,
    maxBytes: 20 * 1024 * 1024,
  })
  assert.equal(Object.isFrozen(store.normalizationPolicy), true)
})

test('does not reinterpret an explicit 10000px admission as a stale alpha profile', () => {
  const limits = legacyLimits({ maxImageDimension: 10_000 })
  const normalizationPolicy = alphaNormalizationDefaults()
  const store = { imageLimits: limits, normalizationPolicy }
  const result = ensureVisionAttachmentAdmissionPolicy(contextFor(store))

  assert.equal(result.changed, false)
  assert.equal(result.reason, 'not-legacy-overlay')
  assert.equal(store.imageLimits, limits)
  assert.equal(store.normalizationPolicy, normalizationPolicy)
})

test('does not overwrite an explicit deployment dimension', () => {
  for (const dimension of [4096, 10_000, 16_384]) {
    const original = legacyLimits({ maxImageDimension: dimension })
    const normalizationPolicy = alphaNormalizationDefaults()
    const store = { imageLimits: original, normalizationPolicy }
    const result = ensureVisionAttachmentAdmissionPolicy(contextFor(store))
    assert.equal(result.changed, false)
    assert.equal(result.reason, 'not-legacy-overlay')
    assert.equal(store.imageLimits, original)
    assert.equal(store.normalizationPolicy, normalizationPolicy)
  }
})

test('does not overwrite any explicit alpha normalization tuple', () => {
  for (const normalizationPolicy of [
    alphaNormalizationDefaults({ maxPixels: 12_000_000 }),
    alphaNormalizationDefaults({ maxDimension: 4096 }),
    alphaNormalizationDefaults({ maxBytes: 8 * 1024 * 1024 }),
    Object.freeze({ maxPixels: 100_000_000, maxDimension: 10_000, maxBytes: 20 * 1024 * 1024 }),
  ]) {
    const limits = legacyLimits({ maxImageDimension: 8192 })
    const store = { imageLimits: limits, normalizationPolicy }
    const result = ensureVisionAttachmentAdmissionPolicy(contextFor(store))
    assert.equal(result.changed, false)
    assert.equal(result.reason, 'not-legacy-overlay')
    assert.equal(store.imageLimits, limits)
    assert.equal(store.normalizationPolicy, normalizationPolicy)
  }
})

test('does not claim unrelated attachment policies that happen to use Host defaults', () => {
  for (const overrides of [
    { maxImageBytes: 3.5 * 1024 * 1024 },
    { maxImagePixels: 40_000_000 },
  ]) {
    const original = legacyLimits({ maxImageDimension: 8192, ...overrides })
    const normalizationPolicy = alphaNormalizationDefaults()
    const store = { imageLimits: original, normalizationPolicy }
    const result = ensureVisionAttachmentAdmissionPolicy(contextFor(store))
    assert.equal(result.changed, false)
    assert.equal(result.reason, 'not-legacy-overlay')
    assert.equal(store.imageLimits, original)
    assert.equal(store.normalizationPolicy, normalizationPolicy)
  }
})

test('fails open when the Host exposes a read-only admission limits property', () => {
  const store = {}
  Object.defineProperty(store, 'imageLimits', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: legacyLimits(),
  })
  const warnings = []
  const result = ensureVisionAttachmentAdmissionPolicy(contextFor(store), {
    warn(...args) { warnings.push(args) },
  })

  assert.equal(result.changed, false)
  assert.equal(result.reason, 'limits-readonly')
  assert.equal(store.imageLimits.maxImageDimension, 2000)
  assert.equal(warnings.length, 1)
})

test('reports a read-only alpha normalization policy instead of claiming full repair', () => {
  const store = {
    imageLimits: legacyLimits({ maxImageDimension: 8192 }),
  }
  const original = alphaNormalizationDefaults()
  Object.defineProperty(store, 'normalizationPolicy', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: original,
  })
  const warnings = []
  const result = ensureVisionAttachmentAdmissionPolicy(contextFor(store), {
    warn(...args) { warnings.push(args) },
  })

  assert.equal(result.changed, true)
  assert.equal(result.reason, 'normalization-policy-readonly')
  assert.equal(store.imageLimits.maxImageDimension, 10_000)
  assert.equal(store.normalizationPolicy, original)
  assert.equal(warnings.length, 1)
})

test('custom migration targets remain opt-in and bounded by the historical fingerprint', () => {
  const store = {
    imageLimits: legacyLimits({ maxImageDimension: 8192 }),
    normalizationPolicy: alphaNormalizationDefaults(),
  }
  const result = ensureVisionAttachmentAdmissionPolicy(contextFor(store), undefined, {
    maxImageDimension: 9000,
    normalizedImageMaxPixels: 80_000_000,
    normalizedImageMaxDimension: 9000,
    normalizedImageMaxBytes: 16 * 1024 * 1024,
  })
  assert.equal(result.changed, true)
  assert.equal(store.imageLimits.maxImageDimension, 9000)
  assert.deepEqual(store.normalizationPolicy, {
    maxPixels: 80_000_000,
    maxDimension: 9000,
    maxBytes: 16 * 1024 * 1024,
  })
})

test('is inert when no attachment limits service exists', () => {
  assert.deepEqual(
    ensureVisionAttachmentAdmissionPolicy({ get() { return undefined } }),
    { changed: false, reason: 'attachment-limits-unavailable' },
  )
})
