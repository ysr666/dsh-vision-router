import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveSessionSurfacePolicy } from '../lib/session-surface-policy.js'
import {
  CORE_VISION_SURFACE_KEYS,
  resolveCoreVisionSurface,
} from '../lib/core-vision-surface.js'

const OWNERSHIPS = [
  'native-image',
  'vision-router-owned',
  'text-only',
  'unknown',
]

function policyFor(ownership) {
  return {
    ownership,
    preserveRawImages:
      ownership === 'native-image' ||
      ownership === 'vision-router-owned' ||
      ownership === 'unknown',
    rewriteCurrentImages: ownership === 'text-only',
    suppressGenericAutoMount: ownership === 'native-image',
    allowStructuredBootstrap: ownership !== 'native-image',
  }
}

function legacyProjectedValues(config, visionPolicy, schemaBootstrapping) {
  const policy = resolveSessionSurfacePolicy({
    visionPolicy,
    config,
    schemaBootstrapping,
  })
  const projected = { ...config, ...policy.legacyConfigOverrides }
  return {
    policy,
    values: Object.fromEntries(
      CORE_VISION_SURFACE_KEYS.map((key) => [key, projected[key]]),
    ),
  }
}

function boolConfigs() {
  const keys = [
    'tool',
    'rewriteImages',
    'instantDescribe',
    'autoActivateOnImage',
    'structuredVisionBootstrap',
  ]
  const rows = []
  for (let mask = 0; mask < (1 << keys.length); mask++) {
    rows.push(Object.fromEntries(
      keys.map((key, index) => [key, Boolean(mask & (1 << index))]),
    ))
  }
  return rows
}

test('explicit core surface is exactly equivalent to every legacy projection combination', () => {
  let cases = 0
  for (const ownership of OWNERSHIPS) {
    const visionPolicy = policyFor(ownership)
    for (const config of boolConfigs()) {
      for (const schemaBootstrapping of [false, true]) {
        const legacy = legacyProjectedValues(config, visionPolicy, schemaBootstrapping)
        const explicit = resolveCoreVisionSurface({
          visionPolicy,
          config,
          schemaBootstrapping,
        })

        assert.deepEqual(
          explicit.values,
          legacy.values,
          `core surface drift for ${ownership} bootstrap=${schemaBootstrapping} config=${JSON.stringify(config)}`,
        )
        assert.equal(explicit.ownership, legacy.policy.ownership)
        assert.equal(explicit.preserveRawImages, legacy.policy.preserveRawImages)
        assert.equal(explicit.rewriteCurrentImages, legacy.policy.rewriteCurrentImages)
        cases += 1
      }
    }
  }
  assert.equal(cases, 256)
})

test('absence of session ownership does not invent UNKNOWN or rewrite authority', () => {
  const config = {
    tool: true,
    rewriteImages: true,
    instantDescribe: true,
    autoActivateOnImage: true,
    structuredVisionBootstrap: true,
  }
  const legacy = legacyProjectedValues(config, undefined, false)
  const explicit = resolveCoreVisionSurface({ config })

  assert.equal(explicit.ownership, undefined)
  assert.equal(explicit.preserveRawImages, false)
  assert.equal(explicit.rewriteCurrentImages, false)
  assert.deepEqual(explicit.values, legacy.values)
})

test('explicit surface cannot expose unrelated plugin configuration as a fake Settings object', () => {
  const config = {
    tool: true,
    rewriteImages: true,
    instantDescribe: true,
    autoActivateOnImage: true,
    structuredVisionBootstrap: true,
    proxy: 'http://secret-proxy.example',
    providers: [{ provider: 'paid-provider', model: 'secret-model' }],
    allowRemoteSettings: true,
  }
  const explicit = resolveCoreVisionSurface({
    visionPolicy: policyFor('native-image'),
    config,
  })

  assert.deepEqual(Object.keys(explicit.values), [...CORE_VISION_SURFACE_KEYS])
  assert.equal(Object.hasOwn(explicit.values, 'proxy'), false)
  assert.equal(Object.hasOwn(explicit.values, 'providers'), false)
  assert.equal(Object.hasOwn(explicit.values, 'allowRemoteSettings'), false)
  assert.equal(Object.isFrozen(explicit), true)
  assert.equal(Object.isFrozen(explicit.values), true)
})
