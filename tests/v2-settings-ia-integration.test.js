import test from 'node:test'
import assert from 'node:assert/strict'

import {
  V2_SETTINGS_IA_STYLE,
  injectV2SettingsIaIntegration,
} from '../lib/v2-settings-ia-integration.js'
import { VISION_ROUTING_SETTINGS_PRELUDE } from '../lib/vision-routing-settings-prelude.js'
import { CAPABILITY_BENCHMARK_CLIENT } from '../lib/vision-capability-benchmark-client.js'
import { REMOTE_SETTINGS_RISK_CLIENT_PRELUDE } from '../lib/remote-settings-risk-confirmation.js'
import {
  REMOTE_SETTINGS_AUTHORIZE_ENDPOINT,
  REMOTE_SETTINGS_PERMISSION,
  createVisionRouterRemoteSettingsHandler,
} from '../lib/remote-settings-bridge.js'

test('v2 routing controls are visually integrated into General instead of becoming another settings card', () => {
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /CHAIN_ROOT = '#vr-vision-backend-chain'/)
  assert.match(VISION_ROUTING_SETTINGS_PRELUDE, /chain\.insertBefore\(panel, chain\.firstChild\)/)
  assert.match(
    V2_SETTINGS_IA_STYLE,
    /\.vr-settings-ia-root #vr-vision-backend-chain > \[data-vr-routing-settings-panel\]\.vr-routing-panel/,
  )
  assert.match(V2_SETTINGS_IA_STYLE, /border:0/)
  assert.match(V2_SETTINGS_IA_STYLE, /background:transparent/)
  assert.doesNotMatch(V2_SETTINGS_IA_STYLE, /display\s*:\s*none[^;]*data-vr-routing-settings-panel/i)
})

test('v2 settings IA integration is scoped and idempotent', () => {
  const html = '<html><head></head><body></body></html>'
  const once = injectV2SettingsIaIntegration(html)
  assert.match(once, /data-vision-router-v2-settings-ia/)
  assert.equal(injectV2SettingsIaIntegration(once), once)
  assert.match(V2_SETTINGS_IA_STYLE, /\.vr-settings-ia-root/)
})

test('Auto introduction, Benchmark modal, and remote-risk confirmation remain product contracts', () => {
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /AUTO_INTRO_ATTR/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /showAutoIntroOnce/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /已开启 Auto/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /后台测评由「后台补充能力数据」单独控制/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /MODAL_ATTR/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /快速测评/)
  assert.match(CAPABILITY_BENCHMARK_CLIENT, /完整测评/)
  assert.match(REMOTE_SETTINGS_RISK_CLIENT_PRELUDE, /window\.confirm/)
  assert.match(REMOTE_SETTINGS_RISK_CLIENT_PRELUDE, /trustedHosts/)
  assert.match(REMOTE_SETTINGS_RISK_CLIENT_PRELUDE, /AUTHORIZE_ENDPOINT/)
})

test('remote confirmation immediately unlocks v2 settings writes with authoritative readback', async () => {
  let revision = 10
  const value = {
    [REMOTE_SETTINGS_PERMISSION]: false,
    routingMode: 'ordered',
    routingPreference: 'balanced',
    backgroundBenchmarking: 'off',
    proxy: '',
    localOllama: { enabled: false },
  }
  const user = {}
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
          proxy: '',
          localOllama: { enabled: false },
        },
        user: structuredClone(user),
        revision,
        applies: 'live',
        secrets: [],
      }]
    },
    async mutate(ns, ops, expectedRevision) {
      assert.equal(ns, 'vision-router')
      assert.equal(expectedRevision, revision)
      const op = ops[0]
      if (op.op === 'set') {
        value[op.path[0]] = structuredClone(op.value)
        user[op.path[0]] = structuredClone(op.value)
      } else {
        delete user[op.path[0]]
      }
      revision += 1
    },
  }

  const handler = createVisionRouterRemoteSettingsHandler(settings)
  const before = await handler('describe', {})
  assert.deepEqual(before.value, { enabled: false, reason: 'permission-disabled', writable: false })

  const authorized = await handler(REMOTE_SETTINGS_AUTHORIZE_ENDPOINT, { acceptedRisk: true })
  assert.equal(authorized.ok, true)
  assert.equal(authorized.value.enabled, true)
  assert.equal(authorized.value.writable, true)
  assert.equal(authorized.value.view.revision, 11)

  let expectedRevision = authorized.value.view.revision
  for (const [field, next] of [
    ['routingMode', 'auto'],
    ['routingPreference', 'quality'],
    ['backgroundBenchmarking', 'local-free'],
  ]) {
    const result = await handler('mutate', {
      ops: [{ op: 'set', path: [field], value: next }],
      expectedRevision,
    })
    assert.equal(result.ok, true, field)
    assert.equal(result.value.enabled, true, field)
    assert.equal(result.value.writable, true, field)
    assert.equal(result.value.view.value[field], next, field)
    assert.equal(result.value.view.user[field], next, field)
    expectedRevision = result.value.view.revision
  }

  assert.equal(value.routingMode, 'auto')
  assert.equal(value.routingPreference, 'quality')
  assert.equal(value.backgroundBenchmarking, 'local-free')
})

test('remote v2 access still refuses local/network-sensitive fields after authorization', async () => {
  let revision = 2
  const value = {
    [REMOTE_SETTINGS_PERMISSION]: true,
    routingMode: 'auto',
    routingPreference: 'balanced',
    backgroundBenchmarking: 'off',
    proxy: '',
    localOllama: { enabled: false },
    desktopScreenshot: false,
  }
  const settings = {
    writable: true,
    describe() {
      return [{
        ns: 'vision-router',
        value: structuredClone(value),
        user: { [REMOTE_SETTINGS_PERMISSION]: true },
        revision,
        applies: 'live',
        secrets: [],
      }]
    },
    async mutate() {
      revision += 1
      assert.fail('sensitive remote mutation must not reach SettingsProvider.mutate')
    },
  }
  const handler = createVisionRouterRemoteSettingsHandler(settings)
  for (const [field, next] of [
    ['proxy', 'http://attacker.invalid'],
    ['localOllama', { enabled: true, baseURL: 'http://10.0.0.9:11434/v1', model: 'x' }],
    ['desktopScreenshot', true],
  ]) {
    const result = await handler('mutate', {
      ops: [{ op: 'set', path: [field], value: next }],
      expectedRevision: revision,
    })
    assert.equal(result.ok, false, field)
    assert.equal(result.error.code, 'bad-request', field)
  }
})
