import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Config, SETTINGS_CONTRACT_REVISION } from '../entry.js'

const bundlePatch = new URL('../cordis.patch.yml', import.meta.url)

test('installed bundle keeps the full vision tool schema stable by default', async () => {
  const text = await readFile(bundlePatch, 'utf8')
  assert.match(
    text,
    /- id: vision-router[\s\S]*?name: dsh-vision-router[\s\S]*?config:\s*\n\s+progressiveTools: false/,
  )
})

test('bundle declares the rc8 large-image admission policy for clean profiles', async () => {
  const text = await readFile(bundlePatch, 'utf8')
  assert.match(
    text,
    /- id: attachment-local[\s\S]*?maxImageBytes: 20971520[\s\S]*?maxImagePixels: 100000000[\s\S]*?maxImageDimension: 10000/,
  )
})

test('public plugin config defaults progressive tools off', () => {
  assert.equal(Config({}).progressiveTools, false)
})

test('progressive tools remain an explicit opt-in', () => {
  assert.equal(Config({ progressiveTools: true }).progressiveTools, true)
})

test('entry contract exposes routing product semantics without enabling auto execution by default', () => {
  assert.equal(SETTINGS_CONTRACT_REVISION, 6)
  const defaults = Config({})
  assert.equal(defaults.routingMode, 'ordered')
  assert.equal(defaults.routingPreference, 'balanced')
  assert.equal(defaults.backgroundBenchmarking, 'local-free')
  assert.equal(Config({ routingMode: 'auto', routingPreference: 'local' }).routingMode, 'auto')
  assert.equal(Config({ routingMode: 'auto', routingPreference: 'local' }).routingPreference, 'local')
  assert.equal(Config({ backgroundBenchmarking: 'all' }).backgroundBenchmarking, 'all')
  assert.equal(Config({ backgroundBenchmarking: 'off' }).backgroundBenchmarking, 'off')
})

test('entry contract always exposes the local remote-settings permission and handshake', () => {
  assert.equal(SETTINGS_CONTRACT_REVISION, 6)
  assert.equal(Config({}).allowRemoteSettings, false)
  assert.equal(Config({ allowRemoteSettings: true }).allowRemoteSettings, true)
  assert.equal(Config({}).settingsContractRevision, 6)
})

test('entry contract exposes the custom depth tier to every settings entry point', () => {
  const defaults = Config({})
  assert.equal(defaults.visionDepth, 'standard')
  assert.equal(defaults.visionDepthMaxCalls, 0)

  const custom = Config({ visionDepth: 'custom', visionDepthMaxCalls: 7 })
  assert.equal(custom.visionDepth, 'custom')
  assert.equal(custom.visionDepthMaxCalls, 7)
})

test('release line stays on package identity 1.7.7', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.version, '1.7.7')
})
