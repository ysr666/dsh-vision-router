import assert from 'node:assert/strict'
import test from 'node:test'

import {
  legacySettingsMigrationOps,
  migrateLegacyVisionSettings,
} from '../lib/settings-migration.js'
import { normalizeRuntimeVisionConfig } from '../lib/runtime-config-normalizer.js'

function descriptor({ user = {}, value = {}, revision = 9 } = {}) {
  return {
    ns: 'vision-router',
    user,
    value: {
      provider: 'vision-http',
      model: 'ovh/Qwen3.5-397B-A17B',
      fallbacks: [],
      providers: [{ provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] }],
      ...value,
    },
    revision,
  }
}

test('legacy shorthand migrates atomically to providers and retires stale keys', () => {
  const ops = legacySettingsMigrationOps(descriptor({
    user: {
      provider: 'openrouter',
      model: 'qwen-vl',
      fallbacks: ['qwen-vl-backup'],
      visionGuideStep: 'chain',
      instantDescribe: true,
      localDescribeStyle: 'plain',
    },
  }))

  assert.deepEqual(ops[0], {
    op: 'set',
    path: ['providers'],
    value: [{ provider: 'openrouter', model: 'qwen-vl', fallbacks: ['qwen-vl-backup'] }],
  })
  assert.deepEqual(
    ops.slice(1).map((op) => op.path[0]),
    ['provider', 'model', 'fallbacks', 'visionGuideStep', 'instantDescribe', 'localDescribeStyle'],
  )
  assert.equal(ops.slice(1).every((op) => op.op === 'unset'), true)
})

test('an explicit providers chain is never overwritten while shorthand is cleaned', () => {
  const providers = [{ provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: [] }]
  const ops = legacySettingsMigrationOps(descriptor({
    user: {
      providers,
      provider: 'old-provider',
      model: 'old-model',
      fallbacks: ['old-fallback'],
    },
  }))

  assert.equal(ops.some((op) => op.op === 'set' && op.path[0] === 'providers'), false)
  assert.deepEqual(ops.map((op) => op.path[0]), ['provider', 'model', 'fallbacks'])
})

test('retired fields are cleaned even when no legacy shorthand exists', () => {
  const ops = legacySettingsMigrationOps(descriptor({
    user: {
      providers: [{ provider: 'openrouter', model: 'qwen-vl', fallbacks: [] }],
      instantDescribe: false,
      localDescribeStyle: 'structured',
      visionGuideStep: '',
    },
  }))
  assert.deepEqual(
    ops.map((op) => [op.op, op.path[0]]),
    [
      ['unset', 'visionGuideStep'],
      ['unset', 'instantDescribe'],
      ['unset', 'localDescribeStyle'],
    ],
  )
})

test('migration uses one revision-checked mutate and preserves a pre-existing providers chain', async () => {
  const providers = [{ provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: [] }]
  const calls = []
  const settings = {
    writable: true,
    describe() {
      return [descriptor({
        user: { providers, provider: 'legacy', instantDescribe: true },
        value: { providers },
        revision: 12,
      })]
    },
    async mutate(ns, ops, revision) {
      calls.push({ ns, ops, revision })
    },
  }

  const result = await migrateLegacyVisionSettings(settings)
  assert.equal(result.migrated, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].ns, 'vision-router')
  assert.equal(calls[0].revision, 12)
  assert.equal(calls[0].ops.some((op) => op.op === 'set' && op.path[0] === 'providers'), false)
  assert.deepEqual(calls[0].ops.map((op) => op.path[0]), ['provider', 'instantDescribe'])
})

test('read-only settings never attempt migration', async () => {
  let mutated = false
  const result = await migrateLegacyVisionSettings({
    writable: false,
    describe() { throw new Error('should not describe') },
    async mutate() { mutated = true },
  })
  assert.deepEqual(result, { migrated: false, reason: 'read-only' })
  assert.equal(mutated, false)
})

test('retired compatibility values cannot reach normalized runtime config', () => {
  const normalized = normalizeRuntimeVisionConfig({
    providers: [{ provider: 'openrouter', model: 'qwen-vl', fallbacks: [] }],
    instantDescribe: true,
    localDescribeStyle: 'plain',
    visionGuideStep: 'chain',
    tool: true,
  })
  assert.equal(Object.hasOwn(normalized, 'instantDescribe'), false)
  assert.equal(Object.hasOwn(normalized, 'localDescribeStyle'), false)
  assert.equal(Object.hasOwn(normalized, 'visionGuideStep'), false)
  assert.equal(normalized.tool, true)
})
