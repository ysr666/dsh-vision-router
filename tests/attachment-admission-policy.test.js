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

test('does not overwrite an explicit deployment dimension', () => {
  for (const dimension of [4096, 10_000, 16_384]) {
    const original = legacyLimits({ maxImageDimension: dimension })
    const store = { imageLimits: original }
    const result = ensureVisionAttachmentAdmissionPolicy(contextFor(store))
    assert.equal(result.changed, false)
    assert.equal(result.reason, 'not-legacy-overlay')
    assert.equal(store.imageLimits, original)
  }
})

test('does not claim unrelated attachment policies that happen to use 2000px', () => {
  for (const overrides of [
    { maxImageBytes: 3.5 * 1024 * 1024 },
    { maxImagePixels: 40_000_000 },
  ]) {
    const original = legacyLimits(overrides)
    const store = { imageLimits: original }
    const result = ensureVisionAttachmentAdmissionPolicy(contextFor(store))
    assert.equal(result.changed, false)
    assert.equal(result.reason, 'not-legacy-overlay')
    assert.equal(store.imageLimits, original)
  }
})

test('fails open when the Host exposes a read-only limits property', () => {
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

test('is inert when no attachment limits service exists', () => {
  assert.deepEqual(
    ensureVisionAttachmentAdmissionPolicy({ get() { return undefined } }),
    { changed: false, reason: 'attachment-limits-unavailable' },
  )
})
