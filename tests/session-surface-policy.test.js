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

function mode(enabled) {
  return { enabled, reason: enabled ? 'vision-router-route' : 'ordinary-route' }
}

test('native session preserves pixels but Vision Router stays off on the ordinary route', () => {
  const policy = resolveSessionSurfacePolicy({
    visionPolicy: visionPolicy('native-image'),
    config: config(),
  })

  assert.equal(policy.ownership, 'native-image')
  assert.equal(policy.visionModeEnabled, false)
  assert.equal(policy.preserveRawImages, true)
  assert.equal(policy.rewriteCurrentImages, false)
  assert.equal(policy.allowStructuredBootstrap, false)
  assert.equal(policy.allowGenericAutoMount, false)
  assert.deepEqual(policy.surface, {
    preserveRawImages: true,
    rewriteCurrentImages: false,
    visionTools: false,
    structuredBootstrap: false,
    genericAutoMount: false,
    instantDescribe: false,
  })
  assert.deepEqual(policy.legacyConfigOverrides, {
    rewriteImages: false,
    tool: false,
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
  assert.equal(policy.visionModeEnabled, true)
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

test('text-only session preserves the durable image while the plugin mode stays off', () => {
  const policy = resolveSessionSurfacePolicy({
    visionPolicy: visionPolicy('text-only'),
    config: config(),
  })

  assert.equal(policy.ownership, 'text-only')
  assert.equal(policy.visionModeEnabled, false)
  assert.equal(policy.preserveRawImages, true)
  assert.equal(policy.rewriteCurrentImages, false)
  assert.deepEqual(policy.surface, {
    preserveRawImages: true,
    rewriteCurrentImages: false,
    visionTools: false,
    structuredBootstrap: false,
    genericAutoMount: false,
    instantDescribe: false,
  })
  assert.deepEqual(policy.legacyConfigOverrides, {
    rewriteImages: false,
    tool: false,
    instantDescribe: false,
    autoActivateOnImage: false,
    structuredVisionBootstrap: false,
  })
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

test('explicit UNKNOWN session preserves pixels but cannot invent Vision-mode authority', () => {
  const policy = resolveSessionSurfacePolicy({
    visionPolicy: visionPolicy('unknown'),
    config: config(),
  })

  assert.equal(policy.ownership, 'unknown')
  assert.equal(policy.visionModeEnabled, false)
  assert.equal(policy.preserveRawImages, true)
  assert.equal(policy.rewriteCurrentImages, false)
  assert.equal(policy.surface.visionTools, false)
  assert.equal(policy.surface.structuredBootstrap, false)
  assert.deepEqual(policy.legacyConfigOverrides, {
    rewriteImages: false,
    tool: false,
    instantDescribe: false,
    autoActivateOnImage: false,
    structuredVisionBootstrap: false,
  })
})

test('explicit mode snapshot beats stale native ownership when Vision was just turned on', () => {
  const policy = resolveSessionSurfacePolicy({
    visionPolicy: visionPolicy('native-image'),
    visionModeAuthority: mode(true),
    config: config(),
  })

  assert.equal(policy.ownership, 'native-image', 'image capability evidence may still describe the previous request')
  assert.equal(policy.visionModeEnabled, true)
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

test('explicit OFF snapshot beats stale wrapper ownership after the composer toggles off', () => {
  const policy = resolveSessionSurfacePolicy({
    visionPolicy: visionPolicy('vision-router-owned'),
    visionModeAuthority: mode(false),
    config: config(),
  })

  assert.equal(policy.ownership, 'vision-router-owned')
  assert.equal(policy.visionModeEnabled, false)
  assert.equal(policy.surface.visionTools, false)
  assert.equal(policy.surface.structuredBootstrap, false)
  assert.equal(policy.surface.genericAutoMount, false)
  assert.equal(policy.surface.instantDescribe, false)
})

test('absence of a session policy keeps boot-time config semantics without inventing Session authority', () => {
  const policy = resolveSessionSurfacePolicy({
    config: config(),
  })

  assert.equal(policy.ownership, undefined)
  assert.equal(policy.visionModeEnabled, true)
  assert.equal(policy.participates, false)
  assert.equal(policy.preserveRawImages, false)
  assert.equal(policy.rewriteCurrentImages, false)
  assert.deepEqual(policy.legacyConfigOverrides, {})
})

test('schema bootstrap may expose definitions without granting live tool execution', () => {
  const policy = resolveSessionSurfacePolicy({
    config: config({ tool: false }),
    schemaBootstrapping: true,
  })

  assert.equal(policy.surface.visionTools, false)
  assert.deepEqual(policy.legacyConfigOverrides, { tool: true })
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
