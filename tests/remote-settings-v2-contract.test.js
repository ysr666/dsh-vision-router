import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REMOTE_SETTINGS_PERMISSION,
  REMOTE_SETTINGS_READABLE_FIELDS,
  createVisionRouterRemoteSettingsHandler,
} from '../lib/remote-settings-bridge.js'

test('remote settings preserve v2 routing authority fields after settings IA merge', async () => {
  for (const field of ['routingMode', 'routingPreference', 'backgroundBenchmarking']) {
    assert.equal(REMOTE_SETTINGS_READABLE_FIELDS.includes(field), true, field)
  }

  const value = {
    [REMOTE_SETTINGS_PERMISSION]: true,
    routingMode: 'ordered',
    routingPreference: 'balanced',
    backgroundBenchmarking: 'off',
  }
  const user = { [REMOTE_SETTINGS_PERMISSION]: true }
  const settings = {
    writable: true,
    describe() {
      return [{
        ns: 'vision-router',
        value: structuredClone(value),
        base: {
          [REMOTE_SETTINGS_PERMISSION]: false,
          routingMode: 'ordered',
          routingPreference: 'balanced',
          backgroundBenchmarking: 'off',
        },
        user: structuredClone(user),
        revision: 3,
        applies: 'live',
        secrets: [],
      }]
    },
    async mutate(ns, ops, revision) {
      assert.equal(ns, 'vision-router')
      assert.equal(revision, 3)
      const op = ops[0]
      assert.equal(op.op, 'set')
      value[op.path[0]] = structuredClone(op.value)
      user[op.path[0]] = structuredClone(op.value)
    },
  }

  const handler = createVisionRouterRemoteSettingsHandler(settings)
  for (const [field, next] of [
    ['routingMode', 'auto'],
    ['routingPreference', 'local'],
    ['backgroundBenchmarking', 'all'],
  ]) {
    const result = await handler('mutate', {
      ops: [{ op: 'set', path: [field], value: next }],
      expectedRevision: 3,
    })
    assert.equal(result.ok, true, field)
    assert.equal(result.value.view.value[field], next, field)
  }
})
