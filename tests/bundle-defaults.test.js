import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Config, SETTINGS_CONTRACT_REVISION } from '../entry.js'
import {
  GUIDE_VISION_TOGGLE_HIGHLIGHT_PRELUDE,
  injectGuideVisionToggleHighlight,
  unionGuideRects,
} from '../lib/guide-vision-toggle-highlight.js'

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

test('public plugin config leaves the whole-turn vision budget unlimited by default', () => {
  assert.equal(Config({}).visionTurnBudgetMs, 0)
  assert.equal(Config({ visionTurnBudgetMs: 180000 }).visionTurnBudgetMs, 180000)
})

test('walkthrough step 1 combines the Vision toggle and model selector into one spotlight', () => {
  assert.deepEqual(
    unionGuideRects(
      { x: 100, y: 440, left: 100, top: 440, right: 220, bottom: 500, width: 120, height: 60 },
      { x: 236, y: 430, left: 236, top: 430, right: 760, bottom: 510, width: 524, height: 80 },
    ),
    { x: 100, y: 430, left: 100, top: 430, right: 760, bottom: 510, width: 660, height: 80 },
  )
  assert.match(GUIDE_VISION_TOGGLE_HIGHLIGHT_PRELUDE, /data-vr-step="step1"/)
  assert.match(GUIDE_VISION_TOGGLE_HIGHLIGHT_PRELUDE, /data-vision-router-mode-toggle/)
  assert.match(GUIDE_VISION_TOGGLE_HIGHLIGHT_PRELUDE, /vr-guide-spot-hole/)
  assert.match(GUIDE_VISION_TOGGLE_HIGHLIGHT_PRELUDE, /vr-guide-spot-ring/)

  const html = '<html><head></head><body></body></html>'
  const once = injectGuideVisionToggleHighlight(html)
  assert.equal(injectGuideVisionToggleHighlight(once), once)
  assert.equal((once.match(/data-vision-router-guide-toggle-highlight/g) ?? []).length, 1)
})

test('entry contract always exposes the local remote-settings permission and handshake', () => {
  assert.equal(SETTINGS_CONTRACT_REVISION, 4)
  assert.equal(Config({}).allowRemoteSettings, false)
  assert.equal(Config({ allowRemoteSettings: true }).allowRemoteSettings, true)
  assert.equal(Config({}).settingsContractRevision, 4)
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
