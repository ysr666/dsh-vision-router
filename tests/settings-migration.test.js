import assert from 'node:assert/strict'
import test from 'node:test'

import {
  flattenProviderFallbackRows,
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

test('legacy shorthand migrates atomically to one visible row per runtime backend', () => {
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
    value: [
      { provider: 'openrouter', model: 'qwen-vl', fallbacks: [] },
      { provider: 'openrouter', model: 'qwen-vl-backup', fallbacks: [] },
    ],
  })
  assert.deepEqual(
    ops.slice(1).map((op) => op.path[0]),
    ['provider', 'model', 'fallbacks', 'visionGuideStep', 'instantDescribe', 'localDescribeStyle'],
  )
  assert.equal(ops.slice(1).every((op) => op.op === 'unset'), true)
})

test('explicit nested provider fallbacks are flattened without changing execution order', () => {
  const providers = [
    { provider: 'openrouter', model: 'primary', fallbacks: ['backup-1', 'backup-2'] },
    { provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: [] },
  ]
  assert.deepEqual(flattenProviderFallbackRows(providers), [
    { provider: 'openrouter', model: 'primary', fallbacks: [] },
    { provider: 'openrouter', model: 'backup-1', fallbacks: [] },
    { provider: 'openrouter', model: 'backup-2', fallbacks: [] },
    { provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: [] },
  ])

  const ops = legacySettingsMigrationOps(descriptor({ user: { providers } }))
  assert.deepEqual(ops, [{
    op: 'set',
    path: ['providers'],
    value: [
      { provider: 'openrouter', model: 'primary', fallbacks: [] },
      { provider: 'openrouter', model: 'backup-1', fallbacks: [] },
      { provider: 'openrouter', model: 'backup-2', fallbacks: [] },
      { provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: [] },
    ],
  }])
})

test('an explicit already-flat providers chain is never overwritten while shorthand is cleaned', () => {
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

test('migration uses one revision-checked mutate and preserves an already-flat providers chain', async () => {
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

test('a settings revision conflict is re-described once so legacy custom models are not shadowed by defaults', async () => {
  let describeCount = 0
  const calls = []
  const settings = {
    writable: true,
    describe() {
      describeCount++
      return [descriptor({
        user: { provider: 'openrouter', model: 'qwen-vl' },
        revision: describeCount === 1 ? 20 : 21,
      })]
    },
    async mutate(ns, ops, revision) {
      calls.push({ ns, ops, revision })
      if (calls.length === 1) {
        const error = new Error('revision changed')
        error.code = 'SETTINGS_CONFLICT'
        throw error
      }
    },
  }

  const result = await migrateLegacyVisionSettings(settings)
  assert.equal(result.migrated, true)
  assert.equal(describeCount, 2)
  assert.deepEqual(calls.map((call) => call.revision), [20, 21])
  assert.deepEqual(calls[1].ops[0].value, [
    { provider: 'openrouter', model: 'qwen-vl', fallbacks: [] },
  ])
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