import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveSessionSurfacePolicy } from '../lib/session-surface-policy.js'

function config(overrides = {}) {
  return {
    tool: true,
    rewriteImages: true,
    instantDescribe: true,
    autoActivateOnImage: true,
    structuredVisionBootstrap: true,
    routing: false,
    ...overrides,
  }
}

function visionPolicy(ownership, overrides = {}) {
  const native = ownership === 'native-image'
  const pluginOwned = ownership === 'vision-router-owned'
  const textOnly = ownership === 'text-only'
  return {
    ownership,
    preserveRawImages: native || pluginOwned || ownership === 'unknown',
    // Keep the historical producer shape in the fixture: the surface policy
    // must ignore this legacy grant rather than depending on every caller being
    // migrated in lock-step.
    rewriteCurrentImages: textOnly,
    suppressGenericAutoMount: native,
    allowStructuredBootstrap: !native,
    ...overrides,
  }
}

test('native session preserves pixels, suppresses automatic orchestration, but keeps explicit tools available', () => {
  const policy = resolveSessionSurfacePolicy({
    visionPolicy: visionPolicy('native-image'),
    config: config(),
  })

  assert.equal(policy.ownership, 'native-image')
  assert.equal(policy.preserveRawImages, true)
  assert.equal(policy.rewriteCurrentImages, false)
  assert.equal(policy.allowStructuredBootstrap, false)
  assert.equal(policy.allowGenericAutoMount, false)
  assert.deepEqual(policy.surface, {
    preserveRawImages: true,
    rewriteCurrentImages: false,
    visionTools: true,
    structuredBootstrap: false,
    genericAutoMount: false,
    instantDescribe: false,
  })
  assert.deepEqual(policy.legacyConfigOverrides, {
    rewriteImages: false,
    instantDescribe: false,
    autoActivateOnImage: false,
    structuredVisionBootstrap: false,
  })
})

test('Vision Router-owned session preserves pixels while retaining Router orchestration surface', () => {
  const policy = resolveSessionSurfacePolicy({
    visionPolicy: visionPolicy('vision-router-owned'),
    config: config(),
  })

  assert.equal(policy.ownership, 'vision-router-owned')
  assert.equal(policy.participates, true)
  assert.deepEqual(policy.surface, {
    preserveRawImages: true,
    rewriteCurrentImages: false,
    visionTools: true,
    structuredBootstrap: true,
    genericAutoMount: true,
    instantDescribe: true,
  })
  assert.deepEqual(policy.legacyConfigOverrides, { rewriteImages: false })
})

test('text-only session preserves the durable image and disables Core pre-step rewriting', () => {
  const policy = resolveSessionSurfacePolicy({
    visionPolicy: visionPolicy('text-only'),
    config: config(),
  })

  assert.equal(policy.ownership, 'text-only')
  assert.equal(policy.preserveRawImages, true)
  assert.equal(policy.rewriteCurrentImages, false)
  assert.equal(policy.surface.preserveRawImages, true)
  assert.equal(policy.surface.rewriteCurrentImages, false)
  assert.equal(policy.surface.structuredBootstrap, true)
  assert.equal(policy.surface.genericAutoMount, true)
  assert.deepEqual(policy.legacyConfigOverrides, { rewriteImages: false })
})

test('legacy rewriteCurrentImages evidence can never grant a destructive transcript rewrite', () => {
  const policy = resolveSessionSurfacePolicy({
    visionPolicy: visionPolicy('text-only', {
      preserveRawImages: false,
      rewriteCurrentImages: true,
    }),
    config: config({ rewriteImages: true }),
  })

  assert.equal(policy.preserveRawImages, true)
  assert.equal(policy.rewriteCurrentImages, false)
  assert.equal(policy.surface.rewriteCurrentImages, false)
  assert.equal(policy.legacyConfigOverrides.rewriteImages, false)
})

test('explicit UNKNOWN session remains non-destructive without being misclassified as text-only', () => {
  const policy = resolveSessionSurfacePolicy({
    visionPolicy: visionPolicy('unknown'),
    config: config(),
  })

  assert.equal(policy.ownership, 'unknown')
  assert.equal(policy.preserveRawImages, true)
  assert.equal(policy.rewriteCurrentImages, false)
  assert.equal(policy.surface.visionTools, true)
  assert.equal(policy.surface.structuredBootstrap, true)
  assert.deepEqual(policy.legacyConfigOverrides, { rewriteImages: false })
})

test('absence of a session policy never invents UNKNOWN non-intervention authority', () => {
  const policy = resolveSessionSurfacePolicy({
    config: config(),
  })

  assert.equal(policy.ownership, undefined)
  assert.equal(policy.participates, false)
  assert.equal(policy.preserveRawImages, false)
  assert.equal(policy.rewriteCurrentImages, false)
  assert.deepEqual(policy.legacyConfigOverrides, {})
})

test('schema bootstrap may expose definitions without granting live tool execution', () => {
  const policy = resolveSessionSurfacePolicy({
    visionPolicy: visionPolicy('native-image'),
    config: config({ tool: false }),
    schemaBootstrapping: true,
  })

  assert.equal(policy.surface.visionTools, false)
  assert.equal(policy.legacyConfigOverrides.tool, true)
  assert.equal(policy.legacyConfigOverrides.structuredVisionBootstrap, false)
})

test('explicit user-off settings remain off and are never expanded by the surface policy', () => {
  const policy = resolveSessionSurfacePolicy({
    visionPolicy: visionPolicy('text-only', { rewriteCurrentImages: false }),
    config: config({
      tool: false,
      rewriteImages: false,
      instantDescribe: false,
      autoActivateOnImage: false,
      structuredVisionBootstrap: false,
    }),
  })

  assert.deepEqual(policy.surface, {
    preserveRawImages: true,
    rewriteCurrentImages: false,
    visionTools: false,
    structuredBootstrap: false,
    genericAutoMount: false,
    instantDescribe: false,
  })
  assert.deepEqual(policy.legacyConfigOverrides, {})
})

test('surface snapshots and nested capability objects are immutable', () => {
  const policy = resolveSessionSurfacePolicy({
    visionPolicy: visionPolicy('native-image'),
    config: config(),
  })

  assert.equal(Object.isFrozen(policy), true)
  assert.equal(Object.isFrozen(policy.surface), true)
  assert.equal(Object.isFrozen(policy.legacyConfigOverrides), true)
})
