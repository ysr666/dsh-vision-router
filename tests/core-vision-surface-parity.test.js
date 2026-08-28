import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { resolveSessionSurfacePolicy } from '../lib/session-surface-policy.js'
import {
  CORE_VISION_SURFACE_KEYS,
  createCoreVisionSurfaceRuntime,
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
        assert.equal(explicit.toolAvailable, legacy.values.tool !== false)
        assert.equal(explicit.rewriteEnabled, legacy.values.rewriteImages !== false)
        assert.equal(explicit.instantDescribe, legacy.values.instantDescribe === true)
        assert.equal(explicit.autoActivateOnImage, legacy.values.autoActivateOnImage !== false)
        assert.equal(explicit.structuredBootstrap, legacy.values.structuredVisionBootstrap === true)
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

test('CoreVisionSurface runtime keeps schema bootstrap explicit and reads live config', () => {
  const live = {
    tool: false,
    rewriteImages: true,
    instantDescribe: false,
    autoActivateOnImage: true,
    structuredVisionBootstrap: false,
  }
  const runtime = createCoreVisionSurfaceRuntime({ config: () => live })

  assert.equal(runtime.current().toolAvailable, true)
  assert.equal(runtime.current().rewriteEnabled, true)

  runtime.finishSchemaBootstrap()
  assert.equal(runtime.current().toolAvailable, false)

  live.tool = true
  live.instantDescribe = true
  live.autoActivateOnImage = false
  live.structuredVisionBootstrap = true
  const current = runtime.current()
  assert.equal(current.toolAvailable, true)
  assert.equal(current.instantDescribe, true)
  assert.equal(current.autoActivateOnImage, false)
  assert.equal(current.structuredBootstrap, true)
})

test('production composition passes one explicit CoreVisionSurface runtime into Core', async () => {
  const composition = await readFile(new URL('../lib/runtime-composition.js', import.meta.url), 'utf8')
  const core = await readFile(new URL('../index.js', import.meta.url), 'utf8')

  assert.match(composition, /import \{ createCoreVisionSurfaceRuntime \} from '.\/core-vision-surface\.js'/)
  assert.match(composition, /const coreVisionSurfaceRuntime = createCoreVisionSurfaceRuntime\(/)
  assert.match(composition, /coreVisionSurface: coreVisionSurfaceRuntime/)
  assert.match(composition, /coreVisionSurfaceRuntime\.finishSchemaBootstrap\(\)/)

  assert.match(core, /const coreVisionSurfaceRuntime = runtime\?\.coreVisionSurface/)
  assert.match(core, /coreVisionFlag\(\s*'toolAvailable'/)
  assert.match(core, /coreVisionFlag\(\s*'rewriteEnabled'/)
  assert.match(core, /coreVisionFlag\(\s*'instantDescribe'/)
  assert.match(core, /coreVisionFlag\(\s*'autoActivateOnImage'/)
  assert.match(core, /coreVisionFlag\(\s*'structuredBootstrap'/)

  assert.doesNotMatch(core, /const toolEnabled = \(\) => current\(\)\.tool !== false/)
  assert.doesNotMatch(core, /const rewriteEnabled = \(\) => current\(\)\.rewriteImages !== false/)
  assert.doesNotMatch(core, /const structuredBootstrapEnabled = \(\) => current\(\)\.structuredVisionBootstrap === true/)
})
