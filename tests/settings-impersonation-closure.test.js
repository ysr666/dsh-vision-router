import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { installLegacyCoreVisionPolicyBridge } from '../lib/legacy-core-vision-policy-bridge.js'

test('legacy pre-step compatibility cannot impersonate Settings, scopes, injected children or config', async () => {
  const source = await readFile(
    new URL('../lib/legacy-core-vision-policy-bridge.js', import.meta.url),
    'utf8',
  )

  for (const forbidden of [
    'projectedConfig',
    'configView',
    'scopeView',
    'settingsView',
    'childContextView',
    'settingsCache',
    'finishSchemaBootstrap',
  ]) {
    assert.equal(source.includes(forbidden), false, `${forbidden} must not return to the legacy bridge`)
  }
  assert.doesNotMatch(source, /property === ['"]get['"]/, 'bridge must not intercept ctx.get/settings')
  assert.doesNotMatch(source, /property === ['"]inject['"]/, 'bridge must not intercept injected Settings children')
  assert.match(source, /property === ['"]on['"]/, 'the retained compatibility seam is pre-step only')
})

test('legacy pre-step compatibility preserves real config and Settings identities', () => {
  const config = Object.freeze({
    tool: false,
    rewriteImages: true,
    structuredVisionBootstrap: true,
  })
  const settings = Object.freeze({ marker: 'settings-service' })
  const child = Object.freeze({ settings })
  const ctx = {
    get(name) {
      return name === 'settings' ? settings : undefined
    },
    inject(_dependencies, callback) {
      return callback(child)
    },
    on() {
      return () => {}
    },
  }

  const bridge = installLegacyCoreVisionPolicyBridge(ctx, config)
  assert.equal(bridge.config, config)
  assert.equal(bridge.ctx.get('settings'), settings)

  let injected
  bridge.ctx.inject(['settings'], (value) => { injected = value })
  assert.equal(injected, child)
  assert.equal(Object.hasOwn(bridge, 'finishSchemaBootstrap'), false)
})
